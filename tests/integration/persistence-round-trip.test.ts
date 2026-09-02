/**
 * E-06 — round-trip de cada agregado contra o PostgreSQL real.
 *
 * É o critério de conclusão da etapa: persistir, reidratar e comparar. O que se
 * prova aqui não é que o MikroORM funciona — é que a **tradução** de D-026 não
 * perde nada no caminho. Um campo esquecido no mapper compila, passa no lint e
 * some em silêncio; só a volta pelo banco o denuncia.
 *
 * Três garantias específicas moram neste arquivo:
 *
 *  - **EL-01** — o driver devolve `numeric` como string, e o valor no teto de
 *    `numeric(19,2)` volta com todos os 19 dígitos. Um type parser registrado
 *    por engano converteria para ponto flutuante sem lançar nada (D-004).
 *  - **EL-07** — ler um lançamento do ledger não deixa entidade rastreada, então
 *    nenhum `flush` pode emitir `UPDATE` sobre a tabela imutável (D-023, D-028).
 *  - **D-029** — `reference_attempts` e `next_reference_attempt_at` continuam
 *    intocadas depois de `insert` e de `update`, porque o repositório não as
 *    escreve.
 *
 * As escritas acontecem dentro de `em.transactional()` e as leituras num `em`
 * novo: assim a comparação é sempre contra o que o banco guardou, nunca contra
 * um objeto que sobrou em memória.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.ts";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import { InboxMessage } from "../../src/domain/inbox-message.ts";
import { LedgerDirection } from "../../src/domain/ledger-direction.ts";
import { Money } from "../../src/domain/money.ts";
import { OutboxMessage } from "../../src/domain/outbox-message.ts";
import type { RetryPolicy } from "../../src/domain/retry-policy.ts";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction.ts";
import type { WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { MikroInboxRepository } from "../../src/infrastructure/persistence/repositories/mikro-inbox-repository.ts";
import { MikroOutboxRepository } from "../../src/infrastructure/persistence/repositories/mikro-outbox-repository.ts";
import { MikroWagerTransactionRepository } from "../../src/infrastructure/persistence/repositories/mikro-wager-transaction-repository.ts";
import { MikroWalletLedgerRepository } from "../../src/infrastructure/persistence/repositories/mikro-wallet-ledger-repository.ts";
import { MikroWalletRepository } from "../../src/infrastructure/persistence/repositories/mikro-wallet-repository.ts";
import { walletLedgerEntryRowSchema } from "../../src/infrastructure/persistence/rows/wallet-ledger-entry-row.ts";
import { walletRowSchema } from "../../src/infrastructure/persistence/rows/wallet-row.ts";

let orm: MikroORM;

const ABERTURA = new Date("2026-09-01T12:00:00.000Z");
const DEPOIS = new Date("2026-09-01T12:30:00.000Z");

/** Teto de `numeric(19,2)`: 17 dígitos inteiros e 2 decimais (D-004). */
const MAIOR_VALOR = `${"9".repeat(17)}.99`;

/** `char(64)` — a largura de um SHA-256 em hexadecimal (D-005). */
const HASH = "a".repeat(64);
const PROVIDER = "provider-a";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

/** UUIDv7 (D-014). `crypto.randomUUID()` é v4 e não serve como id neste projeto. */
function newId(): string {
  return Bun.randomUUIDv7();
}

/** Sufixo único, para que um teste não falhe por unicidade que outro exercitou. */
function unique(prefix: string): string {
  return `${prefix}-${newId()}`;
}

interface Repositories {
  em: EntityManager;
  wallets: MikroWalletRepository;
  transactions: MikroWagerTransactionRepository;
  ledger: MikroWalletLedgerRepository;
  inbox: MikroInboxRepository;
  outbox: MikroOutboxRepository;
}

/**
 * Monta os cinco repositórios sobre um `EntityManager`.
 *
 * É a forma que D-028 impõe: repositório é objeto de transação, construído com
 * o `em` que vale ali. E-07 vai fazer exatamente isto dentro do use case.
 */
