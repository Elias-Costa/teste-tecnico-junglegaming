import type { WalletLedgerEntry } from "../wallet-ledger-entry.ts";

/**
 * Uma fatia do ledger de uma wallet, em ordem cronológica (RF-10, D-014).
 *
 * `afterId` é o **id do último lançamento já entregue**, não um número de página:
 * a paginação é keyset sobre o id UUIDv7, então inserção concorrente não
 * desloca o que o cliente ainda não leu. Ausente, a leitura começa do início.
 */
export interface LedgerPageQuery {
  walletId: string;
  afterId?: string | undefined;
  /** Quantidade máxima de lançamentos a devolver. Inteiro de operação, nunca dinheiro. */
  limit: number;
}

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

  /**
   * Lê uma página do ledger em ordem crescente de id (RF-10, RF-16).
   *
   * Serve aos **dois** leitores do ledger, e de propósito: a paginação de RF-10
   * e a soma da reconciliação de RF-16 fazem a mesma pergunta com tamanhos de
   * página diferentes. Uma segunda consulta "que lê tudo" para a reconciliação
   * faria o endpoint deixar de caber na memória no dia em que um ledger crescer.
   *
   * A ordem é total e determinística porque o id é UUIDv7 (D-014) — é o que
   * torna o cursor estável sob inserção concorrente.
   */
  findPage(query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
}
