/**
 * RT-08 — migrations e constraints contra o PostgreSQL real.
 *
 * O critério de E-05 é literal: **cada** constraint criada pela migration tem um
 * teste que tenta violá-la e recebe erro do banco. Não é redundância com os
 * testes de domínio de E-02..E-04 — é o oposto deles. Lá se prova que o objeto
 * recusa o estado inválido; aqui se prova que o **banco** recusa, que é o que
 * RI-09 exige e o que continua valendo quando o lock falha, quando duas
 * instâncias corrigem ou quando alguém escreve por fora da aplicação.
 *
 * As asserções são sobre **SQLSTATE e nome da constraint**, nunca sobre a
 * mensagem: mensagem do PostgreSQL é texto livre, muda entre versões menores e
 * transformaria uma atualização de imagem em suíte vermelha. O nome da
 * constraint é o que amarra o teste à linha certa da migration — sem ele, um
 * `23505` qualquer passaria por prova de outra unicidade.
 *
 * Cobre EL-02 (`CHECK (balance >= 0)`), EL-03/EL-04 (unicidade de idempotência
 * persistente), EL-05 (dedupe da inbox), EL-07 (imutabilidade do ledger) e
 * RNF-09 (`down` que funciona).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";

let orm: MikroORM;

/**
 * Executa SQL cru e devolve as linhas como registros soltos.
 *
 * SQL cru é de propósito: E-05 testa o **schema**, e usar o mapeamento de E-06
 * para isso faria o teste passar ou falhar por motivos do ORM. Aqui o único
 * intermediário entre o teste e o PostgreSQL é o driver.
 */
async function sql(
  query: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.getConnection().execute<Record<string, unknown>[]>(query, params);
}

/**
 * Forma do erro que o driver propaga, **confirmada por sonda** contra o
 * PostgreSQL real antes de este teste existir (`AGENTS.md` §2.1).
 *
 * O caminho de `execute()` do MikroORM v7 **não** converte a exceção: o
 * `DatabaseError` do `pg` chega inteiro, com `code` no SQLSTATE e `constraint`
 * com o nome da constraint violada — este último `undefined` em `23502`
 * (not null) e em `P0001` (`raise exception`), que não pertencem a constraint.
 *
 * Os placeholders são `?`, não `$1`: o MikroORM formata a query substituindo o
 * valor citado antes de enviá-la. Também confirmado por execução, não de memória.
 */
interface DriverError {
  readonly code: string;
  readonly constraint?: string | undefined;
}

function isDriverError(error: unknown): error is DriverError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if (!("code" in error) || typeof error.code !== "string") {
    return false;
  }

  // O `pg` sempre traz a chave `constraint`; ela vem `undefined` quando o erro
  // não pertence a constraint nenhuma — `23502` (not null) e `P0001`. Exigir
  // string aqui reprovaria justamente o erro da trigger de EL-07.
  return (
    !("constraint" in error) ||
    typeof error.constraint === "string" ||
    error.constraint === undefined
  );
}

/**
 * Exige que o statement seja recusado pelo banco com o SQLSTATE dado.
 *
 * `constraint` é opcional apenas porque `P0001` não carrega esse campo. Onde
 * existe nome de constraint, ele é passado — é o que impede o teste de aceitar
 * a violação errada como prova.
 */
async function expectRejectedByDatabase(
  statement: () => Promise<unknown>,
  expected: { sqlState: string; constraint?: string },
): Promise<void> {
  let caught: unknown;
  let threw = false;

  try {
    await statement();
  } catch (error) {
    threw = true;
    caught = error;
  }

  expect(threw).toBe(true);

  if (!isDriverError(caught)) {
    throw new Error(`erro sem SQLSTATE — o banco não recusou como esperado: ${String(caught)}`);
  }

  expect(caught.code).toBe(expected.sqlState);

  if (expected.constraint !== undefined) {
    expect(caught.constraint).toBe(expected.constraint);
  }
}