function repositoriesOn(em: EntityManager): Repositories {
  return {
    em,
    wallets: new MikroWalletRepository(em),
    transactions: new MikroWagerTransactionRepository(em),
    ledger: new MikroWalletLedgerRepository(em),
    inbox: new MikroInboxRepository(em),
    outbox: new MikroOutboxRepository(em),
  };
}

/** Repositórios num `em` novo — a leitura vem do banco, não de cache do anterior. */
function readers(): Repositories {
  return repositoriesOn(orm.em.fork());
}

/** Escrita dentro de uma transação, como o use case de E-07 vai fazer (RF-23). */
async function write<T>(scenario: (repos: Repositories) => Promise<T>): Promise<T> {
  return orm.em.transactional(async (em) => scenario(repositoriesOn(em)));
}

/** SQL cru, para inspecionar colunas que o mapeamento deliberadamente não lê. */
async function sql(
  query: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.getConnection().execute<Record<string, unknown>[]>(query, params);
}

/** Uma transação de aposta em `PENDING`, pronta para persistir. */
function newTransaction(
  walletId: string,
  playerId: string,
  kind: WagerTransactionKind,
  amount: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: newId(),
    providerId: PROVIDER,
    externalTransactionId: unique("ext"),
    idempotencyKey: unique("idem"),
    payloadHash: HASH,
    walletId,
    playerId,
    roundId: unique("round"),
    gameId: "game-1",
    kind,
    money: brl(amount),
    createdAt: ABERTURA,
  });
}

interface WalletSeed {
  wallet: Wallet;
  openingTransaction: WagerTransaction;
  openingEntry: WalletLedgerEntry;
}

/**
 * Abre uma wallet com saldo, junto da `OPENING` e do lançamento de abertura (RF-08).
 *
 * A ordem dos `insert` é a das chaves estrangeiras — wallet, transação,
 * lançamento — e **é a ordem escrita aqui**. Foi o que D-028 comprou ao
 * dispensar o Unit of Work: sem relações declaradas entre os modelos de linha, o
 * ordenador do MikroORM não teria como saber disso, e a falha seria um `23503`
 * intermitente em vez de uma linha de código legível.
 */
async function seedWallet(amount = "100.00"): Promise<WalletSeed> {
  const walletId = newId();
  const openingTransactionId = newId();
  const playerId = unique("player");

  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: brl(amount),
    openingTransactionId,
    openingEntryId: newId(),
    at: ABERTURA,
  });

  const openingTransaction = WagerTransaction.create({
    id: openingTransactionId,
    providerId: PROVIDER,
    externalTransactionId: unique("ext"),
    idempotencyKey: unique("idem"),
    payloadHash: HASH,
    walletId,
    playerId,
    roundId: unique("round"),
    gameId: "game-1",
    kind: WagerTransactionKind.Opening,
    money: brl(amount),
    createdAt: ABERTURA,
  });

  await write(async (repos) => {
    await repos.wallets.insert(wallet);
    await repos.transactions.insert(openingTransaction);
    await repos.ledger.insert(openingEntry!);
  });

  return { wallet, openingTransaction, openingEntry: openingEntry! };
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  // Estado conhecido: reverte o que existir e aplica do zero. Uma execução
  // interrompida antes não pode deixar meia migration para o próximo run.
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
});

afterAll(async () => {
  await orm.close(true);
});

