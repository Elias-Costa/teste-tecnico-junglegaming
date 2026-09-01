import { describe, expect, it } from "bun:test";
import { InboxMessage, type ReceiveInboxProps } from "../../src/domain/inbox-message.ts";

const RECEBIDA_EM = new Date("2026-09-01T12:00:00.000Z");
const PROCESSADA_EM = new Date("2026-09-01T12:00:03.000Z");

const props = (overrides: Partial<ReceiveInboxProps> = {}): ReceiveInboxProps => ({
  messageId: "sqs-message-1",
  consumerName: "wagering-consumer",
  payloadHash: "a".repeat(64),
  receivedAt: RECEBIDA_EM,
  ...overrides,
});

describe("InboxMessage.receive — dedupe persistente (RF-05, RF-19)", () => {
  it("nasce não processada", () => {
    const message = InboxMessage.receive(props());

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    expect(message.messageId).toBe("sqs-message-1");
    expect(message.consumerName).toBe("wagering-consumer");
  });

  it("guarda o hash do payload, não o payload", () => {
    const message = InboxMessage.receive(props({ payloadHash: "b".repeat(64) }));

    expect(message.payloadHash).toBe("b".repeat(64));
    // A entidade não tem onde guardar payload: o resultado do replay vem da
    // transação financeira (RN-12), não daqui.
    expect(Object.keys(message)).not.toContain("payload");
  });

  it("a identidade é o par (consumerName, messageId), sem id próprio", () => {
    // Duas instâncias do mesmo messageId em consumidores diferentes são
    // trabalhos legítimos e distintos — quem impõe a unicidade é o
    // UNIQUE (consumer_name, message_id) de E-05 (RI-09).
    const a = InboxMessage.receive(props({ consumerName: "wagering-consumer" }));
    const b = InboxMessage.receive(props({ consumerName: "reconciliation-consumer" }));

    expect(a.messageId).toBe(b.messageId);
    expect(a.consumerName).not.toBe(b.consumerName);
    expect(Object.keys(a)).not.toContain("id");
  });
});

describe("InboxMessage.markProcessed — conclusão após o commit (RF-20)", () => {
  it("passa a reportar processada", () => {
    const message = InboxMessage.receive(props());

    message.markProcessed(PROCESSADA_EM);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(PROCESSADA_EM);
  });

  it("não guarda contra remarcação — reentrega é esperada, não erro", () => {
    const message = InboxMessage.receive(props());
    const outroInstante = new Date("2026-09-01T12:00:09.000Z");

    message.markProcessed(PROCESSADA_EM);

    expect(() => {
      message.markProcessed(outroInstante);
    }).not.toThrow();
    expect(message.processedAt).toEqual(outroInstante);
  });
});

describe("InboxMessage.rehydrate — não revalida (§6.0)", () => {
  it("reconstrói mensagem já processada", () => {
    const message = InboxMessage.rehydrate({ ...props(), processedAt: PROCESSADA_EM });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(PROCESSADA_EM);
  });

  it("reconstrói mensagem pendente", () => {
    const message = InboxMessage.rehydrate({ ...props(), processedAt: undefined });

    expect(message.isProcessed()).toBe(false);
  });

  it("aceita processedAt anterior a receivedAt sem reclamar", () => {
    // Estado impossível pela regra, mas já persistido: `rehydrate` reconstrói,
    // não julga. Recusar aqui transformaria leitura de histórico em exceção.
    const message = InboxMessage.rehydrate({
      ...props(),
      processedAt: new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(message.isProcessed()).toBe(true);
  });
});
