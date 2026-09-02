import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxMessage } from "../../../domain/inbox-message.ts";
import type { InboxRepository } from "../../../domain/repositories/inbox-repository.ts";
import {
  toInboxMessage,
  toInboxMessageRow,
  toInboxMessageUpdate,
} from "../mappers/inbox-message-mapper.ts";
import { inboxMessageRowSchema } from "../rows/inbox-message-row.ts";
import { READ_WITHOUT_IDENTITY_MAP } from "./read-options.ts";

/**
 * Repositório da inbox sobre o MikroORM (RF-05, RF-19, EL-05, D-026, D-028).
 *
 * O filtro de `findByKey` e o `where` do `update` usam o par completo porque
 * ele **é** a chave primária (D-025) — não há id sintético a que recorrer, e
 * essa ausência é a decisão, não uma limitação.
 */
export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(inboxMessageRowSchema, toInboxMessageRow(message));
  }

  async findByKey(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(
      inboxMessageRowSchema,
      { consumerName, messageId },
      READ_WITHOUT_IDENTITY_MAP,
    );

    return row === null ? undefined : toInboxMessage(row);
  }

  async update(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      inboxMessageRowSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      toInboxMessageUpdate(message),
    );
  }
}