describe("dinheiro atravessa o driver como texto (D-004, EL-01)", () => {
  it("o driver devolve numeric como string, não number", async () => {
    const { wallet } = await seedWallet("100.00");

    const rows = await sql(`select balance from wallets where id = ?`, [wallet.id]);

    // A asserção é sobre o **tipo**, não sobre o valor: `100` e `"100.00"`
    // parecem igualmente certos num log, e é essa semelhança que faz um type
    // parser registrado por engano passar despercebido por meses (D-004).
    expect(typeof rows[0]?.balance).toBe("string");
    expect(rows[0]?.balance).toBe("100.00");
  });

  it("a leitura mapeada também entrega string — nenhum tipo do ORM converte", async () => {
    const { wallet } = await seedWallet("42.50");

    const row = await orm.em
      .fork()
      .findOne(walletRowSchema, { id: wallet.id }, { disableIdentityMap: true });

    expect(typeof row?.balance).toBe("string");
    expect(row?.balance).toBe("42.50");
  });

  it("preserva os 19 dígitos do teto de numeric(19,2), onde um float perderia", async () => {
    // Um `double` tem ~15–17 dígitos significativos e arredondaria em silêncio.
    // Este é o teste que separa "guarda dinheiro" de "guarda um número parecido
    // com dinheiro", e ele passa de ponta a ponta: domínio → coluna → domínio.
    const { wallet } = await seedWallet(MAIOR_VALOR);

    const lida = await readers().wallets.findById(wallet.id);

    expect(lida?.balance.toJSON().amount).toBe(MAIOR_VALOR);
  });
});

describe("round-trip de Wallet (RF-02)", () => {
  it("reidrata todos os campos como foram persistidos", async () => {
    const { wallet } = await seedWallet("100.00");

    const lida = await readers().wallets.findById(wallet.id);

    expect(lida).toBeDefined();
    expect(lida?.id).toBe(wallet.id);
    expect(lida?.playerId).toBe(wallet.playerId);
    expect(lida?.currency).toBe("BRL");
    expect(lida?.balance.equals(wallet.balance)).toBe(true);
    expect(lida?.version).toBe(1);
    expect(lida?.createdAt.getTime()).toBe(ABERTURA.getTime());
    expect(lida?.updatedAt.getTime()).toBe(ABERTURA.getTime());
  });

  it("devolve undefined para wallet inexistente", async () => {
    expect(await readers().wallets.findById(newId())).toBeUndefined();
  });

  it("update escreve saldo, version e updatedAt sem tocar a identidade", async () => {
    const { wallet } = await seedWallet("100.00");
    const aposta = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, "30.00");

    const entry = wallet.debit({
      entryId: newId(),
      transactionId: aposta.id,
      money: brl("30.00"),
      at: DEPOIS,
    });

    await write(async (repos) => {
      await repos.transactions.insert(aposta);
      await repos.wallets.update(wallet);
      await repos.ledger.insert(entry);
    });

    const lida = await readers().wallets.findById(wallet.id);

    expect(lida?.balance.toJSON().amount).toBe("70.00");
    // RF-02: `version` incrementa somente quando o saldo muda.
    expect(lida?.version).toBe(2);
    expect(lida?.updatedAt.getTime()).toBe(DEPOIS.getTime());
    // A lista fechada de `WalletUpdate` (D-028) mantém a identidade intacta.
    expect(lida?.playerId).toBe(wallet.playerId);
    expect(lida?.createdAt.getTime()).toBe(ABERTURA.getTime());
  });
});

