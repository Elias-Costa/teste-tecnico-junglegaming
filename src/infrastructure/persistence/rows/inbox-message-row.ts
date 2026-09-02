import { EntitySchema } from "@mikro-orm/core";

/**
 * A tabela `inbox_messages` como linha (D-026).
 *
 * **Sem coluna `id`, com chave primária composta** (D-025): a identidade é o par
 * `(consumer_name, message_id)`, e a chave primária **é** a regra de
 * deduplicação de RF-19/EL-05. O mapeamento precisa declarar as duas colunas
 * como `primary`, ou o MikroORM procuraria um id que a tabela não tem.
 */
export interface InboxMessageRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

/** Mapeamento da linha da inbox. */
export const inboxMessageRowSchema = new EntitySchema<InboxMessageRow>({
  name: "InboxMessageRow",
  tableName: "inbox_messages",
  properties: {
    consumerName: {
      type: "string",
      columnType: "varchar(120)",
      fieldName: "consumer_name",
      primary: true,
    },
    messageId: {
      type: "string",
      columnType: "varchar(120)",
      fieldName: "message_id",
      primary: true,
    },
    payloadHash: { type: "string", columnType: "char(64)", fieldName: "payload_hash" },
    receivedAt: { type: "datetime", columnType: "timestamptz", fieldName: "received_at" },
    processedAt: {
      type: "datetime",
      columnType: "timestamptz",
      fieldName: "processed_at",
      nullable: true,
    },
  },
});
