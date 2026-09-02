/**
 * E-07 — o use case de processamento contra o PostgreSQL real.
 *
 * É aqui que **RT-09** mora: atomicidade entre transação, saldo, ledger, inbox e
 * outbox, com a garantia de que falha em qualquer ponto não deixa estado parcial
 * (RF-23). Junto dele, as três propriedades que a etapa entrega e que só se
 * observam com banco de verdade:
 *
 *  - **EL-06 / RI-04** — o desfecho produz linhas na outbox, **não publicações**.
 *    Nenhum evento sai daqui; quem publica é o worker de E-10, depois do commit.
 *  - **RN-12 / D-030** — o replay devolve o saldo daquele instante, inclusive
 *    quando não houve lançamento nenhum para reconstruí-lo (rejeição).
 *  - **RN-14** — a mesma key com payload diferente é conflito, não replay.
 *
 * **Sem mock em ponto nenhum** (EL-08). As falhas de RT-09 são injetadas pelo
 * `IdGenerator`, que devolve um id já existente: quem recusa é o PostgreSQL, com
 * `23505` de verdade, no meio da transação — e o que se observa é o rollback
 * real, não um `throw` encenado.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { IdempotencyConflictError } from "../../src/application/errors/idempotency-conflict-error.ts";
import { KindNotSubmittableError } from "../../src/application/errors/kind-not-submittable-error.ts";
import { WalletNotFoundError } from "../../src/application/errors/wallet-not-found-error.ts";
import type { Clock } from "../../src/application/ports/clock.ts";
import type { IdGenerator } from "../../src/application/ports/id-generator.ts";
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
  type ProcessWagerTransactionResult,
} from "../../src/application/process-wager-transaction.ts";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.ts";
import { InvalidLedgerEntryError } from "../../src/domain/errors/invalid-ledger-entry-error.ts";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import { LedgerDirection } from "../../src/domain/ledger-direction.ts";
import { Money } from "../../src/domain/money.ts";
import { OutboxMessage } from "../../src/domain/outbox-message.ts";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import type { WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry.ts";
import { WagerTransaction } from "../../src/domain/wager-transaction.ts";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { MikroWalletRepository } from "../../src/infrastructure/persistence/repositories/mikro-wallet-repository.ts";
import { inboxMessageRowSchema } from "../../src/infrastructure/persistence/rows/inbox-message-row.ts";
import { outboxMessageRowSchema } from "../../src/infrastructure/persistence/rows/outbox-message-row.ts";
import type { WagerTransactionRow } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import { wagerTransactionRowSchema } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import { walletLedgerEntryRowSchema } from "../../src/infrastructure/persistence/rows/wallet-ledger-entry-row.ts";
// A reconciliação de §6.4 é **uma** função para toda a suíte (E-09): reimplementá-la
// por arquivo transformaria um requisito em vários requisitos parecidos.
import { expectLedgerReconciles } from "../support/concurrency-harness.ts";

let orm: MikroORM;

const AGORA = new Date("2026-09-02T10:00:00.000Z");
const PROVIDER = "provider-a";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

/** UUIDv7 (D-014) — `crypto.randomUUID()` é v4 e não serve como id neste projeto. */
function newId(): string {
  return Bun.randomUUIDv7();
}

/** Sufixo único, para que um teste não falhe por unicidade que outro exercitou. */
function unique(prefix: string): string {
  return `${prefix}-${newId()}`;
}

/** Relógio fixo: instante único e verificável em `createdAt`, ledger e eventos. */
class RelogioFixo implements Clock {
  constructor(private readonly instante: Date) {}

  now(): Date {
    return this.instante;
  }
}

/**
 * Gerador de ids com colisão programada — a injeção de falha de RT-09.
 *
 * Fora da chamada escolhida devolve UUIDv7 normal. Na chamada `na`, devolve um
 * id que **já existe** no banco, e o `insert` correspondente morre com `23505`.
 * É falha real de PostgreSQL no meio da transação: nenhum repositório é
 * substituído, nenhum `throw` é encenado (EL-08).
 */
class GeradorDeIds implements IdGenerator {
  private chamadas = 0;

  constructor(private readonly colisao?: { na: number; id: string }) {}

  next(): string {
    this.chamadas += 1;

    return this.colisao !== undefined && this.colisao.na === this.chamadas
      ? this.colisao.id
      : newId();
  }
}

/**
 * Ordem em que o use case consome ids num `BET`.
 *
 * Documentada como constantes porque é o que torna a injeção de RT-09 precisa —
 * e porque uma mudança na ordem de escrita quebra estes testes de propósito:
 * a sequência é parte do contrato de RF-23 (transação antes do lançamento que a
 * referencia) e não deve mudar sem alguém olhar.
 */
const ID_TRANSACAO = 1;
const ID_LANCAMENTO = 2;
const ID_OUTBOX_PROCESSED = 4;
const ID_OUTBOX_BALANCE = 6;

interface Carteira {
  wallet: Wallet;
  openingTransactionId: string;
  openingEntryId: string;
  /** Guardado para montar um evento real no cenário de outbox de RT-09. */
  openingEntry: WalletLedgerEntry;
}

/** O use case com relógio fixo e, opcionalmente, uma colisão de id programada. */
function useCase(colisao?: { na: number; id: string }): ProcessWagerTransaction {
  return new ProcessWagerTransaction(
    new MikroUnitOfWork(orm.em),
    new RelogioFixo(AGORA),
    new GeradorDeIds(colisao),
  );
}

