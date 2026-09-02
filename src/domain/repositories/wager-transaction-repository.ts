import type { WagerTransaction, WagerTransactionKind } from "../wager-transaction.ts";

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

  /**
   * Consulta pela idempotency key — a pergunta que decide replay (RF-14, RN-12).
   *
   * A key é a fonte da verdade da idempotência, e a unicidade dela é do banco
   * (RI-09, EL-04): este finder é o caminho rápido que devolve o resultado
   * original, não a garantia. A garantia é o `UNIQUE (idempotency_key)`, que
   * continua valendo quando duas instâncias perguntam ao mesmo tempo.
   */
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;

  /**
   * Consulta pela identidade da transação no provedor (RN-07, RF-12).
   *
   * É por este par que `REFUND` e `ROLLBACK` resolvem a transação que revertem:
   * o provedor não conhece o id interno, então a referência que ele manda é o
   * `externalTransactionId` da operação original. O mesmo caminho de leitura
   * serve à consulta de RF-12.
   */
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;

  /**
   * Verdadeiro se a referência já foi revertida por uma operação deste tipo (RN-09).
   *
   * **Caminho de negócio, não garantia.** Quem impede a segunda reversão é o
   * índice parcial `uq_wager_transactions_reversal_once` (D-024, RI-09), que
   * continua valendo quando duas instâncias perguntam ao mesmo tempo. Esta
   * consulta existe para o use case responder `ALREADY_REVERSED` (RN-17) em vez
   * de deixar o provedor receber um erro de integridade sem código legível.
   *
   * @param kind tipo da reversão — `REFUND` e `ROLLBACK` contam separadamente,
   * porque RN-09 proíbe reverter duas vezes **pelo mesmo tipo**, não duas vezes.
   */
  hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;

  /** Persiste o resultado de uma transição de estado. */
  update(transaction: WagerTransaction): Promise<void>;
}