describe("round-trip de WagerTransaction (RF-03)", () => {
  it("reidrata identidade, payload e status como foram persistidos", async () => {
    const { wallet } = await seedWallet();
    const aposta = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, "25.00");

    await write((repos) => repos.transactions.insert(aposta));

    const lida = await readers().transactions.findById(aposta.id);

    expect(lida?.id).toBe(aposta.id);
    expect(lida?.providerId).toBe(PROVIDER);
    expect(lida?.externalTransactionId).toBe(aposta.externalTransactionId);
    expect(lida?.idempotencyKey).toBe(aposta.idempotencyKey);
    expect(lida?.payloadHash).toBe(HASH);
    expect(lida?.walletId).toBe(wallet.id);
    expect(lida?.playerId).toBe(wallet.playerId);
    expect(lida?.roundId).toBe(aposta.roundId);
    expect(lida?.gameId).toBe("game-1");
    expect(lida?.kind).toBe(WagerTransactionKind.Bet);
    expect(lida?.money.equals(brl("25.00"))).toBe(true);
    expect(lida?.status).toBe(WagerTransactionStatus.Pending);
    expect(lida?.createdAt.getTime()).toBe(ABERTURA.getTime());
    // Ausência no banco é `NULL`; no domínio é `undefined`. O mapper traduz.
    expect(lida?.referenceExternalTransactionId).toBeUndefined();
    expect(lida?.failureCode).toBeUndefined();
    expect(lida?.processedAt).toBeUndefined();
    // Sem desfecho, sem saldo observado (D-030). O par de colunas nulas volta
    // como `undefined`, na mesma fronteira que traduz os outros nuláveis.
    expect(lida?.observedBalance).toBeUndefined();
  });

  it("preserva a referência externa de um REFUND (RN-06)", async () => {
    const { wallet } = await seedWallet();
    const referencia = unique("ext-origem");

    const refund = WagerTransaction.create({
      id: newId(),
      providerId: PROVIDER,
      externalTransactionId: unique("ext"),
      idempotencyKey: unique("idem"),
      payloadHash: HASH,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: unique("round"),
      gameId: "game-1",
      kind: WagerTransactionKind.Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: referencia,
      createdAt: ABERTURA,
    });

    await write((repos) => repos.transactions.insert(refund));

    const lida = await readers().transactions.findById(refund.id);

    expect(lida?.referenceExternalTransactionId).toBe(referencia);
    expect(lida?.requiresReference()).toBe(true);
  });

  it("update persiste markProcessed com a referência interna resolvida", async () => {
    const { wallet, openingTransaction } = await seedWallet();
    const rollback = newTransaction(
      wallet.id,
      wallet.playerId,
      WagerTransactionKind.Win,
      "10.00",
    );

    await write((repos) => repos.transactions.insert(rollback));

    rollback.markProcessed(openingTransaction.id, brl("110.00"), DEPOIS);
    await write((repos) => repos.transactions.update(rollback));

    const lida = await readers().transactions.findById(rollback.id);

    expect(lida?.status).toBe(WagerTransactionStatus.Processed);
    expect(lida?.referenceTransactionId).toBe(openingTransaction.id);
    expect(lida?.processedAt?.getTime()).toBe(DEPOIS.getTime());
    expect(lida?.isTerminal()).toBe(true);
    // D-030: o saldo observado volta do banco como o valor exato do desfecho —
    // é ele que RN-12 devolve num replay, e um `update` que o esquecesse deixaria
    // a coluna nula sem quebrar nenhuma outra asserção.
    expect(lida?.observedBalance?.equals(brl("110.00"))).toBe(true);
  });

  it("update persiste reject com o código de negócio (RN-17, D-007)", async () => {
    const { wallet } = await seedWallet();
    const aposta = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, "80.00");

    await write((repos) => repos.transactions.insert(aposta));

    aposta.reject(BusinessFailureCode.InsufficientFunds, brl("50.00"));
    await write((repos) => repos.transactions.update(aposta));

    const lida = await readers().transactions.findById(aposta.id);

    expect(lida?.status).toBe(WagerTransactionStatus.Rejected);
    expect(lida?.failureCode).toBe(BusinessFailureCode.InsufficientFunds);
    // A rejeição não move saldo (RN-11), mas responde um — e o replay repete
    // esta resposta, não o saldo atual (RN-12, D-030).
    expect(lida?.observedBalance?.equals(brl("50.00"))).toBe(true);
  });

  it("não escreve as colunas de retry de referência (D-029)", async () => {
    const { wallet } = await seedWallet();
    const aposta = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, "10.00");

    await write((repos) => repos.transactions.insert(aposta));
    const depoisDoInsert = await sql(
      `select reference_attempts, next_reference_attempt_at
         from wager_transactions where id = ?`,
      [aposta.id],
    );

    aposta.markPendingReference();
    await write((repos) => repos.transactions.update(aposta));
    const depoisDoUpdate = await sql(
      `select reference_attempts, next_reference_attempt_at
         from wager_transactions where id = ?`,
      [aposta.id],
    );

    // O `insert` omite as colunas e vale o default da tabela; o `update` escreve
    // a lista fechada de `WagerTransactionUpdate` e não passa por elas. É o que
    // vai impedir um `update` de status de apagar o trabalho do worker de E-13.
    expect(depoisDoInsert[0]?.reference_attempts).toBe(0);
    expect(depoisDoInsert[0]?.next_reference_attempt_at).toBeNull();
    expect(depoisDoUpdate[0]?.reference_attempts).toBe(0);
    expect(depoisDoUpdate[0]?.next_reference_attempt_at).toBeNull();
  });
});

