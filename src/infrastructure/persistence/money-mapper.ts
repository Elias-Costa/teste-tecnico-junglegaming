import { Money } from "../../domain/money.ts";

/**
 * As duas colunas que representam um valor monetário no schema (D-004).
 *
 * `amount` é `numeric(19,2)` e `currency` é `varchar(3)`. O par aparece quatro
 * vezes no schema — saldo da wallet, valor da transação, e o trio valor/saldo
 * anterior/saldo posterior do ledger —, e é o mesmo par em todas.
 */
export interface MoneyColumns {
  /** Decimal em string com escala 2, ex.: `"25.00"`. **Nunca** `number` (EL-01). */
  amount: string;
  /** Código ISO-4217 em três letras maiúsculas. */
  currency: string;
}

/**
 * Converte `Money` para as duas colunas (D-004).
 *
 * Existe como função nomeada em vez de `money.toJSON()` no call site porque as
 * duas coisas coincidem hoje e não precisam coincidir sempre: `toJSON()` é o
 * contrato de serialização do domínio (RF-01), lido também pelo payload dos
 * eventos, e o mapeamento de coluna é contrato com o banco. Um único ponto de
 * conversão é o que D-004 pede, e é o que torna a simetria centavos↔decimal
 * testável num lugar só.
 */
export function moneyToColumns(money: Money): MoneyColumns {
  return money.toJSON();
}

/**
 * Reconstrói `Money` a partir do que o driver devolveu.
 *
 * @throws InvalidMoneyError se o texto não estiver na forma canônica de D-015/D-016.
 * @throws TypeError se o driver não devolver string — ver `assertDriverString`.
 */
export function moneyFromColumns(amount: unknown, currency: unknown): Money {
  assertDriverString(amount, "amount");
  assertDriverString(currency, "currency");

  return Money.from({ amount, currency });
}

/**
 * Guarda de EL-01 na camada do driver (D-004).
 *
 * Os parâmetros de `moneyFromColumns` são `unknown` de propósito: esta checagem
 * é contra o **driver**, não contra o compilador. O `node-postgres` devolve
 * `numeric` como string por padrão, mas um type parser registrado por engano —
 * uma linha em qualquer lugar do processo — passaria a devolver `number`, e o
 * valor entraria no domínio já arredondado, sem exceção e sem teste vermelho.
 * É a forma mais difícil de enxergar de introduzir EL-01, e a única defesa é
 * falhar alto no ponto exato onde os dois mundos se encontram.
 *
 * `TypeError` e não erro de domínio: isto não é dado inválido do provedor, é o
 * ambiente contrariando uma premissa do sistema.
 */
function assertDriverString(value: unknown, column: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(
      `coluna ${column} veio do driver como ${typeof value}, esperado string. ` +
        `Um type parser de \`numeric\` foi registrado e converteria dinheiro para ponto flutuante (EL-01, D-004).`,
    );
  }
}
