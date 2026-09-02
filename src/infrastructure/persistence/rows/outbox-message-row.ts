import { EntitySchema } from "@mikro-orm/core";

/**
 * A tabela `outbox_messages` como linha (D-026).
 *
 * O `payload` é `jsonb` e chega já serializado (`event.toJSON()`), o que é
 * premissa de E-04: a linha precisa sobreviver a mudanças de código, e
 * reidratar a classe de evento de seis meses atrás para republicar acoplaria a
 * fila ao código vigente. Aqui ele é `Record<string, unknown>` e atravessa a
 * infraestrutura sem ninguém olhar dentro.
 */
export interface OutboxMessageRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  /** Metade do lease de D-009 — quem reivindicou a linha. */
  lockedBy: string | null;
  /** Metade do lease de D-009 — até quando. Par ou nada, por `CHECK` no schema. */
  lockedUntil: Date | null;
}

/** Mapeamento da linha da outbox. */
export const outboxMessageRowSchema = new EntitySchema<OutboxMessageRow>({
  name: "OutboxMessageRow",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", columnType: "uuid", fieldName: "id", primary: true },
    aggregateId: { type: "uuid", columnType: "uuid", fieldName: "aggregate_id" },
    eventType: { type: "string", columnType: "varchar(80)", fieldName: "event_type" },
    payload: { type: "json", columnType: "jsonb", fieldName: "payload" },
    occurredAt: { type: "datetime", columnType: "timestamptz", fieldName: "occurred_at" },
    attempts: { type: "integer", columnType: "integer", fieldName: "attempts" },
    nextAttemptAt: {
      type: "datetime",
      columnType: "timestamptz",
      fieldName: "next_attempt_at",
      nullable: true,
    },
    publishedAt: {
      type: "datetime",
      columnType: "timestamptz",
      fieldName: "published_at",
      nullable: true,
    },
    lockedBy: {
      type: "string",
      columnType: "varchar(120)",
      fieldName: "locked_by",
      nullable: true,
    },
    lockedUntil: {
      type: "datetime",
      columnType: "timestamptz",
      fieldName: "locked_until",
      nullable: true,
    },
  },
});
