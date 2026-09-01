import { CurrencyMismatchError } from "./errors/currency-mismatch-error.ts";
import { InvalidMoneyError } from "./errors/invalid-money-error.ts";

/**
 * Fator de escala do domínio — dinheiro é guardado em centavos (D-003).
 *
 * A escala 2 é premissa do enunciado (§6.1: `amount` "sempre com escala fixa de
 * 2 casas"), global para todas as moedas. Moedas de escala 0 (JPY) ou 3 (KWD)
 * exigiriam uma tabela por moeda — limitação conhecida registrada em D-003.
 * Constante única de propósito: escala espalhada por literais é como divergência
 * de arredondamento entra sem ninguém ver.
 */
const SCALE_FACTOR = 100n;

/**
 * Único formato de valor aceito na entrada do domínio (D-015, D-004).
 *
 * Exatamente 2 decimais, sem sinal, sem zero à esquerda e no máximo 17 dígitos
 * inteiros — o que a coluna `numeric(19,2)` de D-004 comporta. A regex é a porta
 * de entrada porque `BigInt("25.00")` **lança** em vez de arredondar: sem ela
 * não existe caminho preguiçoso que aceite entrada inválida por acidente.
 *
 * A forma canônica única também sustenta D-005: `"25"` e `"25.00"` aceitos sob a
 * mesma idempotency key produziriam `payloadHash` divergente, e um reenvio
 * legítimo viraria `IDEMPOTENCY_CONFLICT` falso.
 */
const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,16})\.\d{2}$/;

/**
 * Único formato de moeda aceito na entrada do domínio (D-016).
 *
 * Validação de **forma**, não de existência na ISO-4217 — a tabela completa tem
 * manutenção própria e ganho marginal, já que o enunciado autoriza assumir `BRL`
 * mantendo o modelo multi-moeda. O que importa aqui é o mesmo de D-015: uma
 * representação textual por moeda, para que "brl" e "BRL" não convivam.
 */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** DTO de `Money` — a forma em que o valor entra e sai do domínio (RF-01, §6.1). */
export interface MoneyProps {
  /** Decimal em string com escala fixa de 2, ex.: "25.00". */
  amount: string;
  /** Código ISO-4217 em três letras maiúsculas, ex.: "BRL". */
  currency: string;
}

/**
 * Valor monetário exato e imutável (RF-01, RI-01, EL-01).
 *
 * Representado internamente como `bigint` de centavos (D-003): o domínio só soma
 * e subtrai, nunca multiplica nem divide, então não há política de arredondamento
 * a decidir — inteiro é exato por construção e elimina a classe inteira de erro
 * de configuração de precisão que uma biblioteca decimal traria junto.
 *
 * O `bigint` **não sai daqui**: `cents` é privado e a serialização devolve
 * `MoneyProps` com string. Toda operação retorna nova instância.
 */
