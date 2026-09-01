import { describe, expect, it } from "bun:test";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.ts";
import { Money } from "../../src/domain/money.ts";
import { OutboxMessage, type OutboxMessageState } from "../../src/domain/outbox-message.ts";
import type { RetryPolicy } from "../../src/domain/retry-policy.ts";
import { Wallet } from "../../src/domain/wallet.ts";

const AGORA = new Date("2026-09-01T12:00:00.000Z");

/** Defaults de D-008: base de 1 s, teto de 5 min. */
const BASE_MS = 1_000;
const TETO_MS = 300_000;

/**
 * Política com `random` fixo — é o que torna a curva de D-022 determinística sem
 * substituir o mecanismo por um relógio ou gerador falso.
 */
const policy = (random: number): RetryPolicy => ({
  baseDelayMs: BASE_MS,
  maxDelayMs: TETO_MS,
  random: () => random,
});

/** Evento real, não dublê: a outbox precisa aceitar o que o domínio produz. */
const evento = (): WalletBalanceChanged => {
  const { wallet, openingEntry } = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    at: AGORA,
  });

  return WalletBalanceChanged.from(wallet, openingEntry!, {
    eventId: "event-1",
    correlationId: "corr-1",
    occurredAt: AGORA,
  });
};

const state = (overrides: Partial<OutboxMessageState> = {}): OutboxMessageState => ({
  id: "outbox-1",
  aggregateId: "wallet-1",
  eventType: "WalletBalanceChanged",
  payload: { eventId: "event-1" },
  occurredAt: AGORA,
  attempts: 0,
  ...overrides,
});

describe("OutboxMessage.enqueue — evento gravado com a transação (RF-06, RF-23)", () => {
  it("copia identidade e envelope do evento", () => {
    const event = evento();

    const message = OutboxMessage.enqueue({ id: "outbox-1", event });

    expect(message.id).toBe("outbox-1");
    expect(message.aggregateId).toBe("wallet-1");
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.occurredAt).toEqual(AGORA);
    expect(message.payload).toEqual(event.toJSON());
  });

  it("nasce pendente, sem tentativa, sem agendamento e sem lease", () => {
    const message = OutboxMessage.enqueue({ id: "outbox-1", event: evento() });

    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.publishedAt).toBeUndefined();
    expect(message.lockedBy).toBeUndefined();
    expect(message.lockedUntil).toBeUndefined();
  });

  it("a primeira tentativa é imediata", () => {
    const message = OutboxMessage.enqueue({ id: "outbox-1", event: evento() });

    expect(message.isDue(AGORA)).toBe(true);
  });

  it("guarda o payload já serializado, sem instância de Money (EL-01)", () => {
    const message = OutboxMessage.enqueue({ id: "outbox-1", event: evento() });

    // O `bigint` de centavos não pode sair do domínio: se escapasse para o
    // payload, `JSON.stringify` lançaria na hora de gravar na coluna jsonb.
    expect(() => JSON.stringify(message.payload)).not.toThrow();
    expect(JSON.stringify(message.payload)).toContain("\"amount\":\"100.00\"");
  });
});

describe("OutboxMessage — consultas do worker (RF-24, D-009)", () => {
  it("isDue é falso enquanto o backoff não venceu", () => {
    const message = OutboxMessage.rehydrate(
      state({ attempts: 1, nextAttemptAt: new Date("2026-09-01T12:00:05.000Z") }),
    );

    expect(message.isDue(AGORA)).toBe(false);
    expect(message.isDue(new Date("2026-09-01T12:00:05.000Z"))).toBe(true);
  });

  it("isDue é falso para mensagem já publicada, mesmo com agendamento vencido", () => {
    const message = OutboxMessage.rehydrate(
      state({ attempts: 1, nextAttemptAt: AGORA, publishedAt: AGORA }),
    );

    expect(message.isPending()).toBe(false);
    expect(message.isDue(AGORA)).toBe(false);
  });

  it("isClaimed é verdadeiro só enquanto o lease está em vigor", () => {
    const message = OutboxMessage.rehydrate(
      state({ lockedBy: "publisher-a", lockedUntil: new Date("2026-09-01T12:00:30.000Z") }),
    );

    expect(message.isClaimed(AGORA)).toBe(true);
    expect(message.lockedBy).toBe("publisher-a");
  });

  it("lease vencido conta como livre — é o cenário obrigatório de RF-24", () => {
    // Instância morreu depois do commit e antes de publicar: passado o lease,
    // outra instância precisa poder assumir.
    const message = OutboxMessage.rehydrate(
      state({ lockedBy: "publisher-a", lockedUntil: new Date("2026-09-01T11:59:59.000Z") }),
    );

    expect(message.isClaimed(AGORA)).toBe(false);
    expect(message.isDue(AGORA)).toBe(true);
  });

  it("isDue ignora o lease — quem resolve disputa é o banco (D-009)", () => {
    const message = OutboxMessage.rehydrate(
      state({ lockedBy: "publisher-a", lockedUntil: new Date("2026-09-01T12:00:30.000Z") }),
    );

    expect(message.isClaimed(AGORA)).toBe(true);
    expect(message.isDue(AGORA)).toBe(true);
  });
});

