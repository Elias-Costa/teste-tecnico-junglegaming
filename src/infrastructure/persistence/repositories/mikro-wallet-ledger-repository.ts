import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  LedgerPageQuery,
  WalletLedgerRepository,
} from "../../../domain/repositories/wallet-ledger-repository.ts";
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

  /**
   * Página do ledger por keyset (RF-10, D-014).
   *
   * O predicado é `id > afterId`, e não um `OFFSET`: com `OFFSET`, um lançamento
   * gravado entre duas requisições empurraria a janela e o cliente leria a mesma
   * linha duas vezes — ou pularia uma. O índice `(wallet_id, id)` de E-05 é
   * exatamente este acesso.
   *
   * A ordenação é pelo id porque ele é UUIDv7: ordem cronológica e ordem total
   * na mesma coluna, que é o que D-014 comprou ao rejeitar o par `(created_at, id)`.
   */
  async findPage(query: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    const rows = await this.em.find(
      walletLedgerEntryRowSchema,
      {
        walletId: query.walletId,
        ...(query.afterId === undefined ? {} : { id: { $gt: query.afterId } }),
      },
      { ...READ_WITHOUT_IDENTITY_MAP, orderBy: { id: "asc" }, limit: query.limit },
    );

    return rows.map(toWalletLedgerEntry);
  }
}