/** UUIDv7 (D-014). `crypto.randomUUID()` é v4 e não serve como id neste projeto. */
function newId(): string {
  return Bun.randomUUIDv7();
}

/**
 * Sufixo único por chamada, para `player_id`, `idempotency_key` e afins.
 *
 * Sem isso, um teste que insere e não limpa faria o seguinte falhar por uma
 * unicidade que ele não estava exercitando — e a suíte dependeria da ordem.
 */
function unique(prefix: string): string {
  return `${prefix}-${newId()}`;
}

interface SeededWallet {
  id: string;
  playerId: string;
}

async function seedWallet(balance = "100.00", currency = "BRL"): Promise<SeededWallet> {
  const id = newId();
  const playerId = unique("player");

  await sql(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, 1, now(), now())`,
    [id, playerId, currency, balance],
  );

  return { id, playerId };
}

interface SeedTransactionOptions {
  walletId: string;
  kind?: string;
  status?: string;
  amount?: string;
  currency?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  referenceTransactionId?: string;
  failureCode?: string;
}

interface SeededTransaction {
  id: string;
  externalTransactionId: string;
  idempotencyKey: string;
}

async function seedTransaction(options: SeedTransactionOptions): Promise<SeededTransaction> {
  const id = newId();
  const externalTransactionId = options.externalTransactionId ?? unique("ext");
  const idempotencyKey = options.idempotencyKey ?? unique("idem");

  await sql(
    `insert into wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
       reference_transaction_id, failure_code, created_at
     ) values (?, 'provider-a', ?, ?, repeat('a', 64), ?, 'player-x', 'round-1',
               'game-1', ?, ?, ?, ?, ?, ?, now())`,
    [
      id,
      externalTransactionId,
      idempotencyKey,
      options.walletId,
      options.kind ?? "BET",
      options.amount ?? "10.00",
      options.currency ?? "BRL",
      options.status ?? "PENDING",
      options.referenceTransactionId ?? null,
      options.failureCode ?? null,
    ],
  );

  return { id, externalTransactionId, idempotencyKey };
}

async function seedLedgerEntry(walletId: string, transactionId: string): Promise<string> {
  const id = newId();

  await sql(
    `insert into wallet_ledger_entries (
       id, wallet_id, transaction_id, direction, amount, currency,
       balance_before, balance_after, created_at
     ) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '90.00', now())`,
    [id, walletId, transactionId],
  );

  return id;
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

describe("migrations aplicam e ficam registradas (RNF-09, RT-08)", () => {
  it("cria as cinco tabelas do schema", async () => {
    const rows = await sql(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries',
                             'inbox_messages', 'outbox_messages')
        order by table_name`,
    );

    expect(rows.map((row) => row["table_name"])).toEqual([
      "inbox_messages",
      "outbox_messages",
      "wager_transactions",
      "wallet_ledger_entries",
      "wallets",
    ]);
  });

  it("registra a migration como executada e não deixa pendências", async () => {
    const executed = await orm.migrator.getExecuted();

    expect(executed.map((row) => row.name)).toContain("M0001InitialSchema");
    expect(await orm.migrator.getPending()).toHaveLength(0);
  });
});

