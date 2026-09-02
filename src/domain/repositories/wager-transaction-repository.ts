import type { WagerTransaction } from "../wager-transaction.ts";

/**
 * Persistência da entidade `WagerTransaction` (RF-03, D-027).
 *
 * `update` escreve apenas o que as transições de D-013 alteram — status,
 * referência resolvida, `failureCode` e `processedAt`. A identidade e o payload
 * são imutáveis do nascimento ao terminal, e o contador de tentativas de
 * referência não tem dono no domínio (D-029).
 */
export interface WagerTransactionRepository {
  /** Grava uma transação recém-criada, em `PENDING`. */
  insert(transaction: WagerTransaction): Promise<void>;

  /** Consulta por id interno — o caminho de RF-11. */
  findById(id: string): Promise<WagerTransaction | undefined>;

  /** Persiste o resultado de uma transição de estado. */
  update(transaction: WagerTransaction): Promise<void>;
}
