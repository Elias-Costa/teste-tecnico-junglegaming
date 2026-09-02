import { OutboxMessage } from "../../../domain/outbox-message.ts";
import type { OutboxMessageRow } from "../rows/outbox-message-row.ts";

/**
 * As colunas que um `update` de outbox escreve (D-028, D-009).
 *
 * Identidade, tipo do evento, payload e `occurredAt` descrevem o fato que
 * aconteceu e são imutáveis. O que muda é o **estado da entrega**: tentativas,
 * agendamento, publicação e as duas metades do lease.
 */
export type OutboxMessageUpdate = Pick<
  OutboxMessageRow,
  "attempts" | "nextAttemptAt" | "publishedAt" | "lockedBy" | "lockedUntil"
>;

/**
 * Converte a mensagem para a linha, para `insert`.
 *
 * O `payload` é copiado para um objeto novo apenas para soltar o `Readonly` que
 * a entidade impõe — o conteúdo é o mesmo `event.toJSON()` que ela recebeu, e
 * ninguém no caminho de persistência olha dentro dele.
 */
export function toOutboxMessageRow(message: OutboxMessage): OutboxMessageRow {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
    lockedBy: message.lockedBy ?? null,
    lockedUntil: message.lockedUntil ?? null,
  };
}

/** Extrai o estado de entrega (RF-24, D-009). */
export function toOutboxMessageUpdate(message: OutboxMessage): OutboxMessageUpdate {
  return {
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
    lockedBy: message.lockedBy ?? null,
    lockedUntil: message.lockedUntil ?? null,
  };
}

/** Reconstrói a mensagem a partir da linha (D-026). */
export function toOutboxMessage(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
    lockedBy: row.lockedBy ?? undefined,
    lockedUntil: row.lockedUntil ?? undefined,
  });
}
