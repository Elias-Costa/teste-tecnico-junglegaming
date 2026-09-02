import { InboxMessage } from "../../../domain/inbox-message.ts";
import type { InboxMessageRow } from "../rows/inbox-message-row.ts";

/**
 * A única coluna que um `update` de inbox escreve (D-028).
 *
 * `consumerName` e `messageId` formam a chave primária (D-025) e `payloadHash`
 * e `receivedAt` registram o que chegou — nada disso muda depois do `insert`.
 * A mensagem só ganha um fato novo: a hora em que terminou de ser processada.
 */
export type InboxMessageUpdate = Pick<InboxMessageRow, "processedAt">;

/** Converte a mensagem para a linha, para `insert`. */
export function toInboxMessageRow(message: InboxMessage): InboxMessageRow {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

/** Extrai a conclusão do processamento (RF-20). */
export function toInboxMessageUpdate(message: InboxMessage): InboxMessageUpdate {
  return { processedAt: message.processedAt ?? null };
}

/** Reconstrói a mensagem a partir da linha (D-026). */
export function toInboxMessage(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: row.messageId,
    consumerName: row.consumerName,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });
}
