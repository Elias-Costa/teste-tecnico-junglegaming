import type { FilterQuery } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction.ts";
import {
  type WagerTransactionRow,
  wagerTransactionRowSchema,
} from "../persistence/rows/wager-transaction-row.ts";
import { READ_WITHOUT_IDENTITY_MAP } from "../persistence/repositories/read-options.ts";

/**
 * Uma pendente devida, na forma mínima que o worker precisa (RF-26).
 *
 * Só o id e o contador: o agregado inteiro é relido **dentro** da transação que
 * trava a wallet, e devolver aqui uma `WagerTransaction` montada convidaria a
 * decidir a partir de uma leitura já obsoleta — que é exatamente o erro que a
 * releitura sob lock existe para evitar.
 */
export interface DuePendingReference {
  id: string;
  /** Tentativas **já** ocorridas — o expoente que `backoffDelayMs` espera (D-022). */
  referenceAttempts: number;
}

/**
 * As duas escritas operacionais das colunas de retry de referência (RF-26, D-052).
 *
 * Vive aqui, e não em `MikroWagerTransactionRepository`, pela mesma razão que
 * `OutboxClaimStore` não vive no repositório da outbox: o repositório persiste o
 * **agregado**, e estas duas colunas são **estado de entrega** — quantas vezes já
 * se tentou resolver a referência, e quando tentar de novo. D-029 as deixou sem
 * dono justamente para que E-13 pudesse escolher, e D-052 escolheu esta saída,
 * com D-043 (o lease da outbox) como precedente.
 *
 * A consequência prática está no `Pick<WagerTransactionUpdate>` do mapper: como
 * ele **não** lista estas colunas, um `update` de status vindo do use case nunca
 * sobrescreve o reagendamento escrito aqui, e vice-versa. As duas escritas
 * tocam a mesma linha sem disputar coluna nenhuma.
 *
 * **Nada aqui trava linha.** A disputa entre workers é resolvida pelo `FOR UPDATE`
 * da wallet dentro de `resolvePendingReference`, que é o ponto único de lock
 * exigido por RI-06. Um segundo lock aqui espalharia a aquisição por dois lugares.
 */
export class PendingReferenceStore {
  constructor(private readonly em: EntityManager) {}

  /**
   * Lista as pendentes cuja próxima tentativa já venceu (RF-26).
   *
   * **O ramo do nulo não é defensivo, é o caminho normal.** `decideReversal`
   * grava `PENDING_REFERENCE` deixando valer os defaults da tabela (D-029), então
   * toda pendente **nasce** com `next_reference_attempt_at` nulo. Uma varredura
   * que só comparasse datas deixaria a primeira tentativa de cada transação
   * invisível — ou seja, o worker nunca resolveria nada que ninguém tivesse
   * reagendado antes, o que é a totalidade dos casos reais.
   *
   * O filtro por kind espelha RN-04/RN-05: só `REFUND` e `ROLLBACK` alcançam este
   * status. É redundante com a lógica do use case, e de propósito — a varredura
   * é o caminho quente, e restringi-la aqui é mais barato que descobrir o
   * problema depois de travar a wallet.
   *
   * Ordem por id é ordem cronológica (UUIDv7, D-014). Importa para a cadeia de
   * D-050: quando um `ROLLBACK` espera por um `REFUND` que também espera,
   * resolver o mais antigo primeiro desencalha os dois no mesmo ciclo.
   */
  async findDue(now: Date, batchSize: number): Promise<DuePendingReference[]> {
    const rows = await this.em.find(wagerTransactionRowSchema, dueAt(now), {
      ...READ_WITHOUT_IDENTITY_MAP,
      limit: batchSize,
      orderBy: { id: "asc" },
    });

    return rows.map((row) => ({
      id: row.id,
      // A coluna é `not null default 0` no banco; o `?? 0` paga o preço de ela ser
      // **opcional no tipo da linha**, que é o que faz `em.insert()` omiti-la e o
      // default valer (D-029).
      referenceAttempts: row.referenceAttempts ?? 0,
    }));
  }

  /**
   * Persiste o reagendamento de uma tentativa que não resolveu (RF-26, D-022).
   *
   * O `status` no `where` é a guarda que substitui o lease da outbox: entre a
   * varredura e este `UPDATE`, outro worker pode ter resolvido a mesma transação
   * e levado a linha a `PROCESSED`/`REJECTED`. Sem ele, o reagendamento escreveria
   * um `next_reference_attempt_at` numa linha terminal — dado morto que ninguém
   * lê, mas que faria uma leitura de incidente duvidar do próprio status.
   *
   * `attempts` e `nextAttemptAt` chegam **já calculados** pelo worker, com a curva
   * de `backoffDelayMs` (D-008, D-022). Recalcular aqui criaria a terceira curva
   * que aquela decisão existe para impedir.
   */
  async scheduleRetry(id: string, attempts: number, nextAttemptAt: Date): Promise<void> {
    await this.em.nativeUpdate(
      wagerTransactionRowSchema,
      { id, status: WagerTransactionStatus.PendingReference },
      { referenceAttempts: attempts, nextReferenceAttemptAt: nextAttemptAt },
    );
  }
}

/**
 * O predicado da varredura: pendente, de reversão e devida.
 *
 * É o índice parcial `ix_wager_transactions_pending_reference` de E-05 lido em
 * forma de query — `status = 'PENDING_REFERENCE'` no `where` do índice,
 * `next_reference_attempt_at` na coluna dele.
 */
function dueAt(now: Date): FilterQuery<WagerTransactionRow> {
  return {
    status: WagerTransactionStatus.PendingReference,
    kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    $or: [{ nextReferenceAttemptAt: null }, { nextReferenceAttemptAt: { $lte: now } }],
  };
}
