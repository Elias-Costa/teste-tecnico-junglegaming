import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial completo (E-05).
 *
 * SQL escrito à mão, não gerado por diff de metadata: o mapeamento por
 * `EntitySchema` só existe a partir de E-06, e mais da metade do que esta
 * migration cria — índice parcial, `CHECK` de enum, trigger de imutabilidade —
 * não tem representação em metadata de ORM nenhum. Gerar o esqueleto e depois
 * remendá-lo à mão produziria um arquivo com duas origens e nenhuma revisável.
 *
 * **A garantia vive aqui, não no código de aplicação (RI-09).** Unicidade,
 * não-negatividade e imutabilidade são constraints do PostgreSQL. O código de
 * E-12 vai validar as mesmas regras antes, para produzir `failureCode` legível
 * (RN-17) em vez de erro de integridade — mas quem impede o estado inválido de
 * existir é o banco, e é ele que continua correto quando o lock falha, quando
 * duas instâncias corrigem, ou quando alguém escreve por fora da aplicação.
 *
 * **Ids não têm `DEFAULT` (D-014).** São UUIDv7 gerados pela aplicação com
 * `Bun.randomUUIDv7()`. `gen_random_uuid()` produz v4, que não é ordenável no
 * tempo e quebraria em silêncio o cursor keyset de RF-10 — o tipo de falha que
 * só aparece quando a segunda página vem fora de ordem em produção.
 */
export class M0001InitialSchema extends Migration {
  /** Nome estável, independente do nome da classe (que um minificador mangla). */
  override name = "M0001InitialSchema";

  override up(): void {
    // -------------------------------------------------------------------------
    // wallets (RF-02)
    //
    // `balance numeric(19,2)` + `currency varchar(3)` conforme D-004: o valor
    // fica legível para quem inspeciona o banco, e `CHECK` e `SUM` saem em SQL
    // puro — que é o que RF-16 (reconciliação) precisa.
    // -------------------------------------------------------------------------
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" varchar(120) not null,
        "currency" varchar(3) not null,
        "balance" numeric(19,2) not null,
        "version" integer not null,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "pk_wallets" primary key ("id"),
        -- EL-02: o saldo negativo é impedido pelo banco, não pelo lock. Se a
        -- estratégia de D-002 falhar sob concorrência, a transação aborta aqui.
        constraint "ck_wallets_balance_non_negative" check ("balance" >= 0),
        -- D-016: a mesma forma que \`Money\` valida no domínio, imposta no schema.
        constraint "ck_wallets_currency_format" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    // RI-09 / RF-02: no máximo uma wallet por player e moeda. A invariante é
    // entre agregados — nenhum agregado consegue observá-la sozinho —, então
    // este índice é o único lugar onde ela pode ser garantida de verdade.
    this.addSql(`
      alter table "wallets"
        add constraint "uq_wallets_player_currency" unique ("player_id", "currency");
    `);

    // -------------------------------------------------------------------------
    // wager_transactions (RF-03)
    // -------------------------------------------------------------------------
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(120) not null,
        "external_transaction_id" varchar(120) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" char(64) not null,
        "wallet_id" uuid not null,
        "player_id" varchar(120) not null,
        "round_id" varchar(120) not null,
        "game_id" varchar(120) not null,
        "kind" varchar(20) not null,
        "amount" numeric(19,2) not null,
        "currency" varchar(3) not null,
        "status" varchar(20) not null,
        "reference_external_transaction_id" varchar(120),
        "reference_transaction_id" uuid,
        "failure_code" varchar(40),
        "reference_attempts" integer not null default 0,
        "next_reference_attempt_at" timestamptz,
        "created_at" timestamptz not null,
        "processed_at" timestamptz,
        constraint "pk_wager_transactions" primary key ("id"),
        constraint "fk_wager_transactions_wallet" foreign key ("wallet_id")
          references "wallets" ("id"),
        -- Auto-referência: a transação revertida por um REFUND/ROLLBACK é outra
        -- linha desta mesma tabela, resolvida por (provider_id, external_id)
        -- durante o processamento (RN-07).
        constraint "fk_wager_transactions_reference" foreign key ("reference_transaction_id")
          references "wager_transactions" ("id"),
        -- Enums fechados replicados como CHECK, e não como \`create type\`: o
        -- \`down\` de um CHECK é o próprio drop da tabela, enquanto remover valor
        -- de um tipo enum do PostgreSQL não tem comando — a reversibilidade
        -- exigida por RNF-09 decide a favor do CHECK.
        constraint "ck_wager_transactions_kind" check (
          "kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        constraint "ck_wager_transactions_status" check (
          "status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        -- Os 13 códigos de D-007: 11 de negócio + 2 de infraestrutura.
        constraint "ck_wager_transactions_failure_code" check (
          "failure_code" is null or "failure_code" in (
            'INSUFFICIENT_FUNDS',
            'INSUFFICIENT_FUNDS_ON_REVERSAL',
            'REFERENCE_NOT_FOUND',
            'REFERENCE_MISMATCH',
            'INVALID_REFERENCE_KIND',
            'ALREADY_REVERSED',
            'AMOUNT_MISMATCH',
            'CURRENCY_MISMATCH',
            'IDEMPOTENCY_CONFLICT',
            'WALLET_NOT_FOUND',
            'KIND_NOT_SUBMITTABLE',
            'PERMANENT_INFRASTRUCTURE_ERROR',
            'MAX_RETRIES_EXHAUSTED'
          )
        ),
        -- D-021: o valor da operação é estritamente positivo; quem carrega o
        -- sinal é a direção do lançamento, nunca o número.
        constraint "ck_wager_transactions_amount_positive" check ("amount" > 0),
        constraint "ck_wager_transactions_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        -- D-013: o contador de tentativas de referência vive em coluna própria,
        -- fora do status. Negativo aqui seria dado corrompido.
        constraint "ck_wager_transactions_reference_attempts" check ("reference_attempts" >= 0)
      );
    `);