/** Wallet aberta com saldo, `OPENING` aplicada e lançamento de abertura (RF-08). */
async function seedWallet(amount = "100.00"): Promise<Carteira> {
  const walletId = newId();
  const openingTransactionId = newId();
  const openingEntryId = newId();

  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: unique("player"),
    initialBalance: brl(amount),
    openingTransactionId,
    openingEntryId,
    at: AGORA,
  });

  const openingTransaction = WagerTransaction.create({
    id: openingTransactionId,
    providerId: PROVIDER,
    externalTransactionId: unique("ext-opening"),
    idempotencyKey: unique("idem-opening"),
    payloadHash: "0".repeat(64),
    correlationId: unique("corr-opening"),
    walletId,
    playerId: wallet.playerId,
    roundId: unique("round-opening"),
    gameId: "abertura",
    kind: WagerTransactionKind.Opening,
    money: brl(amount),
    createdAt: AGORA,
  });
  openingTransaction.markProcessed(undefined, wallet.balance, AGORA);

  await new MikroUnitOfWork(orm.em).run(async (repos) => {
    await repos.wallets.insert(wallet);
    await repos.transactions.insert(openingTransaction);
    await repos.ledger.insert(openingEntry!);
  });

  return { wallet, openingTransactionId, openingEntryId, openingEntry: openingEntry! };
}

function comandoDeAposta(
  carteira: Carteira,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  return {
    idempotencyKey: unique("idem"),
    providerId: PROVIDER,
    externalTransactionId: unique("ext"),
    playerId: carteira.wallet.playerId,
    walletId: carteira.wallet.id,
    roundId: unique("round"),
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    correlationId: unique("corr"),
    ...overrides,
  };
}

/** Leituras num `em` novo: o que se compara é o que o banco guardou. */
async function saldoDe(walletId: string): Promise<string | undefined> {
  const wallet = await new MikroWalletRepository(orm.em.fork()).findById(walletId);

  return wallet?.balance.toJSON().amount;
}

async function transacoesDe(walletId: string): Promise<WagerTransactionRow[]> {
  return orm.em.fork().find(wagerTransactionRowSchema, { walletId }, { disableIdentityMap: true });
}

async function lancamentosDe(walletId: string): Promise<number> {
  const rows = await orm.em
    .fork()
    .find(walletLedgerEntryRowSchema, { walletId }, { disableIdentityMap: true });

  return rows.length;
}

async function eventosDe(aggregateId: string): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .find(outboxMessageRowSchema, { aggregateId }, { disableIdentityMap: true });

  return rows.map((row) => row.eventType);
}

/** Devolve o erro lançado pela ação, para inspecionar seus campos. */
async function capturar(acao: () => Promise<unknown>): Promise<unknown> {
  try {
    await acao();
  } catch (erro: unknown) {
    return erro;
  }

  throw new Error("a ação deveria ter lançado, e não lançou.");
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
});

afterAll(async () => {
  await orm.close(true);
});

