import type { WagerTransactionKind } from "../../domain/wager-transaction.ts";

/**
 * Linha em `PENDING_REFERENCE` cujo kind não reverte nada (RF-26, D-013).
 *
 * **Erro de programação, não caminho de negócio**, na mesma família de
 * `InvalidTransactionStateError`: o único ponto do sistema que escreve
 * `PENDING_REFERENCE` é o ramo de `REFUND`/`ROLLBACK` de `decideReversal`, então
 * uma linha ali com qualquer outro kind não veio de nenhum caminho de execução —
 * veio de edição manual ou de restauração malfeita. Não existe `failureCode`
 * correspondente, e não deve existir: nenhum dos 13 códigos de D-007 descreve
 * "esta linha não deveria estar neste estado".
 *
 * Reagendá-la em silêncio seria pior do que falhar: ela voltaria a cada ciclo do
 * worker, para sempre, sem ninguém descobrir por quê.
 */
export class UnresolvablePendingReferenceError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly kind: WagerTransactionKind,
  ) {
    super(
      `transação ${transactionId} está em PENDING_REFERENCE com kind ${kind}, ` +
        `que não reverte nenhuma referência (RN-04, RN-05).`,
    );
    this.name = "UnresolvablePendingReferenceError";
  }
}