    // RF-14 / EL-03 / EL-04: a idempotência é persistente e imposta por
    // constraint. Nenhuma estrutura em memória participa da decisão de replay —
    // é o que RI-02 proíbe e o que faz a garantia sobreviver a três instâncias.
    this.addSql(`
      alter table "wager_transactions"
        add constraint "uq_wager_transactions_idempotency_key" unique ("idempotency_key");
    `);

    // RF-12: a identidade da transação no provedor. Também é o caminho de leitura
    // de RN-07, que resolve a referência por este mesmo par.
    this.addSql(`
      alter table "wager_transactions"
        add constraint "uq_wager_transactions_provider_external" unique (
          "provider_id", "external_transaction_id"
        );
    `);

    // RN-09 (D-024): a mesma referência não é revertida duas vezes pelo mesmo
    // tipo. Parcial sobre PROCESSED de propósito — uma tentativa REJECTED não
    // reverteu nada (RN-11) e não pode queimar a referência para sempre. É a
    // rede embaixo do caminho de negócio de E-12, que rejeita com
    // ALREADY_REVERSED antes de chegar aqui.
    this.addSql(`
      create unique index "uq_wager_transactions_reversal_once"
        on "wager_transactions" ("reference_transaction_id", "kind")
        where "status" = 'PROCESSED' and "reference_transaction_id" is not null;
    `);

    // RF-26: varredura do worker de referências fora de ordem. Parcial porque
    // só as linhas PENDING_REFERENCE são candidatas, e elas são a minoria.
    this.addSql(`
      create index "ix_wager_transactions_pending_reference"
        on "wager_transactions" ("next_reference_attempt_at")
        where "status" = 'PENDING_REFERENCE';
    `);

    // -------------------------------------------------------------------------
    // wallet_ledger_entries (RF-04, EL-07)
    // -------------------------------------------------------------------------
    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(10) not null,
        "amount" numeric(19,2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(19,2) not null,
        "balance_after" numeric(19,2) not null,
        "created_at" timestamptz not null,
        constraint "pk_wallet_ledger_entries" primary key ("id"),
        constraint "fk_wallet_ledger_entries_wallet" foreign key ("wallet_id")
          references "wallets" ("id"),
        constraint "fk_wallet_ledger_entries_transaction" foreign key ("transaction_id")
          references "wager_transactions" ("id"),
        constraint "ck_wallet_ledger_entries_direction" check (
          "direction" in ('DEBIT', 'CREDIT')
        ),
        -- D-021: lançamento de valor zero ou negativo não existe.
        constraint "ck_wallet_ledger_entries_amount_positive" check ("amount" > 0),
        -- EL-02 no ledger: nenhum lançamento pode registrar saldo negativo, nem
        -- antes nem depois. É a mesma invariante de \`wallets\`, verificada na
        -- trilha de auditoria — que é o que RF-16 reconstrói.
        constraint "ck_wallet_ledger_entries_balances_non_negative" check (
          "balance_before" >= 0 and "balance_after" >= 0
        ),
        -- A aritmética do lançamento, imposta pelo banco (RF-04, \`isBalanced\`).
        -- Duplica a validação da factory de propósito: a factory protege o
        -- caminho da aplicação, esta constraint protege a tabela.
        --
        -- O \`else true\` **não** é frouxidão: direção desconhecida é assunto da
        -- constraint acima, e sem ele as duas se sobreporiam. O PostgreSQL
        -- avalia \`CHECK\` em ordem alfabética de nome e reportaria "balanced"
        -- para um erro de direção — o nome da constraint violada é o que diz a
        -- quem lê o log qual regra foi quebrada, e apontar a regra errada é pior
        -- que não apontar nenhuma.
        constraint "ck_wallet_ledger_entries_balanced" check (
          case "direction"
            when 'DEBIT'  then "balance_after" = "balance_before" - "amount"
            when 'CREDIT' then "balance_after" = "balance_before" + "amount"
            else true
          end
        ),
        constraint "ck_wallet_ledger_entries_currency_format" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    // RF-04: uma transação financeira produz no máximo um lançamento por wallet.
    this.addSql(`
      alter table "wallet_ledger_entries"
        add constraint "uq_wallet_ledger_entries_wallet_transaction" unique (
          "wallet_id", "transaction_id"
        );
    `);

    // RF-10 / D-014: o acesso da paginação keyset. O id é UUIDv7, então a ordem
    // do índice já é a ordem cronológica — não há coluna de tempo no índice.
    this.addSql(`
      create index "ix_wallet_ledger_entries_wallet_id_id"
        on "wallet_ledger_entries" ("wallet_id", "id");
    `);

    // -------------------------------------------------------------------------
    // Imutabilidade do ledger (RI-05, EL-07, D-023)
    //
    // Trigger e não `REVOKE`: a revogação de privilégio é ignorada pelo dono da
    // tabela e por superusuário — inclusive o usuário que o Testcontainers cria
    // —, e o teste que sustenta EL-07 passaria por engano, com o `UPDATE`
    // funcionando e ninguém vendo. A trigger não depende de quem está conectado.
    //
    // O custo é uma chamada por linha afetada em UPDATE/DELETE. Como nenhum
    // caminho legítimo do sistema emite qualquer um dos dois sobre o ledger, o
    // custo real é zero: ele só existe no caminho que deve falhar.
    // -------------------------------------------------------------------------
    this.addSql(`
      create function "reject_ledger_mutation"() returns trigger as $$
      begin
        -- SQLSTATE P0001 (raise_exception), o default de \`raise exception\`.
        -- E o que RT-08 asserta, em vez da mensagem, que e texto livre.
        raise exception 'wallet_ledger_entries e imutavel: % negado (RI-05, EL-07)', tg_op;
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger "ledger_immutable"
        before update or delete on "wallet_ledger_entries"
        for each row execute function "reject_ledger_mutation"();
    `);