describe("BET aplicado (RN-01, RF-23)", () => {
  it("debita, lança no ledger e enfileira os dois eventos numa transação só", async () => {
    const carteira = await seedWallet("100.00");

    const resultado = await useCase().execute(
      comandoDeAposta(carteira, { money: { amount: "25.00", currency: "BRL" } }),
    );

    expect(resultado.status).toBe(WagerTransactionStatus.Processed);
    expect(resultado.balance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(resultado.idempotentReplay).toBe(false);
    expect(resultado.failureCode).toBeUndefined();

    expect(await saldoDe(carteira.wallet.id)).toBe("75.00");
    // Abertura + aposta. O ledger é a fonte auditável do saldo (RF-04).
    expect(await lancamentosDe(carteira.wallet.id)).toBe(2);

    const lancamentos = await orm.em
      .fork()
      .find(
        walletLedgerEntryRowSchema,
        { transactionId: resultado.transactionId },
        { disableIdentityMap: true },
      );

    expect(lancamentos).toHaveLength(1);
    expect(lancamentos[0]?.direction).toBe(LedgerDirection.Debit);
    expect(lancamentos[0]?.balanceBefore).toBe("100.00");
    expect(lancamentos[0]?.balanceAfter).toBe("75.00");
  });

  it("grava o saldo observado e o instante do desfecho (D-030)", async () => {
    const carteira = await seedWallet("100.00");

    const resultado = await useCase().execute(comandoDeAposta(carteira));
    const [transacao] = await orm.em
      .fork()
      .find(wagerTransactionRowSchema, { id: resultado.transactionId }, { disableIdentityMap: true });

    expect(transacao?.status).toBe(WagerTransactionStatus.Processed);
    expect(transacao?.observedBalance).toBe("75.00");
    expect(transacao?.observedBalanceCurrency).toBe("BRL");
    expect(transacao?.processedAt?.getTime()).toBe(AGORA.getTime());
    expect(transacao?.failureCode).toBeNull();
  });

  it("os eventos ficam **pendentes** na outbox — nada é publicado aqui (RI-04, EL-06)", async () => {
    const carteira = await seedWallet("100.00");

    const resultado = await useCase().execute(comandoDeAposta(carteira));

    const daTransacao = await orm.em
      .fork()
      .find(
        outboxMessageRowSchema,
        { aggregateId: resultado.transactionId },
        { disableIdentityMap: true },
      );
    const daWallet = await orm.em
      .fork()
      .find(
        outboxMessageRowSchema,
        { aggregateId: carteira.wallet.id },
        { disableIdentityMap: true },
      );

    // RF-25: transação aplicada e saldo alterado são dois fatos, sobre dois
    // agregados diferentes — e o `aggregateId` de cada evento reflete isso.
    expect(daTransacao.map((row) => row.eventType)).toEqual(["WagerTransactionProcessed"]);
    expect(daWallet.map((row) => row.eventType)).toEqual(["WalletBalanceChanged"]);

    // O coração de EL-06: as linhas existem, e **nenhuma** está publicada. A
    // publicação é do worker de E-10, depois do commit — não deste use case.
    for (const row of [...daTransacao, ...daWallet]) {
      expect(row.publishedAt).toBeNull();
      expect(row.attempts).toBe(0);
      expect(row.lockedBy).toBeNull();
    }
  });
});

describe("BET rejeitado (RN-01, RN-11, RF-25)", () => {
  it("saldo insuficiente não move saldo nem gera lançamento", async () => {
    const carteira = await seedWallet("100.00");

    const resultado = await useCase().execute(
      comandoDeAposta(carteira, { money: { amount: "150.00", currency: "BRL" } }),
    );

    expect(resultado.status).toBe(WagerTransactionStatus.Rejected);
    expect(resultado.failureCode).toBe(BusinessFailureCode.InsufficientFunds);
    // RN-12/D-030: a rejeição responde o saldo que observou, e é ele que fica
    // guardado — não há lançamento nenhum de onde reconstruí-lo depois.
    expect(resultado.balance).toEqual({ amount: "100.00", currency: "BRL" });

    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
    expect(await lancamentosDe(carteira.wallet.id)).toBe(1);
    expect(await eventosDe(resultado.transactionId)).toEqual(["WagerTransactionRejected"]);
    // RF-25: saldo não mudou, então `WalletBalanceChanged` não existe.
    expect(await eventosDe(carteira.wallet.id)).toEqual([]);
  });

  it("moeda divergente da wallet é rejeição, não erro (RF-02, D-007)", async () => {
    const carteira = await seedWallet("100.00");

    const resultado = await useCase().execute(
      comandoDeAposta(carteira, { money: { amount: "10.00", currency: "USD" } }),
    );

    // D-019: o caminho de negócio é consulta, não captura de exceção — a
    // divergência de moeda vira `failureCode` legível, e não erro 500.
    expect(resultado.status).toBe(WagerTransactionStatus.Rejected);
    expect(resultado.failureCode).toBe(BusinessFailureCode.CurrencyMismatch);
    // O saldo observado é o **da wallet**, na moeda dela — é por isso que D-030
    // guarda a moeda em coluna própria em vez de reusar a da operação.
    expect(resultado.balance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
  });
});

describe("Idempotência (RF-14, RN-12, RN-14)", () => {
  it("replay devolve o resultado original, com o saldo daquele instante", async () => {
    const carteira = await seedWallet("100.00");
    const comando = comandoDeAposta(carteira);

    const original = await useCase().execute(comando);
    // Outra aposta move a wallet: é o que separa "saldo observado" de "saldo
    // atual", e sem ela o teste passaria mesmo devolvendo o saldo corrente.
    await useCase().execute(comandoDeAposta(carteira));
    expect(await saldoDe(carteira.wallet.id)).toBe("50.00");

    const replay = await useCase().execute(comando);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(original.transactionId);
    expect(replay.status).toBe(WagerTransactionStatus.Processed);
    // RN-12 literal: `75.00` é o saldo que a operação observou; `50.00` é o de
    // agora, e devolvê-lo seria contar uma história que nunca aconteceu.
    expect(replay.balance).toEqual({ amount: "75.00", currency: "BRL" });

    // Nada novo foi escrito: abertura + duas apostas.
    expect(await transacoesDe(carteira.wallet.id)).toHaveLength(3);
    expect(await lancamentosDe(carteira.wallet.id)).toBe(3);
    expect(await saldoDe(carteira.wallet.id)).toBe("50.00");
  });

  it("replay de rejeição também devolve o saldo da época (D-030)", async () => {
    const carteira = await seedWallet("100.00");
    const comando = comandoDeAposta(carteira, { money: { amount: "150.00", currency: "BRL" } });

    const original = await useCase().execute(comando);
    await useCase().execute(comandoDeAposta(carteira));

    const replay = await useCase().execute(comando);

    // Este é o caso que decidiu D-030: rejeição não gera lançamento, então não
    // existe `balance_after` de onde reconstruir a resposta original.
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(original.transactionId);
    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.failureCode).toBe(BusinessFailureCode.InsufficientFunds);
    expect(replay.balance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(await saldoDe(carteira.wallet.id)).toBe("75.00");
  });

  it("mesma key com payload diferente é conflito, não replay (RN-14)", async () => {
    const carteira = await seedWallet("100.00");
    const comando = comandoDeAposta(carteira);

    const original = await useCase().execute(comando);

    const erro = await capturar(() =>
      useCase().execute({ ...comando, money: { amount: "30.00", currency: "BRL" } }),
    );

    expect(erro).toBeInstanceOf(IdempotencyConflictError);

    if (erro instanceof IdempotencyConflictError) {
      expect(erro.idempotencyKey).toBe(comando.idempotencyKey);
      expect(erro.transactionId).toBe(original.transactionId);
      expect(erro.failureCode).toBe(BusinessFailureCode.IdempotencyConflict);
    }

    // O conflito não pode ter efeito colateral nenhum: nem transação nova, nem
    // saldo, nem evento.
    expect(await transacoesDe(carteira.wallet.id)).toHaveLength(2);
    expect(await saldoDe(carteira.wallet.id)).toBe("75.00");
    expect(await eventosDe(original.transactionId)).toEqual(["WagerTransactionProcessed"]);
  });
});

describe("Entrada pela fila e limites do use case (RF-18, RF-19, D-031)", () => {
  it("registra a inbox na mesma transação do dinheiro (RF-23)", async () => {
    const carteira = await seedWallet("100.00");
    const consumerName = unique("consumer");
    const messageId = unique("sqs");

    const resultado = await useCase().execute(
      comandoDeAposta(carteira, { inbox: { consumerName, messageId } }),
    );

    const [registro] = await orm.em
      .fork()
      .find(inboxMessageRowSchema, { consumerName, messageId }, { disableIdentityMap: true });

    // Mesmo use case, mesma transação: a única diferença da entrada HTTP é esta
    // linha a mais (RF-18).
    expect(registro?.processedAt?.getTime()).toBe(AGORA.getTime());
    expect(await saldoDe(carteira.wallet.id)).toBe("75.00");
    expect(await eventosDe(resultado.transactionId)).toEqual(["WagerTransactionProcessed"]);
  });

  it("wallet inexistente não persiste nada e não publica evento (D-031)", async () => {
    const walletId = newId();

    const erro = await capturar(() =>
      useCase().execute({
        idempotencyKey: unique("idem"),
        providerId: PROVIDER,
        externalTransactionId: unique("ext"),
        playerId: unique("player"),
        walletId,
        roundId: unique("round"),
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: { amount: "25.00", currency: "BRL" },
        correlationId: unique("corr"),
      }),
    );

    expect(erro).toBeInstanceOf(WalletNotFoundError);

    if (erro instanceof WalletNotFoundError) {
      expect(erro.failureCode).toBe(BusinessFailureCode.WalletNotFound);
    }

    // A FK impede a linha de rejeição; a decisão de D-031 é que também não haja
    // evento sobre um agregado que não existe.
    expect(await transacoesDe(walletId)).toHaveLength(0);
    expect(await eventosDe(walletId)).toEqual([]);
  });

  it("OPENING não é submetível nem por dentro do use case (RN-13)", async () => {
    const carteira = await seedWallet("100.00");

    const erro = await capturar(() =>
      useCase().execute(comandoDeAposta(carteira, { kind: WagerTransactionKind.Opening })),
    );

    // A guarda vive antes da transação, então nada é escrito: a única linha da
    // wallet continua sendo a `OPENING` legítima que `seedWallet` criou.
    expect(erro).toBeInstanceOf(KindNotSubmittableError);
    expect(await transacoesDe(carteira.wallet.id)).toHaveLength(1);
    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
  });

  it("valor zero é payload inválido para todos os kinds, inclusive LOSS (D-021)", async () => {
    const carteira = await seedWallet("100.00");

    // `LOSS` é o caso que só esta guarda pega: não move saldo (RN-03), então não
    // passa por `Wallet.debit`/`credit`, e sem ela chegaria ao
    // `ck_wager_transactions_amount_positive` como `500`.
    const erro = await capturar(() =>
      useCase().execute(
        comandoDeAposta(carteira, {
          kind: WagerTransactionKind.Loss,
          money: { amount: "0.00", currency: "BRL" },
        }),
      ),
    );

    expect(erro).toBeInstanceOf(InvalidLedgerEntryError);
    expect(await transacoesDe(carteira.wallet.id)).toHaveLength(1);
  });
});

describe("RT-09 — atomicidade: falha em qualquer ponto não deixa estado parcial", () => {
  /**
   * Cada cenário força um `23505` real numa escrita diferente da sequência.
   *
   * O ponto da tabela é a última linha: quando a falha acontece na **segunda**
   * linha da outbox, tudo que importa já tinha sido escrito — transação
   * `PROCESSED`, saldo debitado, lançamento no ledger, primeiro evento. É o
   * cenário que distingue "grava tudo e depois publica" de "grava tudo junto".
   */
  const cenarios: ReadonlyArray<[string, number, (carteira: Carteira) => string]> = [
    ["no insert da transação", ID_TRANSACAO, (carteira) => carteira.openingTransactionId],
    ["no lançamento do ledger, depois de debitar a wallet", ID_LANCAMENTO, (c) => c.openingEntryId],
  ];

  for (const [descricao, posicao, idExistente] of cenarios) {
    it(`desfaz tudo quando falha ${descricao}`, async () => {
      const carteira = await seedWallet("100.00");
      const comando = comandoDeAposta(carteira);

      const erro = await capturar(() =>
        useCase({ na: posicao, id: idExistente(carteira) }).execute(comando),
      );

      expect(erro).toBeInstanceOf(Error);

      expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
      expect(await lancamentosDe(carteira.wallet.id)).toBe(1);
      expect(await transacoesDe(carteira.wallet.id)).toHaveLength(1);
      expect(await eventosDe(carteira.wallet.id)).toEqual([]);
    });
  }

  /**
   * As duas linhas de outbox de um `BET` aplicado, uma de cada vez.
   *
   * A segunda é o caso decisivo: quando ela falha, transação, saldo, lançamento
   * e o **primeiro** evento já estavam escritos. Se a atomicidade fosse "grava o
   * dinheiro, depois tenta publicar", este é o cenário que deixaria saldo
   * debitado com metade dos eventos — e é o que RF-23 proíbe.
   */
  const posicoesDeOutbox: ReadonlyArray<[string, number]> = [
    ["a primeira linha da outbox", ID_OUTBOX_PROCESSED],
    ["a segunda linha da outbox, com o dinheiro todo escrito", ID_OUTBOX_BALANCE],
  ];

  for (const [descricao, posicao] of posicoesDeOutbox) {
    it(`desfaz o dinheiro inteiro quando falha ${descricao} (RF-23, EL-06)`, async () => {
      const carteira = await seedWallet("100.00");
      const ocupada = newId();

      // Uma linha de outbox real, só para ocupar o id que o gerador vai devolver
      // na posição escolhida. Evento de verdade, montado pelas mesmas factories
      // do domínio: não há tipo inventado para o teste.
      const evento = WalletBalanceChanged.from(carteira.wallet, carteira.openingEntry, {
        eventId: newId(),
        correlationId: unique("corr"),
        occurredAt: AGORA,
      });

      await new MikroUnitOfWork(orm.em).run((repos) =>
        repos.outbox.insert(OutboxMessage.enqueue({ id: ocupada, event: evento })),
      );

      const erro = await capturar(() =>
        useCase({ na: posicao, id: ocupada }).execute(comandoDeAposta(carteira)),
      );

      expect(erro).toBeInstanceOf(Error);

      expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
      expect(await lancamentosDe(carteira.wallet.id)).toBe(1);
      expect(await transacoesDe(carteira.wallet.id)).toHaveLength(1);

      // Sobrou exatamente a linha que já estava lá — nenhum evento do
      // processamento abortado ficou para trás.
      const outbox = await orm.em
        .fork()
        .find(
          outboxMessageRowSchema,
          { aggregateId: carteira.wallet.id },
          { disableIdentityMap: true },
        );

      expect(outbox.map((row) => row.id)).toEqual([ocupada]);
    });
  }

  it("desfaz tudo quando a inbox recusa a mensagem já registrada (RF-19)", async () => {
    const carteira = await seedWallet("100.00");
    const consumerName = unique("consumer");
    const messageId = unique("sqs");

    const primeira = await useCase().execute(
      comandoDeAposta(carteira, { inbox: { consumerName, messageId } }),
    );
    expect(await saldoDe(carteira.wallet.id)).toBe("75.00");

    // Mesma entrega, operação de negócio diferente: a chave primária da inbox
    // (D-025) recusa o segundo registro e leva a transação inteira junto. Quem
    // transforma isso em "pular e dar ack" é o consumidor de E-11 (RF-19).
    const erro = await capturar(() =>
      useCase().execute(comandoDeAposta(carteira, { inbox: { consumerName, messageId } })),
    );

    expect(erro).toBeInstanceOf(Error);

    expect(await saldoDe(carteira.wallet.id)).toBe("75.00");
    expect(await lancamentosDe(carteira.wallet.id)).toBe(2);
    expect(await transacoesDe(carteira.wallet.id)).toHaveLength(2);
    expect(await eventosDe(primeira.transactionId)).toEqual(["WagerTransactionProcessed"]);
  });

  it("a invariante final fecha depois de todos os cenários de falha", async () => {
    // `wallet.balance == saldo reconstruído pelo ledger` (§13.4). Vale mesmo com
    // todas as falhas acima tendo acontecido — se algum rollback tivesse deixado
    // metade escrita, as duas contas divergiriam aqui.
    const carteira = await seedWallet("100.00");
    await useCase().execute(comandoDeAposta(carteira));
    await useCase().execute(comandoDeAposta(carteira, { money: { amount: "10.00", currency: "BRL" } }));

    const lancamentos = await orm.em
      .fork()
      .find(
        walletLedgerEntryRowSchema,
        { walletId: carteira.wallet.id },
        { disableIdentityMap: true },
      );

    const reconstruido = lancamentos.reduce(
      (saldo, row) =>
        row.direction === LedgerDirection.Credit
          ? saldo.add(brl(row.amount))
          : saldo.subtract(brl(row.amount)),
      Money.zero("BRL"),
    );

    expect(await saldoDe(carteira.wallet.id)).toBe(reconstruido.toJSON().amount);
  });
});

// =============================================================================
// E-12 — as quatro operações restantes (RT-03)
//
// RN-01 (`BET`) está acima, desde E-07. Daqui para baixo estão `WIN`, `LOSS`,
// `REFUND` e `ROLLBACK`, com a taxonomia de D-007 completa: cada `failureCode`
// de reversão tem um teste que prova qual situação o produz.
//
// Tudo contra PostgreSQL real. Não existe repositório falso nesta suíte, e não é
// só por EL-08: metade das regras desta etapa — unicidade de reversão (D-024),
// resolução por `(providerId, externalTransactionId)` — só existe no banco.
// =============================================================================

/** Executa um comando e devolve **o comando junto**, para poder referenciá-lo. */
async function aplicar(
  carteira: Carteira,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): Promise<{
  comando: ProcessWagerTransactionCommand;
  resultado: ProcessWagerTransactionResult;
}> {
  const comando = comandoDeAposta(carteira, overrides);

  return { comando, resultado: await useCase().execute(comando) };
}

/**
 * Monta a reversão de um comando já aplicado.
 *
 * Copia rodada e valor da referência de propósito: são justamente os campos que
 * RN-07 e RN-10 exigem iguais, então o caminho feliz sai de graça e cada teste
 * de rejeição sobrescreve **um** campo — o que ele está exercitando.
 */
function comandoDeReversao(
  carteira: Carteira,
  kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  referencia: ProcessWagerTransactionCommand,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  return comandoDeAposta(carteira, {
    kind,
    roundId: referencia.roundId,
    money: referencia.money,
    referenceExternalTransactionId: referencia.externalTransactionId,
    ...overrides,
  });
}

/** A linha da transação, como o banco a guardou. */
async function transacaoDe(id: string): Promise<WagerTransactionRow | undefined> {
  const [row] = await orm.em
    .fork()
    .find(wagerTransactionRowSchema, { id }, { disableIdentityMap: true });

  return row;
}

async function versaoDe(walletId: string): Promise<number | undefined> {
  const wallet = await new MikroWalletRepository(orm.em.fork()).findById(walletId);

  return wallet?.version;
}

describe("WIN (RN-02)", () => {
  it("credita o saldo, lança um CREDIT e publica os dois eventos", async () => {
    const carteira = await seedWallet("100.00");

    const { resultado } = await aplicar(carteira, {
      kind: WagerTransactionKind.Win,
      money: { amount: "30.00", currency: "BRL" },
    });

    expect(resultado.status).toBe(WagerTransactionStatus.Processed);
    expect(resultado.balance.amount).toBe("130.00");
    expect(await saldoDe(carteira.wallet.id)).toBe("130.00");

    const lancamentos = await orm.em
      .fork()
      .find(
        walletLedgerEntryRowSchema,
        { transactionId: resultado.transactionId },
        { disableIdentityMap: true },
      );

    expect(lancamentos).toHaveLength(1);
    expect(lancamentos[0]?.direction).toBe(LedgerDirection.Credit);
    expect(lancamentos[0]?.balanceAfter).toBe("130.00");

    expect(await eventosDe(resultado.transactionId)).toEqual(["WagerTransactionProcessed"]);
  });

  it("a referência do WIN é informativa: gravada, não resolvida (D-049)", async () => {
    const carteira = await seedWallet("100.00");

    // Referência que **não existe**. Um `REFUND` com esta referência iria para
    // `PENDING_REFERENCE`; o `WIN` credita na hora, porque o valor do prêmio vem
    // no próprio payload e não deriva da `BET`.
    const { resultado } = await aplicar(carteira, {
      kind: WagerTransactionKind.Win,
      money: { amount: "30.00", currency: "BRL" },
      referenceExternalTransactionId: "ext-que-nunca-existiu",
    });

    const transacao = await transacaoDe(resultado.transactionId);

    expect(resultado.status).toBe(WagerTransactionStatus.Processed);
    expect(transacao?.referenceExternalTransactionId).toBe("ext-que-nunca-existiu");
    // O ponto de D-049: o vínculo interno fica nulo, então o `WIN` não ocupa a
    // vaga de `uq_wager_transactions_reversal_once` e dois `WIN` sobre a mesma
    // `BET` não colidem no banco.
    expect(transacao?.referenceTransactionId).toBeNull();
  });
});

describe("LOSS (RN-03, RF-25)", () => {
  it("registra o resultado sem mover saldo e sem gerar lançamento", async () => {
    const carteira = await seedWallet("100.00");
    const lancamentosAntes = await lancamentosDe(carteira.wallet.id);
    const versaoAntes = await versaoDe(carteira.wallet.id);

    const { resultado } = await aplicar(carteira, {
      kind: WagerTransactionKind.Loss,
      money: { amount: "25.00", currency: "BRL" },
    });

    expect(resultado.status).toBe(WagerTransactionStatus.Processed);
    expect(resultado.balance.amount).toBe("100.00");
    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
    expect(await lancamentosDe(carteira.wallet.id)).toBe(lancamentosAntes);
    // RF-02: `version` incrementa **somente** quando o saldo muda. `LOSS` não
    // reescreve a wallet, então a linha nem é tocada.
    expect(await versaoDe(carteira.wallet.id)).toBe(versaoAntes);
  });

  it("publica WagerTransactionProcessed e **não** WalletBalanceChanged", async () => {
    const carteira = await seedWallet("100.00");
    const eventosDaWalletAntes = await eventosDe(carteira.wallet.id);

    const { resultado } = await aplicar(carteira, {
      kind: WagerTransactionKind.Loss,
      money: { amount: "25.00", currency: "BRL" },
    });

    // A letra de RF-25: "qualquer transação aplicada, **inclusive `LOSS`**" para
    // o primeiro; "**somente** quando o saldo muda" para o segundo.
    expect(await eventosDe(resultado.transactionId)).toEqual(["WagerTransactionProcessed"]);
    expect(await eventosDe(carteira.wallet.id)).toEqual(eventosDaWalletAntes);
  });

  it("grava o saldo observado, que é o mesmo de antes (RN-12, D-030)", async () => {
    const carteira = await seedWallet("100.00");

    const { resultado } = await aplicar(carteira, {
      kind: WagerTransactionKind.Loss,
      money: { amount: "25.00", currency: "BRL" },
    });
    const transacao = await transacaoDe(resultado.transactionId);

    // É exatamente o caso que D-030 cita: sem lançamento, não haveria como
    // reconstruir este saldo pelo ledger no replay.
    expect(transacao?.observedBalance).toBe("100.00");
    expect(transacao?.observedBalanceCurrency).toBe("BRL");
  });
});

describe("REFUND e ROLLBACK aplicados (RN-04, RN-05, RN-07)", () => {
  it("REFUND resolve a BET por (providerId, ref), credita e grava o vínculo", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta, resultado: apostada } = await aplicar(carteira);

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta),
    );
    const transacao = await transacaoDe(estorno.transactionId);

    expect(estorno.status).toBe(WagerTransactionStatus.Processed);
    expect(estorno.balance.amount).toBe("100.00");
    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
    // RN-07: o id **interno** da referência, resolvido a partir do id externo
    // que o provedor mandou.
    expect(transacao?.referenceTransactionId).toBe(apostada.transactionId);
  });

  it("ROLLBACK de BET credita — o inverso da referência (RN-05)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteira);

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Rollback, aposta),
    );
    const lancamentos = await orm.em
      .fork()
      .find(
        walletLedgerEntryRowSchema,
        { transactionId: estorno.transactionId },
        { disableIdentityMap: true },
      );

    expect(estorno.status).toBe(WagerTransactionStatus.Processed);
    expect(lancamentos[0]?.direction).toBe(LedgerDirection.Credit);
    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
  });

  it("ROLLBACK de WIN **debita** — a direção vem da referência, não do kind", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: premio } = await aplicar(carteira, {
      kind: WagerTransactionKind.Win,
      money: { amount: "40.00", currency: "BRL" },
    });

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Rollback, premio),
    );
    const lancamentos = await orm.em
      .fork()
      .find(
        walletLedgerEntryRowSchema,
        { transactionId: estorno.transactionId },
        { disableIdentityMap: true },
      );

    // É o teste que distingue RN-05 de RN-04: um `REFUND` sempre credita, um
    // `ROLLBACK` faz o oposto do que a referência fez.
    expect(lancamentos[0]?.direction).toBe(LedgerDirection.Debit);
    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
  });
});

