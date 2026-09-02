/**
 * Mapeamento `Money` ↔ colunas (D-004) — a fronteira mais perigosa de EL-01.
 *
 * O domínio guarda centavos em `bigint`, exato por construção (D-003). O banco
 * guarda `numeric(19,2)`, legível por humano e somável em SQL. Este mapper é o
 * **único** ponto que conhece as duas representações, então é também o único
 * lugar onde a conversão pode se perder — e perder-se aqui não quebra nenhum
 * teste de negócio, porque o valor continua parecendo certo até a casa decimal
 * que ninguém olha.
 *
 * A contraparte contra o PostgreSQL real está em `persistence-round-trip.test.ts`,
 * que prova que o driver devolve `numeric` como string. Aqui se prova o que a
 * aplicação faz com o que recebe.
 */
import { describe, expect, it } from "bun:test";
import { InvalidMoneyError } from "../../src/domain/errors/invalid-money-error.ts";
import { Money } from "../../src/domain/money.ts";
import { moneyFromColumns, moneyToColumns } from "../../src/infrastructure/persistence/money-mapper.ts";

/** Teto de `numeric(19,2)`: 17 dígitos inteiros e 2 decimais (D-004). */
const MAIOR_VALOR = `${"9".repeat(17)}.99`;

describe("moneyToColumns — o domínio vira duas colunas (D-004)", () => {
  it("separa valor e moeda na forma que o schema espera", () => {
    const columns = moneyToColumns(Money.from({ amount: "25.00", currency: "BRL" }));

    expect(columns).toEqual({ amount: "25.00", currency: "BRL" });
  });

  it("mantém a escala 2 mesmo quando os centavos são zero", () => {
    // `"0.00"` e não `"0"`: a coluna é `numeric(19,2)` e a forma canônica de
    // D-015 é o que sustenta o `payloadHash` de D-005.
    expect(moneyToColumns(Money.zero("BRL")).amount).toBe("0.00");
  });
});

describe("moneyFromColumns — as duas colunas viram domínio (D-004)", () => {
  it("faz round-trip exato de um valor comum", () => {
    const original = Money.from({ amount: "1234.56", currency: "BRL" });
    const columns = moneyToColumns(original);

    expect(moneyFromColumns(columns.amount, columns.currency).equals(original)).toBe(true);
  });

  it("faz round-trip exato no teto de numeric(19,2) — onde um float perderia dígitos", () => {
    // 19 dígitos significativos. Um `double` tem ~15–17 e arredondaria em
    // silêncio; o `bigint` de D-003 não. É o teste que separa "guarda dinheiro"
    // de "guarda um número parecido com dinheiro" (EL-01).
    const original = Money.from({ amount: MAIOR_VALOR, currency: "BRL" });

    const voltou = moneyFromColumns(moneyToColumns(original).amount, "BRL");

    expect(voltou.toJSON().amount).toBe(MAIOR_VALOR);
    expect(voltou.equals(original)).toBe(true);
  });

  it("recusa alto quando o driver devolve o valor como number (EL-01)", () => {
    // O cenário real: alguém registra um type parser para o OID de `numeric`, e
    // a partir daí todo dinheiro entra no domínio já convertido para ponto
    // flutuante. Nenhuma exceção, nenhum teste de negócio vermelho — só
    // centavos que somem meses depois. A guarda transforma isso em falha alta.
    expect(() => moneyFromColumns(25, "BRL")).toThrow(TypeError);
    expect(() => moneyFromColumns(25, "BRL")).toThrow(/type parser/);
  });

  it("recusa quando a moeda não vem como string", () => {
    expect(() => moneyFromColumns("25.00", null)).toThrow(TypeError);
  });

  it("recusa texto fora da forma canônica, pela validação do próprio Money", () => {
    // Não é papel do mapper revalidar D-015: ele delega a `Money.from`, e o
    // teste existe para provar que a delegação acontece — um mapper que
    // construísse `Money` por outro caminho não teria essa proteção.
    expect(() => moneyFromColumns("25.5", "BRL")).toThrow(InvalidMoneyError);
    expect(() => moneyFromColumns("25.00", "brl")).toThrow(InvalidMoneyError);
  });
});