describe("wallets — unicidade e não-negatividade (RI-09, EL-02, RT-08)", () => {
  it("recusa segunda wallet para o mesmo player e moeda", async () => {
    const wallet = await seedWallet();

    await expectRejectedByDatabase(
      () =>
        sql(
          `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
           values (?, ?, 'BRL', '0.00', 1, now(), now())`,
          [newId(), wallet.playerId],
        ),
      { sqlState: "23505", constraint: "uq_wallets_player_currency" },
    );
  });

  it("aceita o mesmo player em moeda diferente", async () => {
    const wallet = await seedWallet();

    await sql(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, 'USD', '0.00', 1, now(), now())`,
      [newId(), wallet.playerId],
    );

    const rows = await sql(`select count(*)::int as total from wallets where player_id = ?`, [
      wallet.playerId,
    ]);

    expect(rows).toEqual([{ total: 2 }]);
  });

  it("recusa saldo negativo no insert — EL-02 no schema", async () => {
    await expectRejectedByDatabase(
      () =>
        sql(
          `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
           values (?, ?, 'BRL', '-0.01', 1, now(), now())`,
          [newId(), unique("player")],
        ),
      { sqlState: "23514", constraint: "ck_wallets_balance_non_negative" },
    );
  });

  it("recusa saldo negativo no update — que é o caminho da race de EL-02", async () => {
    const wallet = await seedWallet("100.00");

    // O cenário real de RNF-03: dois débitos concorrentes sobre o mesmo saldo.
    // Se o lock de D-002 falhar, o segundo update chega aqui — e o banco aborta.
    await expectRejectedByDatabase(
      () => sql(`update wallets set balance = balance - '180.00' where id = ?`, [wallet.id]),
      { sqlState: "23514", constraint: "ck_wallets_balance_non_negative" },
    );

    const rows = await sql(`select balance from wallets where id = ?`, [wallet.id]);
    expect(rows).toEqual([{ balance: "100.00" }]);
  });

  it("recusa moeda fora da forma de três maiúsculas (D-016)", async () => {
    await expectRejectedByDatabase(
      () =>
        sql(
          `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
           values (?, ?, 'brl', '0.00', 1, now(), now())`,
          [newId(), unique("player")],
        ),
      { sqlState: "23514", constraint: "ck_wallets_currency_format" },
    );
  });
});

describe("wager_transactions — idempotência e identidade (EL-03, EL-04, RT-08)", () => {
  it("recusa idempotency key repetida — a garantia é persistente, não em memória", async () => {
    const wallet = await seedWallet();
    const first = await seedTransaction({ walletId: wallet.id });

    await expectRejectedByDatabase(
      () => seedTransaction({ walletId: wallet.id, idempotencyKey: first.idempotencyKey }),
      { sqlState: "23505", constraint: "uq_wager_transactions_idempotency_key" },
    );
  });

  it("recusa o mesmo (provider, externalTransactionId)", async () => {
    const wallet = await seedWallet();
    const first = await seedTransaction({ walletId: wallet.id });

    await expectRejectedByDatabase(
      () =>
        seedTransaction({
          walletId: wallet.id,
          externalTransactionId: first.externalTransactionId,
        }),
      { sqlState: "23505", constraint: "uq_wager_transactions_provider_external" },
    );
  });

  it("recusa kind fora do enum fechado", async () => {
    const wallet = await seedWallet();

    await expectRejectedByDatabase(
      () => seedTransaction({ walletId: wallet.id, kind: "CASHOUT" }),
      { sqlState: "23514", constraint: "ck_wager_transactions_kind" },
    );
  });

  it("recusa status fora do enum fechado", async () => {
    const wallet = await seedWallet();

    await expectRejectedByDatabase(
      () => seedTransaction({ walletId: wallet.id, status: "RETRYING" }),
      { sqlState: "23514", constraint: "ck_wager_transactions_status" },
    );
  });

  it("recusa failureCode fora dos 13 códigos de D-007", async () => {
    const wallet = await seedWallet();

    await expectRejectedByDatabase(
      () => seedTransaction({ walletId: wallet.id, status: "REJECTED", failureCode: "OOPS" }),
      { sqlState: "23514", constraint: "ck_wager_transactions_failure_code" },
    );
  });

  it("aceita os dois códigos de infraestrutura em FAILED (D-007, D-013)", async () => {
    const wallet = await seedWallet();

    await seedTransaction({
      walletId: wallet.id,
      status: "FAILED",
      failureCode: "PERMANENT_INFRASTRUCTURE_ERROR",
    });
    await seedTransaction({
      walletId: wallet.id,
      status: "FAILED",
      failureCode: "MAX_RETRIES_EXHAUSTED",
    });

    const rows = await sql(
      `select count(*)::int as total from wager_transactions
        where wallet_id = ? and status = 'FAILED'`,
      [wallet.id],
    );
    expect(rows).toEqual([{ total: 2 }]);
  });

  it("recusa valor zero e valor negativo (D-021)", async () => {
    const wallet = await seedWallet();

    await expectRejectedByDatabase(
      () => seedTransaction({ walletId: wallet.id, amount: "0.00" }),
      { sqlState: "23514", constraint: "ck_wager_transactions_amount_positive" },
    );

    await expectRejectedByDatabase(
      () => seedTransaction({ walletId: wallet.id, amount: "-1.00" }),
      { sqlState: "23514", constraint: "ck_wager_transactions_amount_positive" },
    );
  });

  it("recusa contador de tentativas de referência negativo (D-013)", async () => {
    const wallet = await seedWallet();
    const transaction = await seedTransaction({ walletId: wallet.id });

    await expectRejectedByDatabase(
      () =>
        sql(`update wager_transactions set reference_attempts = -1 where id = ?`, [
          transaction.id,
        ]),
      { sqlState: "23514", constraint: "ck_wager_transactions_reference_attempts" },
    );
  });

  it("recusa transação apontando para wallet inexistente", async () => {
    await expectRejectedByDatabase(() => seedTransaction({ walletId: newId() }), {
      sqlState: "23503",
      constraint: "fk_wager_transactions_wallet",
    });
  });
});

describe("wager_transactions — reversão única por referência (RN-09, D-024)", () => {
  it("recusa duas reversões PROCESSED da mesma referência pelo mesmo kind", async () => {
    const wallet = await seedWallet();
    const bet = await seedTransaction({ walletId: wallet.id, status: "PROCESSED" });

    await seedTransaction({
      walletId: wallet.id,
      kind: "REFUND",
      status: "PROCESSED",
      referenceTransactionId: bet.id,
    });

    await expectRejectedByDatabase(
      () =>
        seedTransaction({
          walletId: wallet.id,
          kind: "REFUND",
          status: "PROCESSED",
          referenceTransactionId: bet.id,
        }),
      { sqlState: "23505", constraint: "uq_wager_transactions_reversal_once" },
    );
  });

  it("aceita REFUND e ROLLBACK sobre a mesma referência — kinds diferentes (RN-08)", async () => {
    const wallet = await seedWallet();
    const bet = await seedTransaction({ walletId: wallet.id, status: "PROCESSED" });

    await seedTransaction({
      walletId: wallet.id,
      kind: "REFUND",
      status: "PROCESSED",
      referenceTransactionId: bet.id,
    });
    await seedTransaction({
      walletId: wallet.id,
      kind: "ROLLBACK",
      status: "PROCESSED",
      referenceTransactionId: bet.id,
    });

    const rows = await sql(
      `select count(*)::int as total from wager_transactions
        where reference_transaction_id = ? and status = 'PROCESSED'`,
      [bet.id],
    );
    expect(rows).toEqual([{ total: 2 }]);
  });

  it("uma tentativa REJECTED não queima a referência — é o ponto de D-024", async () => {
    const wallet = await seedWallet();
    const bet = await seedTransaction({ walletId: wallet.id, status: "PROCESSED" });

    // Recusada por saldo insuficiente na reversão (RN-16). Não reverteu nada.
    await seedTransaction({
      walletId: wallet.id,
      kind: "REFUND",
      status: "REJECTED",
      referenceTransactionId: bet.id,
      failureCode: "INSUFFICIENT_FUNDS_ON_REVERSAL",
    });

    // A tentativa seguinte, legítima, precisa passar. Com índice total, morreria
    // com erro de integridade em vez de ser avaliada pela regra de negócio.
    const applied = await seedTransaction({
      walletId: wallet.id,
      kind: "REFUND",
      status: "PROCESSED",
      referenceTransactionId: bet.id,
    });

    const rows = await sql(`select status from wager_transactions where id = ?`, [applied.id]);
    expect(rows).toEqual([{ status: "PROCESSED" }]);
  });
});

describe("wallet_ledger_entries — aritmética e imutabilidade (EL-07, RI-05, RT-08)", () => {
  it("recusa lançamento aritmeticamente inválido", async () => {
    const wallet = await seedWallet();
    const transaction = await seedTransaction({ walletId: wallet.id });

    await expectRejectedByDatabase(
      () =>
        sql(
          `insert into wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after, created_at
           ) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '95.00', now())`,
          [newId(), wallet.id, transaction.id],
        ),
      { sqlState: "23514", constraint: "ck_wallet_ledger_entries_balanced" },
    );
  });

  it("recusa direção invertida sobre valores válidos", async () => {
    const wallet = await seedWallet();
    const transaction = await seedTransaction({ walletId: wallet.id });

    await expectRejectedByDatabase(
      () =>
        sql(
          `insert into wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after, created_at
           ) values (?, ?, ?, 'CREDIT', '10.00', 'BRL', '100.00', '90.00', now())`,
          [newId(), wallet.id, transaction.id],
        ),
      { sqlState: "23514", constraint: "ck_wallet_ledger_entries_balanced" },
    );
  });

  it("recusa lançamento de valor zero (D-021)", async () => {
    const wallet = await seedWallet();
    const transaction = await seedTransaction({ walletId: wallet.id });

    await expectRejectedByDatabase(
      () =>
        sql(
          `insert into wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after, created_at
           ) values (?, ?, ?, 'DEBIT', '0.00', 'BRL', '100.00', '100.00', now())`,
          [newId(), wallet.id, transaction.id],
        ),
      { sqlState: "23514", constraint: "ck_wallet_ledger_entries_amount_positive" },
    );
  });

  it("recusa saldo negativo na trilha de auditoria", async () => {
    const wallet = await seedWallet();
    const transaction = await seedTransaction({ walletId: wallet.id });

    await expectRejectedByDatabase(
      () =>
        sql(
          `insert into wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after, created_at
           ) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '5.00', '-5.00', now())`,
          [newId(), wallet.id, transaction.id],
        ),
      { sqlState: "23514", constraint: "ck_wallet_ledger_entries_balances_non_negative" },
    );
  });

  it("recusa direção fora do enum fechado", async () => {
    const wallet = await seedWallet();
    const transaction = await seedTransaction({ walletId: wallet.id });

    await expectRejectedByDatabase(
      () =>
        sql(
          `insert into wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after, created_at
           ) values (?, ?, ?, 'REVERSAL', '10.00', 'BRL', '100.00', '90.00', now())`,
          [newId(), wallet.id, transaction.id],
        ),
      { sqlState: "23514", constraint: "ck_wallet_ledger_entries_direction" },
    );
  });

  it("recusa dois lançamentos da mesma transação na mesma wallet (RF-04)", async () => {
    const wallet = await seedWallet();
    const transaction = await seedTransaction({ walletId: wallet.id });

    await seedLedgerEntry(wallet.id, transaction.id);

    await expectRejectedByDatabase(() => seedLedgerEntry(wallet.id, transaction.id), {
      sqlState: "23505",
      constraint: "uq_wallet_ledger_entries_wallet_transaction",
    });
  });

  it("recusa UPDATE — o ledger é imutável no banco (EL-07, D-023)", async () => {
    const wallet = await seedWallet();
    const transaction = await seedTransaction({ walletId: wallet.id });
    const entryId = await seedLedgerEntry(wallet.id, transaction.id);

    // P0001 é o SQLSTATE de `raise exception`, e não há nome de constraint: a
    // garantia aqui é trigger, não constraint. Foi a escolha de D-023 justamente
    // porque `REVOKE` seria ignorado pelo superusuário que o container cria — e
    // o teste passaria com o `UPDATE` funcionando.
    await expectRejectedByDatabase(
      () => sql(`update wallet_ledger_entries set amount = '0.01' where id = ?`, [entryId]),
      { sqlState: "P0001" },
    );

    const rows = await sql(`select amount from wallet_ledger_entries where id = ?`, [entryId]);
    expect(rows).toEqual([{ amount: "10.00" }]);
  });

  it("recusa DELETE — o lançamento não pode ser apagado (RI-05)", async () => {
    const wallet = await seedWallet();
    const transaction = await seedTransaction({ walletId: wallet.id });
    const entryId = await seedLedgerEntry(wallet.id, transaction.id);

    await expectRejectedByDatabase(
      () => sql(`delete from wallet_ledger_entries where id = ?`, [entryId]),
      { sqlState: "P0001" },
    );

    const rows = await sql(
      `select count(*)::int as total from wallet_ledger_entries where id = ?`,
      [entryId],
    );
    expect(rows).toEqual([{ total: 1 }]);
  });

  it("devolve numeric como string, não number — guarda de EL-01 na borda do driver", async () => {
    const wallet = await seedWallet("100.00");

    const rows = await sql(`select balance from wallets where id = ?`, [wallet.id]);

    // D-004 antecipou este risco: um type parser registrado por engano
    // converteria `numeric` para float em silêncio, e nenhum teste de negócio
    // quebraria. O teste completo do mapper é de E-06; aqui a asserção é sobre o
    // driver cru, antes de existir mapeamento algum.
    expect(typeof rows[0]?.["balance"]).toBe("string");
    expect(rows[0]?.["balance"]).toBe("100.00");
  });
});

describe("inbox_messages — dedupe persistente (RF-19, EL-05, RT-08)", () => {
  const insertInbox = async (consumerName: string, messageId: string): Promise<void> => {
    await sql(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, repeat('d', 64), now())`,
      [consumerName, messageId],
    );
  };

  it("recusa a mesma mensagem duas vezes para o mesmo consumidor", async () => {
    const messageId = unique("msg");
    await insertInbox("wagering-consumer", messageId);

    // A chave primária **é** a regra de deduplicação (D-025) — não há constraint
    // paralela que alguém possa remover achando que é índice redundante.
    await expectRejectedByDatabase(() => insertInbox("wagering-consumer", messageId), {
      sqlState: "23505",
      constraint: "pk_inbox_messages",
    });
  });

  it("aceita a mesma mensagem em consumidores diferentes", async () => {
    const messageId = unique("msg");

    await insertInbox("consumer-a", messageId);
    await insertInbox("consumer-b", messageId);

    const rows = await sql(
      `select count(*)::int as total from inbox_messages where message_id = ?`,
      [messageId],
    );

    expect(rows).toEqual([{ total: 2 }]);
  });
});