describe("Rejeições de reversão — a taxonomia de D-007", () => {
  it("REFERENCE_MISMATCH: referência de outra wallet (RN-07)", async () => {
    const carteiraA = await seedWallet("100.00");
    const carteiraB = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteiraA);

    const estorno = await useCase().execute(
      comandoDeReversao(carteiraB, WagerTransactionKind.Refund, aposta),
    );

    expect(estorno.status).toBe(WagerTransactionStatus.Rejected);
    expect(estorno.failureCode).toBe(BusinessFailureCode.ReferenceMismatch);
    expect(await saldoDe(carteiraB.wallet.id)).toBe("100.00");
  });

  it("REFERENCE_MISMATCH: referência de outra rodada (RN-07)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteira);

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta, {
        roundId: unique("outra-rodada"),
      }),
    );

    expect(estorno.failureCode).toBe(BusinessFailureCode.ReferenceMismatch);
  });

  it("REFERENCE_MISMATCH: referência REJECTED nunca vai virar PROCESSED (D-050)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: recusada, resultado } = await aplicar(carteira, {
      money: { amount: "500.00", currency: "BRL" },
    });

    expect(resultado.status).toBe(WagerTransactionStatus.Rejected);

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, recusada),
    );

    // O lado "rejeita quem não pode mais" de D-050: `REJECTED` é terminal por
    // D-013, então esperar o TTL de 15 min seria esperar por nada.
    expect(estorno.status).toBe(WagerTransactionStatus.Rejected);
    expect(estorno.failureCode).toBe(BusinessFailureCode.ReferenceMismatch);
  });

  it("INVALID_REFERENCE_KIND: REFUND só reverte BET (RN-08)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: premio } = await aplicar(carteira, {
      kind: WagerTransactionKind.Win,
      money: { amount: "30.00", currency: "BRL" },
    });

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, premio),
    );

    expect(estorno.failureCode).toBe(BusinessFailureCode.InvalidReferenceKind);
  });

  it("INVALID_REFERENCE_KIND: ROLLBACK não reverte LOSS (RN-08)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: derrota } = await aplicar(carteira, {
      kind: WagerTransactionKind.Loss,
      money: { amount: "30.00", currency: "BRL" },
    });

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Rollback, derrota),
    );

    // Também é o que impede `ledgerDirectionFor` de ser chamada com um `LOSS`,
    // que lançaria `NoLedgerDirectionError` — erro de programação, não `422`.
    expect(estorno.failureCode).toBe(BusinessFailureCode.InvalidReferenceKind);
  });

  it("AMOUNT_MISMATCH: reversão parcial está fora de escopo (RN-10)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteira);

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta, {
        money: { amount: "10.00", currency: "BRL" },
      }),
    );

    expect(estorno.failureCode).toBe(BusinessFailureCode.AmountMismatch);
    expect(await saldoDe(carteira.wallet.id)).toBe("75.00");
  });

  it("ALREADY_REVERSED: a mesma referência não é revertida duas vezes (RN-09)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteira);

    const primeiro = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta),
    );
    const segundo = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta),
    );

    expect(primeiro.status).toBe(WagerTransactionStatus.Processed);
    expect(segundo.status).toBe(WagerTransactionStatus.Rejected);
    expect(segundo.failureCode).toBe(BusinessFailureCode.AlreadyReversed);
    // O segundo estorno não creditou de novo: o saldo é o de um estorno só.
    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
  });

  it("RN-09 conta por tipo: um ROLLBACK ainda cabe depois de um REFUND", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteira);

    await useCase().execute(comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta));
    const rollback = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Rollback, aposta),
    );

    // RN-09 proíbe reverter duas vezes **pelo mesmo tipo**, e o índice de D-024
    // é `(reference_transaction_id, kind)` justamente por isso. Não é o desenho
    // mais provável em produção, mas é o que a regra escrita permite — e o teste
    // existe para que uma mudança no índice não altere a regra sem aviso.
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
  });

  it("uma tentativa REJECTED não queima a referência (D-024, parcial sobre PROCESSED)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteira);

    const errado = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta, {
        money: { amount: "10.00", currency: "BRL" },
      }),
    );
    const certo = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta),
    );

    expect(errado.status).toBe(WagerTransactionStatus.Rejected);
    expect(certo.status).toBe(WagerTransactionStatus.Processed);
  });

  it("INSUFFICIENT_FUNDS_ON_REVERSAL é distinto de INSUFFICIENT_FUNDS (RN-16)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: premio } = await aplicar(carteira, {
      kind: WagerTransactionKind.Win,
      money: { amount: "50.00", currency: "BRL" },
    });
    // Gasta o prêmio: agora estornar o `WIN` produziria saldo negativo.
    await aplicar(carteira, { money: { amount: "140.00", currency: "BRL" } });

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Rollback, premio),
    );

    expect(estorno.status).toBe(WagerTransactionStatus.Rejected);
    expect(estorno.failureCode).toBe(BusinessFailureCode.InsufficientFundsOnReversal);
    expect(estorno.failureCode).not.toBe(BusinessFailureCode.InsufficientFunds);
    expect(await saldoDe(carteira.wallet.id)).toBe("10.00");
  });

  it("D-051: com duas regras violadas, prevalece a que o provedor consegue corrigir", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: derrota } = await aplicar(carteira, {
      kind: WagerTransactionKind.Loss,
      money: { amount: "30.00", currency: "BRL" },
    });

    // Kind inválido (RN-08) **e** valor diferente (RN-10) ao mesmo tempo.
    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Rollback, derrota, {
        money: { amount: "11.00", currency: "BRL" },
      }),
    );

    expect(estorno.failureCode).toBe(BusinessFailureCode.InvalidReferenceKind);
  });

  it("rejeição de reversão não move saldo, não gera ledger e publica o evento (RN-11, RF-25)", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteira);
    const lancamentosAntes = await lancamentosDe(carteira.wallet.id);

    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta, {
        money: { amount: "10.00", currency: "BRL" },
      }),
    );

    expect(await saldoDe(carteira.wallet.id)).toBe("75.00");
    expect(await lancamentosDe(carteira.wallet.id)).toBe(lancamentosAntes);
    expect(await eventosDe(estorno.transactionId)).toEqual(["WagerTransactionRejected"]);
  });
});

