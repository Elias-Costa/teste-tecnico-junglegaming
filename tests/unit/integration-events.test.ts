import { describe, expect, it } from "bun:test";
import { MissingReferenceError } from "../../src/domain/errors/missing-reference-error.ts";
import type { EventContext } from "../../src/domain/events/integration-event.ts";
import { WagerTransactionPendingReference } from "../../src/domain/events/wager-transaction-pending-reference.ts";
import { WagerTransactionProcessed } from "../../src/domain/events/wager-transaction-processed.ts";
import { WagerTransactionRejected } from "../../src/domain/events/wager-transaction-rejected.ts";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.ts";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import { LedgerDirection } from "../../src/domain/ledger-direction.ts";
import { Money } from "../../src/domain/money.ts";
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from "../../src/domain/wager-transaction.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import type { WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry.ts";

const AGORA = new Date("2026-09-01T12:00:00.000Z");

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

/** Contexto de rastreio sem `causationId` — o evento na origem da cadeia. */
const ctx: EventContext = {
  eventId: "event-1",
  correlationId: "corr-1",
  occurredAt: AGORA,
};

/** Contexto com `causationId` — evento causado por outro. */
const ctxComCausation: EventContext = { ...ctx, causationId: "event-0" };

const transacao = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-1",
    externalTransactionId: "ext-1",
    idempotencyKey: "idem-1",
    payloadHash: "c".repeat(64),
    correlationId: "corr-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("80.00"),
    createdAt: AGORA,
    ...overrides,
  });

/** Wallet com um débito aplicado — devolve o par que `WalletBalanceChanged` exige. */
const walletComDebito = (): { wallet: Wallet; entry: WalletLedgerEntry } => {
  const { wallet } = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl("100.00"),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    at: AGORA,
  });

  const entry = wallet.debit({
    entryId: "entry-1",
    transactionId: "tx-1",
    money: brl("80.00"),
    at: AGORA,
  });

  return { wallet, entry };
};

