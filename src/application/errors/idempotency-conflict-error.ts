import { BusinessFailureCode } from "../../domain/failure-code.ts";

/**
 * Mesma `Idempotency-Key` com payload diferente (RN-14, RF-14).
 *
 * É **conflito, não replay**: repetir a key mudando o valor da aposta não pode
 * devolver o resultado da primeira nem processar a segunda. D-006 mapeia para
 * `409`, e não para o `422` das demais rejeições, porque o eixo é outro — "este
 * recurso já existe com outro conteúdo", e não "a regra de negócio recusou".
 *
 * Como em D-031, a rejeição não vira linha: o `UNIQUE (idempotency_key)` de
 * E-05 impede uma segunda transação com a mesma key, o que torna a exceção a
 * única forma possível de responder — e faz da constraint, não do código, a
 * garantia de EL-04.
 */
export class IdempotencyConflictError extends Error {
  readonly failureCode = BusinessFailureCode.IdempotencyConflict;

  constructor(
    public readonly idempotencyKey: string,
    /** Id da transação que já ocupa a key — o que o provedor precisa consultar. */
    public readonly transactionId: string,
  ) {
    super(
      `idempotency key ${idempotencyKey} já registrada com outro payload ` +
        `na transação ${transactionId} (RN-14).`,
    );
    this.name = "IdempotencyConflictError";
  }
}
