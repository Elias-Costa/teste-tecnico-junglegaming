import type { EntityManager } from "@mikro-orm/postgresql";
import type { WalletLedgerRepository } from "../../../domain/repositories/wallet-ledger-repository.ts";
import type { WalletLedgerEntry } from "../../../domain/wallet-ledger-entry.ts";
import {
  toWalletLedgerEntry,
  toWalletLedgerEntryRow,
} from "../mappers/wallet-ledger-entry-mapper.ts";
import { walletLedgerEntryRowSchema } from "../rows/wallet-ledger-entry-row.ts";
import { READ_WITHOUT_IDENTITY_MAP } from "./read-options.ts";

/**
 * Repositório do ledger sobre o MikroORM (RF-04, RI-05, EL-07).
 *
 * **`insert` é a única escrita, e não por convenção.** A porta não declara
 * `update` nem `delete` (D-027), a leitura não deixa linha rastreada (D-028), e
 * o banco recusaria de qualquer forma pela trigger de D-023. São três camadas
 * independentes protegendo a mesma invariante — a trilha de auditoria que RF-16
 * reconstrói só vale se ninguém puder reescrevê-la depois.
 */
export class MikroWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(walletLedgerEntryRowSchema, toWalletLedgerEntryRow(entry));
  }

  async findById(id: string): Promise<WalletLedgerEntry | undefined> {
    const row = await this.em.findOne(
      walletLedgerEntryRowSchema,
      { id },
      READ_WITHOUT_IDENTITY_MAP,
    );

    return row === null ? undefined : toWalletLedgerEntry(row);
  }
}
