import { WagerTransaction } from "../../../domain/wager-transaction.ts";
import { moneyFromColumns, moneyToColumns } from "../money-mapper.ts";
import type { WagerTransactionRow } from "../rows/wager-transaction-row.ts";

/**
 * As colunas que um `update` de transação escreve (D-028, D-013).
 *
 * São exatamente as quatro que as transições de `WagerTransaction` alteram.
 * Identidade e payload são imutáveis do nascimento ao terminal, e
 * `reference_attempts`/`next_reference_attempt_at` estão fora por D-029 — a
 * ausência delas neste `Pick` é o que garante que um `update` de status não
 * apague o trabalho do worker de E-13.
 */
export type WagerTransactionUpdate = Pick<
  WagerTransactionRow,
  "status" | "referenceTransactionId" | "failureCode" | "processedAt"
>;

/**
 * Converte a transação para a linha completa, para `insert`.
 *
 * O objeto devolvido **omite** `referenceAttempts` e `nextReferenceAttemptAt`
 * (D-029): omitidas do `insert`, valem os defaults da tabela — `0` e nulo.
 * Escrevê-las aqui seria a aplicação assumindo um dono que ela não tem.
 */
export function toWagerTransactionRow(transaction: WagerTransaction): WagerTransactionRow {
  const money = moneyToColumns(transaction.money);

  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: money.amount,
    currency: money.currency,
    status: transaction.status,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}

/** Extrai o que uma transição de D-013 alterou. */
export function toWagerTransactionUpdate(
  transaction: WagerTransaction,
): WagerTransactionUpdate {
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
  };
}

/**
 * Reconstrói a entidade a partir da linha (D-026).
 *
 * `rehydrate` não revalida transições (§6.0): uma linha em `PROCESSED` volta
 * direto para `PROCESSED`, sem passar por `PENDING`. A conversão de `null` para
 * `undefined` é a fronteira entre as duas linguagens — no SQL a ausência é
 * `NULL`, no domínio é `undefined`, e misturar as duas faria `failureCode`
 * aparecer como `null` em código que testa `=== undefined`.
 */
export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    money: moneyFromColumns(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: row.failureCode ?? undefined,
    processedAt: row.processedAt ?? undefined,
  });
}