    // -------------------------------------------------------------------------
    // inbox_messages (RF-05, RF-19, EL-05)
    //
    // Sem coluna de id (D-025): a identidade é o par, e a chave primária **é** a
    // regra de deduplicação. Uma constraint única paralela a um id sintético
    // pareceria índice redundante para quem lê o schema depois.
    // -------------------------------------------------------------------------
    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(120) not null,
        "message_id" varchar(120) not null,
        "payload_hash" char(64) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz,
        constraint "pk_inbox_messages" primary key ("consumer_name", "message_id")
      );
    `);

    // -------------------------------------------------------------------------
    // outbox_messages (RF-06, RF-23, RF-24, EL-06, D-009)
    // -------------------------------------------------------------------------
    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(80) not null,
        -- jsonb e não texto: o payload já chega serializado (\`event.toJSON()\`)
        -- e precisa sobreviver a mudanças de código — reidratar a classe de
        -- evento de seis meses atrás para republicar acoplaria a fila ao código
        -- vigente.
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz,
        "published_at" timestamptz,
        -- Lease de D-009: quem reivindicou a linha e até quando.
        "locked_by" varchar(120),
        "locked_until" timestamptz,
        constraint "pk_outbox_messages" primary key ("id"),
        constraint "ck_outbox_messages_attempts" check ("attempts" >= 0),
        -- Lease é par ou nada. Metade preenchida significaria uma linha
        -- reivindicada sem prazo de expiração — presa para sempre, exatamente o
        -- que o lease existe para evitar (RF-24).
        constraint "ck_outbox_messages_lease_pair" check (
          ("locked_by" is null) = ("locked_until" is null)
        )
      );
    `);

    // D-009: o caminho quente do worker de publicação. Parcial porque a linha
    // publicada nunca mais é varrida — sem o filtro, o índice cresceria com o
    // histórico inteiro e a varredura ficaria mais cara a cada evento publicado.
    this.addSql(`
      create index "ix_outbox_messages_pending"
        on "outbox_messages" ("next_attempt_at", "locked_until")
        where "published_at" is null;
    `);
  }

  /**
   * Desfaz o schema inteiro (RNF-09).
   *
   * Ordem inversa da criação, por causa das chaves estrangeiras: o ledger
   * referencia wallets e transações, e as transações referenciam wallets.
   * `drop table` já leva junto índices e constraints da tabela; a função da
   * trigger é o único objeto que sobrevive ao drop e precisa de linha própria.
   */
  override down(): void {
    this.addSql(`drop table if exists "outbox_messages";`);
    this.addSql(`drop table if exists "inbox_messages";`);
    this.addSql(`drop table if exists "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "reject_ledger_mutation"();`);
    this.addSql(`drop table if exists "wager_transactions";`);
    this.addSql(`drop table if exists "wallets";`);
  }
}