describe("RN-15 — referência que ainda não chegou", () => {
  it("referência inexistente vira PENDING_REFERENCE, não rejeição", async () => {
    const carteira = await seedWallet("100.00");
    const lancamentosAntes = await lancamentosDe(carteira.wallet.id);

    const estorno = await useCase().execute(
      comandoDeAposta(carteira, {
        kind: WagerTransactionKind.Rollback,
        money: { amount: "25.00", currency: "BRL" },
        referenceExternalTransactionId: unique("ext-que-ainda-nao-chegou"),
      }),
    );
    const transacao = await transacaoDe(estorno.transactionId);

    expect(estorno.status).toBe(WagerTransactionStatus.PendingReference);
    expect(estorno.failureCode).toBeUndefined();
    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
    expect(await lancamentosDe(carteira.wallet.id)).toBe(lancamentosAntes);
    // Aguardar não é desfecho (D-030): o saldo observado fica nulo, e as colunas
    // de retry ficam no default da tabela — o dono delas é E-13 (D-029).
    expect(transacao?.observedBalance).toBeNull();
    expect(transacao?.processedAt).toBeNull();
  });

  it("publica WagerTransactionPendingReference (RF-25)", async () => {
    const carteira = await seedWallet("100.00");

    const estorno = await useCase().execute(
      comandoDeAposta(carteira, {
        kind: WagerTransactionKind.Refund,
        money: { amount: "25.00", currency: "BRL" },
        referenceExternalTransactionId: unique("ext-ausente"),
      }),
    );

    // Sem este evento, o silêncio entre a submissão e o desfecho seria
    // indistinguível de mensagem perdida.
    expect(await eventosDe(estorno.transactionId)).toEqual([
      "WagerTransactionPendingReference",
    ]);
  });

  it("referência que está ela própria aguardando também espera (D-050)", async () => {
    const carteira = await seedWallet("100.00");

    const refundPendente = comandoDeAposta(carteira, {
      kind: WagerTransactionKind.Refund,
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: unique("ext-ausente"),
    });
    const pendente = await useCase().execute(refundPendente);

    expect(pendente.status).toBe(WagerTransactionStatus.PendingReference);

    const rollback = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Rollback, refundPendente),
    );

    // O lado "espera quem ainda pode" de D-050: a cadeia fora de ordem é
    // legítima, e rejeitá-la por segundos de diferença desperdiçaria a máquina
    // de `PENDING_REFERENCE` que RF-26 mandou construir.
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

describe("RN-09 no banco — o índice parcial é a garantia (D-024, RI-09)", () => {
  it("uma segunda reversão PROCESSED da mesma referência é recusada pelo PostgreSQL", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteira);
    const estorno = await useCase().execute(
      comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta),
    );

    const transacao = await transacaoDe(estorno.transactionId);
    const referenceTransactionId = transacao?.referenceTransactionId ?? "";

    // Escrita por fora do use case, de propósito: o objetivo é provar que a
    // invariante sobrevive **sem** o caminho de negócio — é isso que RI-09 pede,
    // e é o que continua valendo quando duas instâncias perdem a corrida juntas.
    const duplicata = WagerTransaction.create({
      id: newId(),
      providerId: PROVIDER,
      externalTransactionId: unique("ext-duplicata"),
      idempotencyKey: unique("idem-duplicata"),
      payloadHash: "0".repeat(64),
      correlationId: unique("corr-duplicata"),
      walletId: carteira.wallet.id,
      playerId: carteira.wallet.playerId,
      roundId: aposta.roundId,
      gameId: aposta.gameId,
      kind: WagerTransactionKind.Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: aposta.externalTransactionId,
      createdAt: AGORA,
    });
    duplicata.markProcessed(referenceTransactionId, brl("125.00"), AGORA);

    const erro = await capturar(() =>
      new MikroUnitOfWork(orm.em).run(async (repos) => {
        await repos.transactions.insert(duplicata);
      }),
    );

    expect(erro).toBeInstanceOf(Error);
    expect((erro as { constraint?: string }).constraint).toBe(
      "uq_wager_transactions_reversal_once",
    );
  });

  it("a invariante do ledger fecha depois de todas as operações de E-12", async () => {
    const carteira = await seedWallet("100.00");
    const { comando: aposta } = await aplicar(carteira);

    await aplicar(carteira, {
      kind: WagerTransactionKind.Win,
      money: { amount: "40.00", currency: "BRL" },
    });
    await aplicar(carteira, {
      kind: WagerTransactionKind.Loss,
      money: { amount: "15.00", currency: "BRL" },
    });
    await useCase().execute(comandoDeReversao(carteira, WagerTransactionKind.Refund, aposta));

    // §6.4: saldo materializado == saldo reconstruído pelo ledger. `LOSS` e as
    // rejeições acima não têm lançamento, e é justamente por isso que a conta
    // fechar aqui significa alguma coisa.
    await expectLedgerReconciles(orm, carteira.wallet.id);
  });
});
