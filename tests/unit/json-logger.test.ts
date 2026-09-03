/**
 * E-15 — o log estruturado de RNF-06 (D-061).
 *
 * O que esta suíte prova é a **metade verificável em runtime** do requisito: uma
 * linha JSON por evento, com os cinco campos que RNF-06 nomeia, sem chave vazia e
 * com o erro reduzido a `name` e `message`.
 *
 * A outra metade — "sem dados sensíveis ou payloads financeiros completos" — é
 * provada pelo **compilador**, não por teste: `LogContext` fecha os campos, e não
 * existe assinatura que aceite `Money`, saldo ou payload. Um teste do tipo
 * "não loga dinheiro" só conseguiria afirmar que *este* caso não loga; o tipo
 * fechado afirma sobre todos.
 */
import { describe, expect, it } from "bun:test";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger.ts";

/** Coletor no lugar do stdout — o destino é injetável exatamente para isto. */
function coletor(): { linhas: string[]; logger: JsonLogger } {
  const linhas: string[] = [];

  return { linhas, logger: new JsonLogger((linha) => linhas.push(linha)) };
}

/** Lê a linha emitida como objeto, provando de quebra que ela é JSON válido. */
function registro(linha: string | undefined): Record<string, unknown> {
  if (linha === undefined) {
    throw new Error("nenhuma linha foi emitida");
  }

  const valor: unknown = JSON.parse(linha);

  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new Error(`linha não é objeto JSON: ${linha}`);
  }

  return { ...valor };
}

describe("JsonLogger — forma do registro (RNF-06)", () => {
  it("emite uma linha JSON por evento, com nível, evento e instante ISO", () => {
    const { linhas, logger } = coletor();

    logger.info("wager.transaction.processed");

    expect(linhas).toHaveLength(1);
    expect(linhas[0]).not.toContain("\n");

    const emitido = registro(linhas[0]);

    expect(emitido["level"]).toBe("info");
    expect(emitido["event"]).toBe("wager.transaction.processed");
    expect(emitido["timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("achata os cinco campos de RNF-06 na raiz do registro", () => {
    const { linhas, logger } = coletor();

    logger.info("wager.message.processed", {
      correlationId: "provider-a:trace-42",
      messageId: "msg-1",
      transactionId: "tx-1",
      walletId: "wallet-1",
      providerId: "provider-a",
    });

    const emitido = registro(linhas[0]);

    // Na raiz, e não aninhados: é o que permite filtrar por `correlationId` sem
    // que a consulta conheça a forma interna do registro.
    expect(emitido["correlationId"]).toBe("provider-a:trace-42");
    expect(emitido["messageId"]).toBe("msg-1");
    expect(emitido["transactionId"]).toBe("tx-1");
    expect(emitido["walletId"]).toBe("wallet-1");
    expect(emitido["providerId"]).toBe("provider-a");
  });

  it("omite as chaves ausentes em vez de emitir null", () => {
    const { linhas, logger } = coletor();

    logger.info("wallet.reconciliation.divergent", { walletId: "wallet-1" });

    const emitido = registro(linhas[0]);

    // Mesma convenção do corpo de erro de E-08: o leitor testa presença, e `null`
    // o obrigaria a distinguir dois "sem valor".
    expect(Object.keys(emitido)).toEqual(["timestamp", "level", "event", "walletId"]);
  });

  it("distingue os três níveis", () => {
    const { linhas, logger } = coletor();

    logger.info("a");
    logger.warn("b");
    logger.error("c", new Error("falhou"));

    expect(linhas.map((linha) => registro(linha)["level"])).toEqual(["info", "warn", "error"]);
  });
});

describe("JsonLogger — poda do erro (RNF-06)", () => {
  it("reduz o erro a name e message, e não serializa o objeto inteiro", () => {
    const { linhas, logger } = coletor();

    // Um erro do driver do PostgreSQL chega assim: com propriedades próprias que
    // carregam os parâmetros da query — que neste sistema são dinheiro (E-08).
    const erroDoDriver = Object.assign(new Error("insert falhou"), {
      code: "23505",
      parameters: ["wallet-1", "80.00", "BRL"],
    });

    logger.error("http.request.failed", erroDoDriver, { correlationId: "trace-1" });

    const emitido = registro(linhas[0]);

    expect(emitido["error"]).toEqual({ name: "Error", message: "insert falhou" });
    // A prova que importa: o valor monetário que viajava no erro não saiu no log.
    expect(linhas[0]).not.toContain("80.00");
    expect(linhas[0]).not.toContain("23505");
  });

  it("descreve o que foi lançado sem ser Error, em vez de perder o registro", () => {
    const { linhas, logger } = coletor();

    logger.error("outbox.cycle.failed", "socket hang up");

    expect(registro(linhas[0])["error"]).toEqual({
      name: "UnknownError",
      message: "socket hang up",
    });
  });
});
