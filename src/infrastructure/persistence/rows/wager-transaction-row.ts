import { EntitySchema } from "@mikro-orm/core";
import type { FailureCode } from "../../../domain/failure-code.ts";
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction.ts";

/**
 * A tabela `wager_transactions` como linha (D-026).
 *
 * **`kind`, `status` e `failureCode` são tipados com os enums do domínio.** As
 * três colunas têm `CHECK` fechado no schema (E-05), então o tipo aqui declara
 * o que a constraint garante. Reparsear na leitura duplicaria a constraint em
 * código e transformaria um dado histórico legítimo em exceção durante uma
 * simples consulta — que é justamente o que `rehydrate` não faz (§6.0).
 *
 * **Colunas nuláveis são `| null`, não opcionais.** `null` é o valor da coluna,
 * e escrevê-lo explicitamente mantém o `insert` com forma única. As **únicas**
 * propriedades opcionais desta linha são as duas colunas de retry de referência,
 * e isso é o tipo dizendo o que D-029 decidiu: elas não têm dono no domínio e o
 * repositório não as escreve.
 */
export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  /** Coluna `numeric(19,2)` lida como string (D-004, EL-01). */
  amount: string;
  currency: string;
  status: WagerTransactionStatus;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  /** Sem dono no domínio (D-029) — o repositório nunca lê nem escreve. */
  referenceAttempts?: number;
  /** Sem dono no domínio (D-029) — o repositório nunca lê nem escreve. */
  nextReferenceAttemptAt?: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

/** Mapeamento da linha de transação de aposta. */
export const wagerTransactionRowSchema = new EntitySchema<WagerTransactionRow>({
  name: "WagerTransactionRow",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", columnType: "uuid", fieldName: "id", primary: true },
    providerId: { type: "string", columnType: "varchar(120)", fieldName: "provider_id" },
    externalTransactionId: {
      type: "string",
      columnType: "varchar(120)",
      fieldName: "external_transaction_id",
    },
    idempotencyKey: { type: "string", columnType: "varchar(255)", fieldName: "idempotency_key" },
    payloadHash: { type: "string", columnType: "char(64)", fieldName: "payload_hash" },
    walletId: { type: "uuid", columnType: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", columnType: "varchar(120)", fieldName: "player_id" },
    roundId: { type: "string", columnType: "varchar(120)", fieldName: "round_id" },
    gameId: { type: "string", columnType: "varchar(120)", fieldName: "game_id" },
    // `type: "string"` e não `enum: true`: a coluna é `varchar` com `CHECK`, e
    // declarar enum faria o MikroORM querer gerenciar um tipo nativo que a
    // migration deliberadamente não criou (ver o comentário de reversibilidade
    // em `m0001-initial-schema.ts`).
    kind: { type: "string", columnType: "varchar(20)", fieldName: "kind" },
    amount: { type: "string", columnType: "numeric(19,2)", fieldName: "amount" },
    currency: { type: "string", columnType: "varchar(3)", fieldName: "currency" },
    status: { type: "string", columnType: "varchar(20)", fieldName: "status" },
    referenceExternalTransactionId: {
      type: "string",
      columnType: "varchar(120)",
      fieldName: "reference_external_transaction_id",
      nullable: true,
    },
    referenceTransactionId: {
      type: "uuid",
      columnType: "uuid",
      fieldName: "reference_transaction_id",
      nullable: true,
    },
    failureCode: {
      type: "string",
      columnType: "varchar(40)",
      fieldName: "failure_code",
      nullable: true,
    },
    // Declaradas para que o mapeamento continue sendo espelho fiel da tabela,
    // mas fora do alcance do repositório por D-029.
    referenceAttempts: {
      type: "integer",
      columnType: "integer",
      fieldName: "reference_attempts",
    },
    nextReferenceAttemptAt: {
      type: "datetime",
      columnType: "timestamptz",
      fieldName: "next_reference_attempt_at",
      nullable: true,
    },
    createdAt: { type: "datetime", columnType: "timestamptz", fieldName: "created_at" },
    processedAt: {
      type: "datetime",
      columnType: "timestamptz",
      fieldName: "processed_at",
      nullable: true,
    },
  },
});