describe("WalletBalanceChanged — somente quando o saldo muda (RF-25)", () => {
  it("monta o envelope campo a campo", () => {
    const { wallet, entry } = walletComDebito();

    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.toJSON()).toEqual({
      eventId: "event-1",
      eventType: "WalletBalanceChanged",
      aggregateId: "wallet-1",
      correlationId: "corr-1",
      occurredAt: "2026-09-01T12:00:00.000Z",
      version: 1,
      data: {
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: { amount: "80.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "20.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  it("o aggregateId é a wallet, não a transação", () => {
    const { wallet, entry } = walletComDebito();

    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.aggregateId).toBe("wallet-1");
    expect(event.data.transactionId).toBe("tx-1");
  });

  it("os três valores saem do mesmo lançamento que o ledger gravou (D-018)", () => {
    const { wallet, entry } = walletComDebito();

    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.data.money).toEqual(entry.money.toJSON());
    expect(event.data.balanceBefore).toEqual(entry.balanceBefore.toJSON());
    expect(event.data.balanceAfter).toEqual(entry.balanceAfter.toJSON());
    expect(event.data.walletVersion).toBe(wallet.version);
  });
});

describe("WagerTransactionProcessed — qualquer transação aplicada (RF-25)", () => {
  it("monta o envelope campo a campo", () => {
    const transaction = transacao();
    transaction.markProcessed(undefined, brl("20.00"), AGORA);

    const event = WagerTransactionProcessed.from(transaction, ctx);

    expect(event.toJSON()).toEqual({
      eventId: "event-1",
      eventType: "WagerTransactionProcessed",
      aggregateId: "tx-1",
      correlationId: "corr-1",
      occurredAt: "2026-09-01T12:00:00.000Z",
      version: 1,
      data: {
        transactionId: "tx-1",
        providerId: "provider-1",
        externalTransactionId: "ext-1",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "80.00", currency: "BRL" },
      },
    });
  });

  it("sai para LOSS, que não move saldo nem gera lançamento (RN-03)", () => {
    // O ponto que o enunciado destaca: sem este evento, a única operação sem
    // efeito no saldo seria indistinguível, de fora, de uma que se perdeu.
    const transaction = transacao({ kind: WagerTransactionKind.Loss });
    transaction.markProcessed(undefined, brl("20.00"), AGORA);

    const event = WagerTransactionProcessed.from(transaction, ctx);

    expect(transaction.affectsBalance()).toBe(false);
    expect(event.data.kind).toBe(WagerTransactionKind.Loss);
  });

  it("omite referenceTransactionId quando não houve referência", () => {
    const transaction = transacao();
    transaction.markProcessed(undefined, brl("20.00"), AGORA);

    const envelope = WagerTransactionProcessed.from(transaction, ctx).toJSON();

    expect(Object.keys(envelope.data)).not.toContain("referenceTransactionId");
  });

  it("carrega o id interno da referência resolvida (RN-07)", () => {
    const transaction = transacao({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "ext-bet-1",
    });
    transaction.markProcessed("tx-bet-1", brl("20.00"), AGORA);

    const event = WagerTransactionProcessed.from(transaction, ctx);

    expect(event.data.referenceTransactionId).toBe("tx-bet-1");
  });
});

describe("WagerTransactionRejected — rejeição por regra de negócio (RF-25)", () => {
  it("monta o envelope campo a campo", () => {
    const transaction = transacao();
    transaction.reject(BusinessFailureCode.InsufficientFunds, brl("100.00"));

    const event = WagerTransactionRejected.from(
      transaction,
      BusinessFailureCode.InsufficientFunds,
      ctx,
    );

    expect(event.toJSON()).toEqual({
      eventId: "event-1",
      eventType: "WagerTransactionRejected",
      aggregateId: "tx-1",
      correlationId: "corr-1",
      occurredAt: "2026-09-01T12:00:00.000Z",
      version: 1,
      data: {
        transactionId: "tx-1",
        providerId: "provider-1",
        externalTransactionId: "ext-1",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "80.00", currency: "BRL" },
        failureCode: BusinessFailureCode.InsufficientFunds,
      },
    });
  });

  it("distingue reversão sem saldo de aposta sem saldo (RN-16)", () => {
    const transaction = transacao({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-win-1",
    });
    transaction.reject(BusinessFailureCode.InsufficientFundsOnReversal, brl("100.00"));

    const event = WagerTransactionRejected.from(
      transaction,
      BusinessFailureCode.InsufficientFundsOnReversal,
      ctx,
    );

    expect(event.data.failureCode).toBe(BusinessFailureCode.InsufficientFundsOnReversal);
    expect(event.data.failureCode).not.toBe(BusinessFailureCode.InsufficientFunds);
  });
});

describe("WagerTransactionPendingReference — referência ausente (RF-25, RN-15)", () => {
  const pendente = (): WagerTransaction => {
    const transaction = transacao({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-bet-1",
    });
    transaction.markPendingReference();

    return transaction;
  };

  it("monta o envelope campo a campo", () => {
    const event = WagerTransactionPendingReference.from(pendente(), ctx);

    expect(event.toJSON()).toEqual({
      eventId: "event-1",
      eventType: "WagerTransactionPendingReference",
      aggregateId: "tx-1",
      correlationId: "corr-1",
      occurredAt: "2026-09-01T12:00:00.000Z",
      version: 1,
      data: {
        transactionId: "tx-1",
        providerId: "provider-1",
        externalTransactionId: "ext-1",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Rollback,
        money: { amount: "80.00", currency: "BRL" },
        referenceExternalTransactionId: "ext-bet-1",
      },
    });
  });

  it("recusa transação sem referência, reusando o erro de D-020", () => {
    // `create` já barra REFUND/ROLLBACK sem referência, então chegar aqui
    // significa montar o evento a partir de um kind que nunca deveria estar
    // em PENDING_REFERENCE — erro de programação, não rejeição de negócio.
    const semReferencia = transacao({ kind: WagerTransactionKind.Bet });

    expect(() => WagerTransactionPendingReference.from(semReferencia, ctx)).toThrow(
      MissingReferenceError,
    );
  });
});

describe("Envelope IntegrationEvent — contrato comum (RF-07)", () => {
  const todosOsEventos = (contexto: EventContext): ReadonlyArray<{ nome: string; json: unknown }> => {
    const { wallet, entry } = walletComDebito();

    const processada = transacao();
    processada.markProcessed(undefined, brl("20.00"), AGORA);

    const rejeitada = transacao();
    rejeitada.reject(BusinessFailureCode.InsufficientFunds, brl("100.00"));

    const pendente = transacao({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-bet-1",
    });
    pendente.markPendingReference();

    return [
      {
        nome: "WalletBalanceChanged",
        json: WalletBalanceChanged.from(wallet, entry, contexto).toJSON(),
      },
      {
        nome: "WagerTransactionProcessed",
        json: WagerTransactionProcessed.from(processada, contexto).toJSON(),
      },
      {
        nome: "WagerTransactionRejected",
        json: WagerTransactionRejected.from(
          rejeitada,
          BusinessFailureCode.InsufficientFunds,
          contexto,
        ).toJSON(),
      },
      {
        nome: "WagerTransactionPendingReference",
        json: WagerTransactionPendingReference.from(pendente, contexto).toJSON(),
      },
    ];
  };

  it("os quatro eventos de RF-25 carregam eventType e version no tipo", () => {
    for (const { nome, json } of todosOsEventos(ctx)) {
      expect(json).toMatchObject({ eventType: nome, version: 1 });
    }
  });

  it("occurredAt sai em ISO-8601, nunca como Date", () => {
    for (const { json } of todosOsEventos(ctx)) {
      const envelope = json as { occurredAt: unknown };

      expect(envelope.occurredAt).toBe("2026-09-01T12:00:00.000Z");
      expect(typeof envelope.occurredAt).toBe("string");
    }
  });

  it("causationId ausente é chave omitida, não undefined explícito", () => {
    for (const { json } of todosOsEventos(ctx)) {
      expect(Object.keys(json as object)).not.toContain("causationId");
    }
  });

  it("causationId presente entra no envelope", () => {
    for (const { json } of todosOsEventos(ctxComCausation)) {
      expect(json).toMatchObject({ causationId: "event-0" });
    }
  });

  it("o payload é serializável e nenhum bigint escapa (EL-01)", () => {
    for (const { json } of todosOsEventos(ctx)) {
      // Um `Money` no `data` faria `JSON.stringify` lançar por causa do bigint
      // privado — é assim que EL-01 vazaria pela serialização sem ninguém ver.
      expect(() => JSON.stringify(json)).not.toThrow();

      const reserializado: unknown = JSON.parse(JSON.stringify(json));

      expect(reserializado).toEqual(json);
    }
  });

  it("todo valor monetário no data é MoneyProps com string decimal", () => {
    for (const { json } of todosOsEventos(ctx)) {
      const envelope = json as { data: Record<string, unknown> };

      for (const [campo, valor] of Object.entries(envelope.data)) {
        if (campo === "money" || campo.startsWith("balance")) {
          expect(valor).toEqual({
            amount: expect.stringMatching(/^-?\d+\.\d{2}$/) as unknown as string,
            currency: "BRL",
          });
        }
      }
    }
  });
});
