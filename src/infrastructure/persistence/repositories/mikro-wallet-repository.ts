import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import type { WalletRepository } from "../../../domain/repositories/wallet-repository.ts";
import type { Wallet } from "../../../domain/wallet.ts";
import { toWallet, toWalletRow, toWalletUpdate } from "../mappers/wallet-mapper.ts";
import { walletRowSchema } from "../rows/wallet-row.ts";
import { READ_WITHOUT_IDENTITY_MAP } from "./read-options.ts";

/**
 * Repositório de wallet sobre o MikroORM (RF-02, D-026, D-028).
 *
 * Recebe o `EntityManager` no construtor, e não um singleton injetado: por
 * D-028 as escritas são comandos diretos dentro de `em.transactional()`, e o
 * `em` que vale é o **forkado** que a transação entrega. Um repositório
 * construído fora dela escreveria em autocommit — que é a forma silenciosa de
 * quebrar a atomicidade de RF-23.
 */
export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(walletRowSchema, toWalletRow(wallet));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(walletRowSchema, { id }, READ_WITHOUT_IDENTITY_MAP);

    return row === null ? undefined : toWallet(row);
  }

  /**
   * **Ponto único de aquisição do lock de wallet** (D-002, RI-06, EL-02).
   *
   * `LockMode.PESSIMISTIC_WRITE` emite `SELECT ... FOR UPDATE` — confirmado no
   * SQL efetivamente emitido, primeiro no spike E-00 e depois em
   * `tests/integration/wallet-lock.test.ts`, que amarra a garantia a este
   * método. O banco serializa por wallet; wallets diferentes não se veem, então
   * não há lock global (RI-06).
   *
   * Se aparecer um segundo lugar no código que trave wallet, RI-06 passa a ser
   * violado por dispersão e não por desenho — é este método, e só ele, que
   * qualquer revisão precisa auditar.
   *
   * Fora de uma transação o próprio MikroORM recusa a chamada
   * (`checkLockRequirements`), o que é a guarda certa: um `FOR UPDATE` em
   * autocommit soltaria o lock no fim da própria query e daria a impressão de
   * proteção sem proteger nada.
   */
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      walletRowSchema,
      { id },
      { ...READ_WITHOUT_IDENTITY_MAP, lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    return row === null ? undefined : toWallet(row);
  }

  async update(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(walletRowSchema, { id: wallet.id }, toWalletUpdate(wallet));
  }
}
