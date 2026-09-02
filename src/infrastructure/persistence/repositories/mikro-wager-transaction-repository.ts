import type { EntityManager } from "@mikro-orm/postgresql";
import type { WagerTransactionRepository } from "../../../domain/repositories/wager-transaction-repository.ts";
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from "../../../domain/wager-transaction.ts";
import {
  toWagerTransaction,
  toWagerTransactionRow,
  toWagerTransactionUpdate,
} from "../mappers/wager-transaction-mapper.ts";
import { wagerTransactionRowSchema } from "../rows/wager-transaction-row.ts";
import { READ_WITHOUT_IDENTITY_MAP } from "./read-options.ts";

/**
 * Repositório de transação de aposta sobre o MikroORM (RF-03, D-026, D-028).
 *
 * O `update` escreve a lista fechada de `WagerTransactionUpdate` — as colunas que
 * as transições de D-013 alteram. As de retry de referência ficam de fora por
 * D-029/D-052: quem as escreve é o `PendingReferenceStore`, e a ausência delas no
 * `Pick` é o que garante que um `update` de status vindo daqui não apague o
 * reagendamento do worker de RF-26 — nem o contrário.
 */
export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(wagerTransactionRowSchema, toWagerTransactionRow(transaction));
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      wagerTransactionRowSchema,
      { id },
      READ_WITHOUT_IDENTITY_MAP,
    );

    return row === null ? undefined : toWagerTransaction(row);
  }

  /**
   * Leitura por idempotency key (RF-14).
   *
   * **Sem lock**, e não é esquecimento: quem serializa a decisão de replay é o
   * `FOR UPDATE` da wallet que o use case já segurou (D-002), e a unicidade da
   * key é do banco (RI-09). Um segundo `FOR UPDATE` aqui espalharia a aquisição
   * de lock por dois lugares, que é o que RI-06 pede para não acontecer.
   */
  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      wagerTransactionRowSchema,
      { idempotencyKey },
      READ_WITHOUT_IDENTITY_MAP,
    );

    return row === null ? undefined : toWagerTransaction(row);
  }

  /**
   * Leitura pela identidade no provedor (RN-07, RF-12).
   *
   * **Sem lock**, pelo mesmo motivo do finder de idempotência e por mais um: RN-07
   * exige que a referência pertença à **mesma wallet** da reversão, e essa wallet
   * já está travada pelo `FOR UPDATE` que o use case segurou. Não há segundo
   * agregado a serializar, e travar aqui espalharia a aquisição de lock por dois
   * lugares — exatamente o que RI-06 pede para não acontecer.
   */
  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      wagerTransactionRowSchema,
      { providerId, externalTransactionId },
      READ_WITHOUT_IDENTITY_MAP,
    );

    return row === null ? undefined : toWagerTransaction(row);
  }

  /**
   * Procura uma reversão já aplicada sobre a referência (RN-09).
   *
   * O filtro é o mesmo do índice parcial de D-024 — `(reference_transaction_id,
   * kind)` restrito a `PROCESSED` —, e é deliberado: a consulta que o use case
   * faz e a constraint que o banco impõe respondem à **mesma** pergunta, então
   * uma não pode aceitar o que a outra recusa. Uma tentativa `REJECTED` não conta,
   * porque ela não reverteu nada (RN-11).
   */
  async hasProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    const row = await this.em.findOne(
      wagerTransactionRowSchema,
      { referenceTransactionId, kind, status: WagerTransactionStatus.Processed },
      READ_WITHOUT_IDENTITY_MAP,
    );

    return row !== null;
  }

  async update(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      wagerTransactionRowSchema,
      { id: transaction.id },
      toWagerTransactionUpdate(transaction),
    );
  }
}
