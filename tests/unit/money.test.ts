import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError } from "../../src/domain/errors/currency-mismatch-error.ts";
import { InvalidMoneyError } from "../../src/domain/errors/invalid-money-error.ts";
import { Money } from "../../src/domain/money.ts";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

/** Maior valor inteiro que `numeric(19,2)` comporta: 17 dígitos (D-004, D-015). */
const DEZESSETE_DIGITOS = `${"9".repeat(17)}.00`;
const DEZOITO_DIGITOS = `${"9".repeat(18)}.00`;

describe("Money.from — valores rejeitados (RT-01)", () => {
  // Cada string desta lista é uma forma conhecida de dinheiro entrar errado no
  // sistema. O que se protege aqui não é a regex: é a premissa de que `from()` é
  // a única porta de entrada, de modo que nada além da forma canônica de D-015
  // consiga virar um `Money`.
  const rejeitados = [
    "NaN",
    "Infinity",
    "-Infinity",
    "2.5e1", // notação científica
    "", // string vazia
    " ",
    "1.005", // mais de 2 casas
    "-5.00", // negativo no contrato de entrada (RF-01)
    "25", // menos de 2 casas (D-015)
    "25.5",
    "025.00", // zero à esquerda quebra a canonicidade (D-015)
    ".50",
    "1.",
    "+1.00",
    "1,00", // separador decimal de pt-BR
    "0x19",
    " 1.00",
    "1.00 ",
    DEZOITO_DIGITOS, // excede o que `numeric(19,2)` comporta (D-004)
  ];

  for (const amount of rejeitados) {
    it(`rejeita ${JSON.stringify(amount)}`, () => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });
  }
});

describe("Money — moeda rejeitada (RT-01, D-016)", () => {
  // A validação vale nas duas factories: `zero()` é a porta pela qual uma moeda
  // inválida entraria sem passar por nenhum valor.
  const rejeitadas = ["brl", "Brl", "BR", "BRLX", "", " BRL", "BR1", "R$"];

  for (const currency of rejeitadas) {
    it(`rejeita moeda ${JSON.stringify(currency)} em from() e em zero()`, () => {
      expect(() => Money.from({ amount: "25.00", currency })).toThrow(InvalidMoneyError);
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    });
  }

  it("aceita código ISO-4217 bem formado", () => {
    expect(Money.zero("BRL").currency).toBe("BRL");
    expect(usd("25.00").currency).toBe("USD");
  });
});