describe("outbox_messages — lease e payload (RF-24, D-009, RT-08)", () => {
  const insertOutbox = async (values: {
    lockedBy?: string;
    lockedUntil?: string;
    attempts?: number;
  }): Promise<string> => {
    const id = newId();

    await sql(
      `insert into outbox_messages (
         id, aggregate_id, event_type, payload, occurred_at, attempts, locked_by, locked_until
       ) values (?, ?, 'WagerTransactionProcessed', ?::jsonb, now(), ?, ?, ?)`,
      [
        id,
        newId(),
        JSON.stringify({ eventType: "WagerTransactionProcessed", version: 1 }),
        values.attempts ?? 0,
        values.lockedBy ?? null,
        values.lockedUntil ?? null,
      ],
    );

    return id;
  };

  it("aceita lease completo e lease ausente", async () => {
    const semLease = await insertOutbox({});
    const comLease = await insertOutbox({
      lockedBy: "instancia-1",
      lockedUntil: "2026-09-01T12:00:00Z",
    });

    const rows = await sql(
      `select count(*)::int as total from outbox_messages where id in (?, ?)`,
      [semLease, comLease],
    );
    expect(rows).toEqual([{ total: 2 }]);
  });

  it("recusa lease pela metade — linha reivindicada sem prazo ficaria presa", async () => {
    await expectRejectedByDatabase(() => insertOutbox({ lockedBy: "instancia-1" }), {
      sqlState: "23514",
      constraint: "ck_outbox_messages_lease_pair",
    });

    await expectRejectedByDatabase(
      () => insertOutbox({ lockedUntil: "2026-09-01T12:00:00Z" }),
      { sqlState: "23514", constraint: "ck_outbox_messages_lease_pair" },
    );
  });

  it("recusa contador de tentativas negativo", async () => {
    await expectRejectedByDatabase(() => insertOutbox({ attempts: -1 }), {
      sqlState: "23514",
      constraint: "ck_outbox_messages_attempts",
    });
  });

  it("guarda o payload como jsonb consultável", async () => {
    const id = await insertOutbox({});

    const rows = await sql(
      `select payload->>'eventType' as event_type from outbox_messages where id = ?`,
      [id],
    );

    expect(rows).toEqual([{ event_type: "WagerTransactionProcessed" }]);
  });
});

