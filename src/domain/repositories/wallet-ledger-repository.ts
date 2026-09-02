import type { WalletLedgerEntry } from "../wallet-ledger-entry.ts";

/**
 * Persistência do ledger da wallet (RF-04, RI-05, EL-07, D-027).
 *
 * **Não tem `update` nem `delete`, e a ausência é a mensagem.** A imutabilidade
 * do ledger é garantida em três camadas independentes: a entidade não tem campo
 * mutável (E-03), a trigger de D-023 recusa `UPDATE`/`DELETE` com `P0001`
 * (E-05), e esta porta não oferece assinatura para mutar. As duas primeiras
 * fazem o estado inválido falhar; esta faz o código que o tentaria não compilar.
 */
export interface WalletLedgerRepository {
  /** Grava um lançamento. É a **única** escrita que esta tabela aceita. */
  insert(entry: WalletLedgerEntry): Promise<void>;

  /** Lê um lançamento por id. */
  findById(id: string): Promise<WalletLedgerEntry | undefined>;
}
