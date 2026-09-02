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
import { UnsupportedKindError } from "../../src/application/errors/unsupported-kind-error.ts";
import { WalletNotFoundError } from "../../src/application/errors/wallet-not-found-error.ts";
import type { Clock } from "../../src/application/ports/clock.ts";
import type { IdGenerator } from "../../src/application/ports/id-generator.ts";
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from "../../src/application/process-wager-transaction.ts";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.ts";
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

  it("kind fora de BET falha antes de abrir transação (escopo de E-07)", async () => {
    const carteira = await seedWallet("100.00");

    const erro = await capturar(() =>
      useCase().execute(comandoDeAposta(carteira, { kind: WagerTransactionKind.Win })),
    );

    expect(erro).toBeInstanceOf(UnsupportedKindError);
    expect(await transacoesDe(carteira.wallet.id)).toHaveLength(1);
    expect(await saldoDe(carteira.wallet.id)).toBe("100.00");
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