describe("round-trip de WalletLedgerEntry (RF-04, EL-07)", () => {
  it("reidrata o lançamento de abertura com a aritmética fechando", async () => {
    const { wallet, openingTransaction, openingEntry } = await seedWallet("100.00");

    const lido = await readers().ledger.findById(openingEntry.id);

    expect(lido?.id).toBe(openingEntry.id);
    expect(lido?.walletId).toBe(wallet.id);
    expect(lido?.transactionId).toBe(openingTransaction.id);
    expect(lido?.direction).toBe(LedgerDirection.Credit);
    expect(lido?.money.equals(brl("100.00"))).toBe(true);
    expect(lido?.balanceBefore.equals(Money.zero("BRL"))).toBe(true);
    expect(lido?.balanceAfter.equals(brl("100.00"))).toBe(true);
    expect(lido?.createdAt.getTime()).toBe(ABERTURA.getTime());
    // A invariante que RF-16 vai reconciliar, verificada já na volta do banco.
    expect(lido?.isBalanced()).toBe(true);
  });

  it("reidrata um débito com as três colunas monetárias coerentes", async () => {
    const { wallet } = await seedWallet("100.00");
    const aposta = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, "30.00");
    const entry = wallet.debit({
      entryId: newId(),
      transactionId: aposta.id,
      money: brl("30.00"),
      at: DEPOIS,
    });

    await write(async (repos) => {
      await repos.transactions.insert(aposta);
      await repos.wallets.update(wallet);
      await repos.ledger.insert(entry);
    });

    const lido = await readers().ledger.findById(entry.id);

    expect(lido?.direction).toBe(LedgerDirection.Debit);
    expect(lido?.balanceBefore.toJSON().amount).toBe("100.00");
    expect(lido?.balanceAfter.toJSON().amount).toBe("70.00");
    expect(lido?.isBalanced()).toBe(true);
  });

  it("ler um lançamento não deixa entidade rastreada para nenhum flush (EL-07)", async () => {
    const { openingEntry } = await seedWallet();
    const repos = readers();

    const lido = await repos.ledger.findById(openingEntry.id);

    expect(lido).toBeDefined();
    // `disableIdentityMap` (D-028) é o que garante isto. Sem ele a linha ficaria
    // gerenciada, e um `flush()` em qualquer ponto do processo poderia emitir
    // `UPDATE` sobre a tabela que a trigger de D-023 recusa com `P0001`. A
    // trigger deve continuar sendo a rede que ninguém consegue acionar.
    expect(repos.em.getUnitOfWork().getById(walletLedgerEntryRowSchema, openingEntry.id)).toBeUndefined();

    // E, de fato, um flush aqui não tem nada a fazer.
    await repos.em.flush();
  });
});

