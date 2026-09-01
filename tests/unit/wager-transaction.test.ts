import { describe, expect, it } from "bun:test";
import { InvalidTransactionStateError } from "../../src/domain/errors/invalid-transaction-state-error.ts";
import { MissingReferenceError } from "../../src/domain/errors/missing-reference-error.ts";
import { NoLedgerDirectionError } from "../../src/domain/errors/no-ledger-direction-error.ts";
import {
  BusinessFailureCode,
  InfrastructureFailureCode,
} from "../../src/domain/failure-code.ts";
import { LedgerDirection } from "../../src/domain/ledger-direction.ts";
import { Money } from "../../src/domain/money.ts";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from "../../src/domain/wager-transaction.ts";

const EM = new Date("2026-09-01T12:00:00.000Z");

const props = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: "tx-1",
  providerId: "provider-1",
  externalTransactionId: "ext-1",
  idempotencyKey: "provider-1:ext-1",
  payloadHash: "hash-original",
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: "80.00", currency: "BRL" }),
  createdAt: EM,
  ...overrides,
});

/** Transação já no status pedido, sem passar por transição (§6.0). */
const em = (
  status: WagerTransactionStatus,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction => WagerTransaction.rehydrate({ ...props(overrides), status });

/**
 * As quatro transições do grafo, pareadas com o status de destino.
 *
 * Ter as transições como dados permite exercer a matriz inteira — 5 status × 4
 * transições — em vez de escolher a dedo os casos que parecem interessantes.
 */
const TRANSICOES: ReadonlyArray<[WagerTransactionStatus, (transacao: WagerTransaction) => void]> = [
  [
    WagerTransactionStatus.Processed,
    (t) => {
      t.markProcessed(undefined, EM);
    },
  ],
  [
    WagerTransactionStatus.PendingReference,
    (t) => {
      t.markPendingReference();
    },
  ],
  [
    WagerTransactionStatus.Rejected,
    (t) => {
      t.reject(BusinessFailureCode.InsufficientFunds);
    },
  ],
  [
    WagerTransactionStatus.Failed,
    (t) => {
      t.fail(InfrastructureFailureCode.PermanentInfrastructureError);
    },
  ],
];

/** Devolve o erro lançado pela ação, para inspecionar seus campos. */
function capturar(acao: () => void): unknown {
  try {
    acao();
  } catch (erro) {
    return erro;
  }

  return undefined;
}

/** Grafo de D-013, transcrito **do documento**, não do código sob teste. */
const PERMITIDAS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

describe("WagerTransaction — matriz de transições (RT-07, D-013)", () => {
  for (const origem of Object.values(WagerTransactionStatus)) {
    for (const [destino, aplicar] of TRANSICOES) {
      const permitida = PERMITIDAS[origem].includes(destino);

      it(`${origem} → ${destino}: ${permitida ? "permitida" : "recusada"}`, () => {
        const transacao = em(origem);

        if (permitida) {
          aplicar(transacao);
          expect(transacao.status).toBe(destino);
          return;
        }

        expect(() => {
          aplicar(transacao);
        }).toThrow(InvalidTransactionStateError);
        // A transição recusada não pode ter deixado efeito colateral.
        expect(transacao.status).toBe(origem);
      });
    }
  }

  it("terminal é 'não tem transição de saída'", () => {
    expect(em(WagerTransactionStatus.Pending).isTerminal()).toBe(false);
    expect(em(WagerTransactionStatus.PendingReference).isTerminal()).toBe(false);
    expect(em(WagerTransactionStatus.Processed).isTerminal()).toBe(true);
    expect(em(WagerTransactionStatus.Rejected).isTerminal()).toBe(true);
    expect(em(WagerTransactionStatus.Failed).isTerminal()).toBe(true);
  });

  // Caso explícito de D-013: o reagendamento do worker de E-13 é `UPDATE` nas
  // colunas de tentativa, não uma segunda `markPendingReference()`.
  it("markPendingReference sobre PENDING_REFERENCE lança, com origem e destino no erro", () => {
    const transacao = em(WagerTransactionStatus.PendingReference);

    const erro = capturar(() => {
      transacao.markPendingReference();
    });

    expect(erro).toBeInstanceOf(InvalidTransactionStateError);

    if (erro instanceof InvalidTransactionStateError) {
      expect(erro.from).toBe(WagerTransactionStatus.PendingReference);
      expect(erro.to).toBe(WagerTransactionStatus.PendingReference);
    }
  });

  it("markProcessed grava referência resolvida e instante", () => {
    const transacao = WagerTransaction.create(props());
    transacao.markProcessed("tx-referenciada", EM);

    expect(transacao.status).toBe(WagerTransactionStatus.Processed);
    expect(transacao.referenceTransactionId).toBe("tx-referenciada");
    expect(transacao.processedAt).toEqual(EM);
  });

  it("reject e fail gravam o failureCode", () => {
    const rejeitada = WagerTransaction.create(props());
    rejeitada.reject(BusinessFailureCode.InsufficientFunds);
    expect(rejeitada.failureCode).toBe(BusinessFailureCode.InsufficientFunds);

    const falha = WagerTransaction.create(props());
    falha.fail(InfrastructureFailureCode.MaxRetriesExhausted);
    expect(falha.failureCode).toBe(InfrastructureFailureCode.MaxRetriesExhausted);
  });
});

describe("WagerTransaction.create — nascimento e referência (RF-03, RN-06, D-020)", () => {
  it("nasce em PENDING, sem failureCode e sem processedAt", () => {
    const transacao = WagerTransaction.create(props());

    expect(transacao.status).toBe(WagerTransactionStatus.Pending);
    expect(transacao.isTerminal()).toBe(false);
    expect(transacao.failureCode).toBeUndefined();
    expect(transacao.processedAt).toBeUndefined();
  });

  for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
    it(`${kind} sem referência é payload inválido, não rejeição (D-020)`, () => {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(MissingReferenceError);
    });

    it(`${kind} com referência nasce normalmente`, () => {
      const transacao = WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: "ext-original" }),
      );

      expect(transacao.status).toBe(WagerTransactionStatus.Pending);
      expect(transacao.referenceExternalTransactionId).toBe("ext-original");
    });
  }

  for (const kind of [
    WagerTransactionKind.Opening,
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
  ]) {
    it(`${kind} não exige referência`, () => {
      expect(WagerTransaction.create(props({ kind })).requiresReference()).toBe(false);
    });
  }

  it("rehydrate não revalida a exigência de referência (§6.0)", () => {
    const transacao = WagerTransaction.rehydrate({
      ...props({ kind: WagerTransactionKind.Refund }),
      status: WagerTransactionStatus.Rejected,
      failureCode: BusinessFailureCode.ReferenceNotFound,
    });

    expect(transacao.status).toBe(WagerTransactionStatus.Rejected);
  });
});