describe("OutboxMessage.markPublished — at-least-once (D-009)", () => {
  it("deixa de estar pendente", () => {
    const message = OutboxMessage.enqueue({ id: "outbox-1", event: evento() });

    message.markPublished(AGORA);

    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(AGORA);
  });

  it("não lança em republicação — o custo assumido em D-009", () => {
    const message = OutboxMessage.enqueue({ id: "outbox-1", event: evento() });
    const depois = new Date("2026-09-01T12:00:40.000Z");

    message.markPublished(AGORA);

    expect(() => {
      message.markPublished(depois);
    }).not.toThrow();
    expect(message.publishedAt).toEqual(depois);
  });
});

describe("OutboxMessage.scheduleRetry — equal jitter (RF-06, D-008, D-022)", () => {
  /** Milissegundos entre `AGORA` e o agendamento resultante. */
  const atrasoApos = (attempts: number, random: number): number => {
    const message = OutboxMessage.rehydrate(state({ attempts }));

    message.scheduleRetry(AGORA, policy(random));

    return message.nextAttemptAt!.getTime() - AGORA.getTime();
  };

  it("incrementa attempts a cada chamada", () => {
    const message = OutboxMessage.enqueue({ id: "outbox-1", event: evento() });

    message.scheduleRetry(AGORA, policy(0.5));
    expect(message.attempts).toBe(1);

    message.scheduleRetry(AGORA, policy(0.5));
    expect(message.attempts).toBe(2);
  });

  it("usa a contagem anterior ao incremento — a 1ª falha agenda no degrau base", () => {
    // h = min(300000, 1000 · 2^0) / 2 = 500 → faixa [500, 1000].
    expect(atrasoApos(0, 0)).toBe(500);
    expect(atrasoApos(0, 1)).toBe(1_000);
  });

  it("dobra a faixa a cada tentativa", () => {
    expect(atrasoApos(1, 0)).toBe(1_000);
    expect(atrasoApos(1, 1)).toBe(2_000);

    expect(atrasoApos(3, 0)).toBe(4_000);
    expect(atrasoApos(3, 1)).toBe(8_000);

    expect(atrasoApos(6, 0)).toBe(32_000);
    expect(atrasoApos(6, 1)).toBe(64_000);
  });

  it("satura no teto de 5 min de D-008", () => {
    // 1000 · 2^9 = 512000 já passou do teto: h = 300000 / 2 = 150000.
    expect(atrasoApos(9, 0)).toBe(150_000);
    expect(atrasoApos(9, 1)).toBe(TETO_MS);

    expect(atrasoApos(20, 0)).toBe(150_000);
    expect(atrasoApos(20, 1)).toBe(TETO_MS);
  });

  it("mantém o piso — é o que separa equal jitter de full jitter (D-022)", () => {
    // Com full jitter o sorteio poderia dar ~0 e deixar a retentativa quase
    // quente. Aqui o mínimo de cada faixa é metade do teto daquela faixa.
    expect(atrasoApos(0, 0)).toBeGreaterThan(0);
    expect(atrasoApos(0, 0)).toBe(atrasoApos(0, 1) / 2);
    expect(atrasoApos(4, 0)).toBe(atrasoApos(4, 1) / 2);
  });

  it("o jitter varia dentro da faixa", () => {
    const baixo = atrasoApos(5, 0.1);
    const alto = atrasoApos(5, 0.9);

    expect(baixo).toBeGreaterThanOrEqual(16_000);
    expect(alto).toBeLessThanOrEqual(32_000);
    expect(alto).toBeGreaterThan(baixo);
  });

  it("agenda sempre em milissegundo inteiro", () => {
    // Fração de ms não sobreviveria ao round-trip da coluna timestamptz de E-05.
    const atraso = atrasoApos(2, 0.3333333333);

    expect(atraso % 1).toBe(0);
    expect(Number.isInteger(atraso)).toBe(true);
  });

  it("contagem absurda vinda do banco não produz Infinity nem NaN", () => {
    // `2 ** 5000` seria Infinity e o agendamento viraria Invalid Date, travando
    // a linha para sempre. O expoente é limitado antes da potência.
    const atraso = atrasoApos(5_000, 0.5);

    expect(Number.isFinite(atraso)).toBe(true);
    expect(atraso).toBe(225_000);
  });

  it("agenda a partir do instante recebido, não do relógio do processo", () => {
    const message = OutboxMessage.rehydrate(state({ attempts: 0 }));
    const outroInstante = new Date("2026-09-02T08:30:00.000Z");

    message.scheduleRetry(outroInstante, policy(0));

    expect(message.nextAttemptAt).toEqual(new Date("2026-09-02T08:30:00.500Z"));
  });

  it("reagendar não publica nem reivindica", () => {
    const message = OutboxMessage.enqueue({ id: "outbox-1", event: evento() });

    message.scheduleRetry(AGORA, policy(0.5));

    expect(message.isPending()).toBe(true);
    expect(message.publishedAt).toBeUndefined();
    expect(message.lockedBy).toBeUndefined();
    expect(message.isDue(AGORA)).toBe(false);
  });
});

describe("OutboxMessage.rehydrate — não revalida (§6.0)", () => {
  it("reconstrói o estado completo, lease inclusive", () => {
    const message = OutboxMessage.rehydrate(
      state({
        attempts: 3,
        nextAttemptAt: new Date("2026-09-01T12:00:08.000Z"),
        lockedBy: "publisher-b",
        lockedUntil: new Date("2026-09-01T12:00:30.000Z"),
      }),
    );

    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt).toEqual(new Date("2026-09-01T12:00:08.000Z"));
    expect(message.lockedBy).toBe("publisher-b");
    expect(message.lockedUntil).toEqual(new Date("2026-09-01T12:00:30.000Z"));
  });
});