describe("round-trip de InboxMessage (RF-05, RF-19)", () => {
  it("reidrata pela chave composta e marca o processamento (D-025)", async () => {
    const consumerName = unique("consumer");
    const messageId = unique("sqs-message");
    const message = InboxMessage.receive({
      messageId,
      consumerName,
      payloadHash: HASH,
      receivedAt: ABERTURA,
    });

    await write((repos) => repos.inbox.insert(message));

    const lida = await readers().inbox.findByKey(consumerName, messageId);

    expect(lida?.messageId).toBe(messageId);
    expect(lida?.consumerName).toBe(consumerName);
    expect(lida?.payloadHash).toBe(HASH);
    expect(lida?.receivedAt.getTime()).toBe(ABERTURA.getTime());
    expect(lida?.isProcessed()).toBe(false);

    message.markProcessed(DEPOIS);
    await write((repos) => repos.inbox.update(message));

    const concluida = await readers().inbox.findByKey(consumerName, messageId);

    expect(concluida?.isProcessed()).toBe(true);
    expect(concluida?.processedAt?.getTime()).toBe(DEPOIS.getTime());
  });

  it("a busca é pelo par, não pelo message id sozinho (RF-19)", async () => {
    const messageId = unique("sqs-message");
    const message = InboxMessage.receive({
      messageId,
      consumerName: unique("consumer"),
      payloadHash: HASH,
      receivedAt: ABERTURA,
    });

    await write((repos) => repos.inbox.insert(message));

    // A mesma mensagem para outro consumidor é trabalho legítimo dele, e a
    // dedupe não pode escondê-la — colapsar isso numa chave global faria o
    // segundo consumidor perder a mensagem em silêncio.
    expect(await readers().inbox.findByKey(unique("outro"), messageId)).toBeUndefined();
  });
});

describe("round-trip de OutboxMessage (RF-06, RF-23)", () => {
  /** Política determinística — mesma técnica dos testes de D-022. */
  const policy: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 300_000, random: () => 0.5 };

  async function seedOutbox(): Promise<{ message: OutboxMessage; walletId: string }> {
    const { wallet, openingEntry } = await seedWallet("100.00");

    const event = WalletBalanceChanged.from(wallet, openingEntry, {
      eventId: newId(),
      correlationId: unique("corr"),
      occurredAt: ABERTURA,
    });

    const message = OutboxMessage.enqueue({ id: newId(), event });
    await write((repos) => repos.outbox.insert(message));

    return { message, walletId: wallet.id };
  }

  it("reidrata o envelope e o payload jsonb sem alteração", async () => {
    const { message, walletId } = await seedOutbox();

    const lida = await readers().outbox.findById(message.id);

    expect(lida?.id).toBe(message.id);
    expect(lida?.aggregateId).toBe(walletId);
    expect(lida?.eventType).toBe(message.eventType);
    expect(lida?.occurredAt.getTime()).toBe(ABERTURA.getTime());
    expect(lida?.attempts).toBe(0);
    expect(lida?.isPending()).toBe(true);
    expect(lida?.nextAttemptAt).toBeUndefined();
    expect(lida?.lockedBy).toBeUndefined();
    // O payload precisa voltar idêntico: é ele que o worker de E-10 publica, e
    // ele foi gravado já serializado justamente para não depender do código
    // vigente na hora da republicação.
    expect(lida?.payload).toEqual(message.payload);
  });

  it("update persiste tentativas, agendamento e lease (D-009, D-022)", async () => {
    const { message } = await seedOutbox();

    message.scheduleRetry(ABERTURA, policy);
    await write((repos) => repos.outbox.update(message));

    const lida = await readers().outbox.findById(message.id);

    expect(lida?.attempts).toBe(1);
    expect(lida?.nextAttemptAt?.getTime()).toBe(message.nextAttemptAt?.getTime());
    expect(lida?.isPending()).toBe(true);
  });

  it("update persiste a publicação (RF-24)", async () => {
    const { message } = await seedOutbox();

    message.markPublished(DEPOIS);
    await write((repos) => repos.outbox.update(message));

    const lida = await readers().outbox.findById(message.id);

    expect(lida?.isPending()).toBe(false);
    expect(lida?.publishedAt?.getTime()).toBe(DEPOIS.getTime());
  });
});
