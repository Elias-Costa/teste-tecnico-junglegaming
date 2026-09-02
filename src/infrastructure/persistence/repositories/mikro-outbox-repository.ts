import type { EntityManager } from "@mikro-orm/postgresql";
import type { OutboxMessage } from "../../../domain/outbox-message.ts";
import type { OutboxRepository } from "../../../domain/repositories/outbox-repository.ts";
import {
  toOutboxMessage,
  toOutboxMessageRow,
  toOutboxMessageUpdate,
} from "../mappers/outbox-message-mapper.ts";
import { outboxMessageRowSchema } from "../rows/outbox-message-row.ts";
import { READ_WITHOUT_IDENTITY_MAP } from "./read-options.ts";

/**
 * Repositório da outbox sobre o MikroORM (RF-06, RF-23, EL-06, D-026, D-028).
 *
 * O `insert` roda na mesma transação do dinheiro — é o `em` forkado que decide
 * isso, e é por isso que o repositório recebe o `EntityManager` em vez de
 * buscá-lo. Nenhum método aqui publica: RI-04 e EL-06 exigem que o evento vá
 * para o SQS **depois** do commit, e quem faz isso é o worker de E-10.
 *
 * A varredura de pendentes com claim por lease (D-009) também é de E-10, e não
 * está aqui de propósito: o `UPDATE ... RETURNING` com `SKIP LOCKED` é parte da
 * estratégia de publicação, não da persistência do agregado.
 */
export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: OutboxMessage): Promise<void> {
    await this.em.insert(outboxMessageRowSchema, toOutboxMessageRow(message));
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const row = await this.em.findOne(outboxMessageRowSchema, { id }, READ_WITHOUT_IDENTITY_MAP);

    return row === null ? undefined : toOutboxMessage(row);
  }

  async update(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      outboxMessageRowSchema,
      { id: message.id },
      toOutboxMessageUpdate(message),
    );
  }
}