describe("índices exigidos pelas decisões (D-009, D-014, RT-08)", () => {
  it("cria o índice keyset do ledger e os índices parciais dos workers", async () => {
    const rows = await sql(
      `select indexname from pg_indexes
        where schemaname = 'public'
          and indexname in (
            'ix_wallet_ledger_entries_wallet_id_id',
            'ix_outbox_messages_pending',
            'ix_wager_transactions_pending_reference',
            'uq_wager_transactions_reversal_once'
          )
        order by indexname`,
    );

    expect(rows.map((row) => row["indexname"])).toEqual([
      "ix_outbox_messages_pending",
      "ix_wager_transactions_pending_reference",
      "ix_wallet_ledger_entries_wallet_id_id",
      "uq_wager_transactions_reversal_once",
    ]);
  });

  it("o índice da outbox é parcial em published_at is null (D-009)", async () => {
    const rows = await sql(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'ix_outbox_messages_pending'`,
    );

    // Sem o filtro, o índice cresceria com o histórico inteiro de eventos
    // publicados e a varredura do worker ficaria mais cara a cada publicação.
    expect(rows[0]?.["indexdef"]).toContain("WHERE (published_at IS NULL)");
  });

  it("o índice de reversão é parcial em PROCESSED (D-024)", async () => {
    const rows = await sql(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'uq_wager_transactions_reversal_once'`,
    );

    expect(rows[0]?.["indexdef"]).toContain("status)::text = 'PROCESSED'::text");
  });
});