describe("Money.from — valores aceitos e escala preservada (RT-01)", () => {
  it("preserva a escala 2 no round-trip", () => {
    const props = { amount: "25.00", currency: "BRL" };
    expect(Money.from(props).toJSON()).toEqual(props);
  });

  it("preserva centavos sem parte inteira", () => {
    expect(brl("0.05").toJSON().amount).toBe("0.05");
  });

  it("aceita 17 dígitos inteiros, o teto de numeric(19,2)", () => {
    expect(brl(DEZESSETE_DIGITOS).toJSON().amount).toBe(DEZESSETE_DIGITOS);
  });

  it("zero(currency) nasce em 0.00", () => {
    expect(Money.zero("BRL").toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
  });
});

describe("Money — aritmética exata (RT-01, EL-01)", () => {
  it("soma 0.10 + 0.20 e devolve exatamente 0.30", () => {
    // O caso canônico de ponto flutuante: `0.1 + 0.2` dá 0.30000000000000004 em
    // `number`. Sobre bigint de centavos o resultado é exato por construção (D-003).
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
  });

  it("subtrai cruzando o zero e produz negativo formatado", () => {
    expect(brl("10.00").subtract(brl("25.50")).toJSON().amount).toBe("-15.50");
  });

  it("soma valores grandes sem perder precisão", () => {
    // Além de 2^53 centavos, `number` já não representa todo inteiro — aqui
    // não há perda porque nunca se sai do bigint.
    expect(brl("99999999999999.99").add(brl("0.01")).toJSON().amount).toBe("100000000000000.00");
  });

  it("é imutável: a operação devolve nova instância e não altera a original", () => {
    const original = brl("25.00");
    const somado = original.add(brl("5.00"));

    expect(original.toJSON().amount).toBe("25.00");
    expect(somado.toJSON().amount).toBe("30.00");
    expect(somado).not.toBe(original);
  });
});

describe("Money.negate (RT-01, RN-05)", () => {
  it("produz negativo válido, que `from()` recusaria", () => {
    const negativo = brl("5.00").negate();

    // `negate()` não passa por `from()` de propósito: o lançamento invertido do
    // ROLLBACK precisa de Money negativo, que o contrato de entrada rejeita.
    expect(negativo.isNegative()).toBe(true);
    expect(negativo.toJSON().amount).toBe("-5.00");
    expect(() => brl("-5.00")).toThrow(InvalidMoneyError);
  });

  it("é involutiva", () => {
    const original = brl("12.34");
    expect(original.negate().negate().equals(original)).toBe(true);
  });

  it("não produz zero negativo", () => {
    const zero = Money.zero("BRL").negate();

    expect(zero.isNegative()).toBe(false);
    expect(zero.toJSON().amount).toBe("0.00");
  });

  it("formata negativo com centavos, sem perder o zero à esquerda da fração", () => {
    expect(brl("0.05").negate().toJSON().amount).toBe("-0.05");
  });
});

describe("Money — serialização (RT-01, D-003)", () => {
  it("JSON.stringify não lança e não vaza o bigint interno", () => {
    // `JSON.stringify` lança em bigint. Este teste trava o contrato de propósito:
    // se `cents` algum dia escapar em `toJSON()`, a falha aparece aqui e não em
    // produção, na primeira publicação de evento (RF-25).
    expect(JSON.stringify(brl("25.00"))).toBe('{"amount":"25.00","currency":"BRL"}');
  });

  it("toString identifica a moeda junto do valor", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
  });
});

describe("Money — consultas (RT-01)", () => {
  it("classifica o sinal", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").negate().isNegative()).toBe(true);
    expect(brl("0.01").isZero()).toBe(false);
  });

  it("ordena valores da mesma moeda", () => {
    expect(brl("10.00").isLessThan(brl("10.01"))).toBe(true);
    expect(brl("10.00").isLessThan(brl("10.00"))).toBe(false);
    expect(brl("10.01").isLessThan(brl("10.00"))).toBe(false);
  });

  it("compara por valor, não por referência", () => {
    expect(brl("25.00").equals(brl("25.00"))).toBe(true);
    expect(brl("25.00").equals(brl("25.01"))).toBe(false);
  });
});

describe("Money — conflito de moeda (RT-04, D-017)", () => {
  // D-017: as quatro operações binárias lançam. `equals` incluída — devolver
  // `false` transformaria um bug cross-currency em AMOUNT_MISMATCH plausível.
  const operacoes: [string, (a: Money, b: Money) => unknown][] = [
    ["add", (a, b) => a.add(b)],
    ["subtract", (a, b) => a.subtract(b)],
    ["isLessThan", (a, b) => a.isLessThan(b)],
    ["equals", (a, b) => a.equals(b)],
  ];

  for (const [nome, operar] of operacoes) {
    it(`${nome} lança entre moedas diferentes`, () => {
      expect(() => operar(brl("10.00"), usd("10.00"))).toThrow(CurrencyMismatchError);
    });

    it(`${nome} não lança dentro da mesma moeda`, () => {
      expect(() => operar(brl("10.00"), brl("10.00"))).not.toThrow();
    });
  }

  it("o erro carrega as duas moedas, não só a mensagem", () => {
    let capturado: unknown;

    try {
      brl("10.00").add(usd("10.00"));
    } catch (erro: unknown) {
      capturado = erro;
    }

    // Quem trata o erro na borda precisa dos valores (D-006); texto formatado
    // não é interface.
    expect(capturado).toBeInstanceOf(CurrencyMismatchError);
    if (capturado instanceof CurrencyMismatchError) {
      expect(capturado.expected).toBe("BRL");
      expect(capturado.received).toBe("USD");
    }
  });
});