export class Money {
  /**
   * Recebe centavos já validados, e por isso é privado.
   *
   * `from` é a única porta do contrato externo; os demais caminhos que chegam
   * aqui (aritmética e `negate`) partem de valores exatos por construção.
   */
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Constrói a partir do DTO, validando valor e moeda.
   *
   * @throws InvalidMoneyError se o valor não estiver na forma canônica de D-015
   * ou a moeda não estiver na forma de D-016.
   */
  static from(props: MoneyProps): Money {
    const currency = assertCurrency(props.currency);

    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        `valor monetário inválido: ${JSON.stringify(props.amount)}. ` +
          `Esperado decimal em string com exatamente 2 casas, sem sinal e sem zero à esquerda (D-015).`,
      );
    }

    // Remover o ponto de "25.00" produz "2500", que já é a representação em
    // centavos. Só é seguro depois da regex, que garante os 2 decimais exatos.
    return new Money(BigInt(props.amount.replace(".", "")), currency);
  }

  /**
   * Valor zero na moeda informada.
   *
   * @throws InvalidMoneyError se a moeda não estiver na forma de D-016.
   */
  static zero(currency: string): Money {
    return new Money(0n, assertCurrency(currency));
  }

  /** Soma, mantendo a moeda. @throws CurrencyMismatchError entre moedas diferentes. */
  add(other: Money): Money {
    this.assertSameCurrency(other);

    // Resultado de aritmética não volta por `from()`. Aquela validação guarda o
    // **contrato de entrada** — onde RF-01 rejeita negativo —, enquanto soma e
    // subtração sobre bigint já são exatas e podem legitimamente dar negativo.
    return new Money(this.cents + other.cents, this.currency);
  }

  /** Subtração, mantendo a moeda. @throws CurrencyMismatchError entre moedas diferentes. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  /**
   * Inverte o sinal.
   *
   * Não passa por `from()` de propósito: RF-01 rejeita negativo no contrato de
   * entrada, mas o lançamento invertido do `ROLLBACK` (RN-05) precisa de `Money`
   * negativo. Mesma lógica de um `rehydrate` — reconstrói, não revalida (D-003).
   */
  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  /** Verdadeiro se o valor é exatamente zero. */
  isZero(): boolean {
    return this.cents === 0n;
  }

  /** Verdadeiro se o valor é maior que zero. */
  isPositive(): boolean {
    return this.cents > 0n;
  }

  /** Verdadeiro se o valor é menor que zero. */
  isNegative(): boolean {
    return this.cents < 0n;
  }

  /**
   * Ordem entre valores da mesma moeda.
   *
   * É o teste de saldo insuficiente, então uma resposta silenciosa e errada aqui
   * é vizinha de EL-02 — daí lançar, em vez de comparar moedas incomparáveis.
   *
   * @throws CurrencyMismatchError entre moedas diferentes.
   */
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  /**
   * Igualdade de valor dentro da mesma moeda.
   *
   * D-017: também lança em moeda diferente, como as demais operações binárias.
   * Comparar BRL com USD é erro de programação, não resposta — devolver `false`
   * transformaria um bug cross-currency em `AMOUNT_MISMATCH` plausível (RN-10).
   *
   * @throws CurrencyMismatchError entre moedas diferentes.
   */
  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    // `===` compara valor porque `cents` é bigint primitivo. Com um objeto
    // decimal isto seria comparação de referência — bug silencioso plausível,
    // e uma das razões de D-003 ter escolhido bigint.
    return this.cents === other.cents;
  }

  /** Serializa para o DTO (RF-01): decimal em string, nunca o `bigint` interno. */
  toJSON(): MoneyProps {
    return { amount: this.format(), currency: this.currency };
  }

  /** Forma legível para log e mensagem de erro, ex.: "25.00 BRL". */
  toString(): string {
    return `${this.format()} ${this.currency}`;
  }

  /**
   * Formata os centavos como decimal em string de escala 2.
   *
   * Divisão e resto sobre `bigint`, com o sinal tratado por comparação. Um
   * `Number(...)` ou `Math.abs(...)` aqui converteria para ponto flutuante em
   * silêncio, sem lançar e sem quebrar teste de negócio — que é exatamente a
   * forma mais difícil de enxergar de introduzir EL-01.
   */
  private format(): string {
    const isNegative = this.cents < 0n;
    const absolute = isNegative ? -this.cents : this.cents;
    const units = absolute / SCALE_FACTOR;
    const fraction = absolute % SCALE_FACTOR;

    return `${isNegative ? "-" : ""}${units.toString()}.${fraction.toString().padStart(2, "0")}`;
  }

  /** Guarda de moeda comum a `add`, `subtract`, `isLessThan` e `equals` (D-017). */
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/**
 * Valida a moeda e devolve o valor validado (D-016).
 *
 * Devolver em vez de apenas checar mantém `from` e `zero` com um caminho só, sem
 * repetir a chamada de guarda antes de construir.
 *
 * @throws InvalidMoneyError se a moeda não casar `[A-Z]{3}`.
 */
function assertCurrency(currency: string): string {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(
      `moeda inválida: ${JSON.stringify(currency)}. ` +
        `Esperado código ISO-4217 com três letras maiúsculas (D-016).`,
    );
  }

  return currency;
}