/**
 * Fica por último de propósito: `down` derruba o schema inteiro, e qualquer
 * teste que rodasse depois encontraria o banco vazio.
 */
describe("reversibilidade (RNF-09) — este bloco roda por último", () => {
  it("down remove tudo o que up criou, e up reconstrói", async () => {
    await orm.migrator.down({ to: 0 });

    const afterDown = await sql(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name <> 'mikro_orm_migrations'`,
    );
    expect(afterDown).toEqual([]);

    // A função da trigger sobrevive ao `drop table`; se o `down` esquecesse dela,
    // o `up` seguinte falharia com "function already exists" — e um `down`
    // incompleto que só quebra na execução seguinte é o pior tipo de incompleto.
    const orphanFunctions = await sql(
      `select proname from pg_proc where proname = 'reject_ledger_mutation'`,
    );
    expect(orphanFunctions).toEqual([]);

    await orm.migrator.up();

    // O schema reconstruído é o mesmo: uma constraint de amostra volta a valer.
    await expectRejectedByDatabase(
      () =>
        sql(
          `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
           values (?, ?, 'BRL', '-1.00', 1, now(), now())`,
          [newId(), unique("player")],
        ),
      { sqlState: "23514", constraint: "ck_wallets_balance_non_negative" },
    );
  });
});
