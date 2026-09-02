import { WagerTransaction } from "../../../domain/wager-transaction.ts";
import { moneyFromColumns, moneyToColumns } from "../money-mapper.ts";
import type { WagerTransactionRow } from "../rows/wager-transaction-row.ts";

/**
 * As colunas que um `update` de transação escreve (D-028, D-013).
 *
 * São exatamente as que as transições de `WagerTransaction` alteram — incluindo
 * o par do saldo observado, escrito por `markProcessed` e `reject` (D-030).
 * Identidade e payload são imutáveis do nascimento ao terminal — `correlationId`
 * entre eles (D-055) —, e `reference_attempts`/`next_reference_attempt_at` estão
 * fora por D-029/D-052: a ausência delas neste `Pick` é o que garante que um
 * `update` de status **não apague** o reagendamento que o worker de RF-26
 * acabou de escrever pelo outro caminho.
 */
export type WagerTransactionUpdate = Pick<
  WagerTransactionRow,
  | "status"
  | "referenceTransactionId"
  | "observedBalance"
  | "observedBalanceCurrency"
  | "failureCode"
  | "processedAt"
>;

/**
 * Traduz o saldo observado para o par de colunas, ou para o par de nulos (D-030).
 *
 * Existe como função porque os dois call sites — `insert` e `update` — precisam
 * escrever o par com a mesma regra, e o `CHECK` da m0002 recusa metade
 * preenchida. Um dos dois montando o par por conta própria é como a constraint
 * passaria a ser descoberta em runtime.
 */
function toObservedBalanceColumns(
  transaction: WagerTransaction,
): Pick<WagerTransactionRow, "observedBalance" | "observedBalanceCurrency"> {
  const observed = transaction.observedBalance;

  if (observed === undefined) {
    return { observedBalance: null, observedBalanceCurrency: null };
  }

  const columns = moneyToColumns(observed);

  return { observedBalance: columns.amount, observedBalanceCurrency: columns.currency };
}

/**
 * Converte a transação para a linha completa, para `insert`.
 *
 * O objeto devolvido **omite** `referenceAttempts` e `nextReferenceAttemptAt`
 * (D-029, D-052): omitidas do `insert`, valem os defaults da tabela — `0` e nulo.
 * É delas que a varredura de RF-26 depende: uma pendente **nasce** com o
 * agendamento nulo, e é por isso que `PendingReferenceStore.findDue` trata o nulo
 * como devida em vez de ignorá-lo.
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
    correlationId: transaction.correlationId ?? null,
    ...toObservedBalanceColumns(transaction),
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
    ...toObservedBalanceColumns(transaction),
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
    correlationId: row.correlationId ?? undefined,
    createdAt: row.createdAt,
    status: row.status,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    // As duas colunas são par por `CHECK` (D-030), mas o tipo da linha permite
    // cada uma ser nula sozinha. Testar as duas é o que dispensa uma asserção
    // não-nula aqui — a alternativa seria confiar na constraint em código que o
    // compilador não tem como verificar.
    observedBalance:
      row.observedBalance === null || row.observedBalanceCurrency === null
        ? undefined
        : moneyFromColumns(row.observedBalance, row.observedBalanceCurrency),
    failureCode: row.failureCode ?? undefined,
    processedAt: row.processedAt ?? undefined,
  });
}