describe("WagerTransaction — consultas de domínio (RT-03)", () => {
  it("affectsBalance é falso somente para LOSS (RN-03)", () => {
    const esperado: ReadonlyArray<[WagerTransactionKind, boolean]> = [
      [WagerTransactionKind.Opening, true],
      [WagerTransactionKind.Bet, true],
      [WagerTransactionKind.Win, true],
      [WagerTransactionKind.Loss, false],
      [WagerTransactionKind.Refund, true],
      [WagerTransactionKind.Rollback, true],
    ];

    for (const [kind, afeta] of esperado) {
      const transacao = WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: "ext-original" }),
      );
      expect(transacao.affectsBalance()).toBe(afeta);
    }
  });

  it("requiresReference é verdadeiro somente para REFUND e ROLLBACK (RN-06)", () => {
    const exigem = Object.values(WagerTransactionKind).filter((kind) =>
      WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: "ext-original" }),
      ).requiresReference(),
    );

    expect(exigem).toEqual([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);
  });

  it("matchesPayload distingue replay de conflito (RN-14)", () => {
    const transacao = WagerTransaction.create(props());

    expect(transacao.matchesPayload("hash-original")).toBe(true);
    expect(transacao.matchesPayload("hash-diferente")).toBe(false);
  });
});

describe("WagerTransaction.ledgerDirectionFor (RF-04, RN-01..RN-05)", () => {
  it("credita OPENING, WIN e REFUND", () => {
    for (const kind of [
      WagerTransactionKind.Opening,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ]) {
      const transacao = WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: "ext-original" }),
      );
      expect(transacao.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    }
  });

  it("debita BET (RN-01)", () => {
    expect(WagerTransaction.create(props()).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  // RN-05: o efeito do ROLLBACK é o inverso da referência, e RN-08 limita as
  // referências possíveis a BET, WIN e REFUND.
  it("ROLLBACK inverte a direção da referência (RN-05)", () => {
    const rollback = WagerTransaction.create(
      props({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-original" }),
    );

    const inversoEsperado: ReadonlyArray<[WagerTransactionKind, LedgerDirection]> = [
      [WagerTransactionKind.Bet, LedgerDirection.Credit],
      [WagerTransactionKind.Win, LedgerDirection.Debit],
      [WagerTransactionKind.Refund, LedgerDirection.Debit],
    ];

    for (const [kindReferencia, direcao] of inversoEsperado) {
      const referencia = WagerTransaction.create(
        props({
          id: "tx-referenciada",
          kind: kindReferencia,
          referenceExternalTransactionId: "ext-anterior",
        }),
      );

      expect(rollback.ledgerDirectionFor(referencia)).toBe(direcao);
    }
  });

  it("ROLLBACK sem referência resolvida lança (RN-05)", () => {
    const rollback = WagerTransaction.create(
      props({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-original" }),
    );

    expect(() => rollback.ledgerDirectionFor()).toThrow(NoLedgerDirectionError);
  });

  it("LOSS não tem direção porque não gera lançamento (RN-03, RF-04)", () => {
    const loss = WagerTransaction.create(props({ kind: WagerTransactionKind.Loss }));

    expect(() => loss.ledgerDirectionFor()).toThrow(NoLedgerDirectionError);
  });
});

describe("FailureCode — taxonomia fechada em 13 (D-007)", () => {
  it("tem 11 códigos de negócio e 2 de infraestrutura", () => {
    expect(Object.values(BusinessFailureCode)).toHaveLength(11);
    expect(Object.values(InfrastructureFailureCode)).toHaveLength(2);
  });

  // RN-16 é explícita: sem saldo para apostar e sem saldo para reverter são
  // situações operacionalmente diferentes e não podem compartilhar código.
  it("distingue saldo insuficiente de saldo insuficiente na reversão (RN-16)", () => {
    expect(BusinessFailureCode.InsufficientFunds).not.toBe(
      BusinessFailureCode.InsufficientFundsOnReversal,
    );
  });
});
