/**
 * Códigos de rejeição por **regra de negócio** (RN-17, D-007).
 *
 * Lista fechada: adicionar um código é mudança de contrato e passa por
 * `docs/decisions.md`. A ação esperada do provedor para cada código é
 * **documentada** em `ARCHITECTURE.md`, não transmitida na resposta — código e
 * ação transmitidos juntos poderiam divergir numa adição futura, e o provedor
 * receberia dois sinais conflitantes sobre o que fazer.
 *
 * Estes são os códigos que acompanham o status `REJECTED`.
 */
export enum BusinessFailureCode {
  /** `BET` sem saldo suficiente (RN-01). */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /**
   * Reversão que produziria saldo negativo (RN-16).
   *
   * Distinto de `InsufficientFunds` por exigência explícita de RN-16: apostar
   * sem saldo é rotina, reverter sem saldo é anomalia operacional que alguém
   * precisa investigar. Colapsar os dois esconderia a segunda dentro da primeira.
   */
  InsufficientFundsOnReversal = "INSUFFICIENT_FUNDS_ON_REVERSAL",
  /** Referência não resolvida após esgotar o TTL de D-008 (RF-26). */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** Referência existe mas diverge em provider, player, wallet, moeda ou rodada (RN-07). */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** `REFUND` sobre não-`BET`, ou `ROLLBACK` sobre kind não permitido (RN-08). */
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  /** Referência já revertida pelo mesmo tipo de operação (RN-09). */
  AlreadyReversed = "ALREADY_REVERSED",
  /** Valor diferente do valor da referência (RN-10). */
  AmountMismatch = "AMOUNT_MISMATCH",
  /** Moeda da operação diferente da moeda da wallet (RF-02). */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** Mesma idempotency key com payload diferente (RN-14). */
  IdempotencyConflict = "IDEMPOTENCY_CONFLICT",
  /** Wallet inexistente. */
  WalletNotFound = "WALLET_NOT_FOUND",
  /** `OPENING` submetido externamente (RN-13). */
  KindNotSubmittable = "KIND_NOT_SUBMITTABLE",
}

/**
 * Códigos de falha de **infraestrutura** (D-007, D-013).
 *
 * Enum separado de propósito: D-013 estabelece que `FAILED` só é escrito em erro
 * permanente ou esgotamento para DLQ, e que erro transitório não toca o status.
 * Com dois enums, `reject(MAX_RETRIES_EXHAUSTED)` e `fail(INSUFFICIENT_FUNDS)`
 * viram erro de compilação em vez de convenção que alguém precisa lembrar.
 *
 * **Os dois códigos estão reservados e nenhum é atribuído nesta entrega**
 * (D-047, D-064) — pelo mesmo motivo que `WagerTransactionStatus.Failed` não tem
 * emissor, documentado lá. O enum continua existindo porque é ele que faz o
 * compilador impor a separação de D-013: sem ele, a regra viraria comentário.
 */
export enum InfrastructureFailureCode {
  /** Erro permanente de infraestrutura identificado no processamento. */
  PermanentInfrastructureError = "PERMANENT_INFRASTRUCTURE_ERROR",
  /** Mensagem esgotou as tentativas e foi para a DLQ (RF-21). */
  MaxRetriesExhausted = "MAX_RETRIES_EXHAUSTED",
}

/**
 * Taxonomia completa de falha — os **13** códigos fechados de D-007.
 *
 * A união existe para o campo persistido e para quem só precisa ler o código
 * (`WagerTransaction.failureCode`). Quem **escreve** passa pelos enums
 * específicos, que é onde a separação de D-013 é imposta.
 */
export type FailureCode = BusinessFailureCode | InfrastructureFailureCode;
