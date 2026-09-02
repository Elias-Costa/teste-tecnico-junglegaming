import type { EntityManager } from "@mikro-orm/postgresql";
import type { WagerTransactionRepository } from "../../../domain/repositories/wager-transaction-repository.ts";
import type { WagerTransaction } from "../../../domain/wager-transaction.ts";
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
 * O `update` escreve a lista fechada de `WagerTransactionUpdate` — as quatro
 * colunas que as transições de D-013 alteram. As colunas de retry de referência
 * ficam de fora por D-029: quando E-13 passar a mexer nelas, nenhum `update` de
 * status vindo daqui vai sobrescrever o que ela escreveu.
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

  async update(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      wagerTransactionRowSchema,
      { id: transaction.id },
      toWagerTransactionUpdate(transaction),
    );
  }
}
