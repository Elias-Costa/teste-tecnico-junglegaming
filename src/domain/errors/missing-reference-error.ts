import type { WagerTransactionKind } from "../wager-transaction.ts";

/**
 * `REFUND` ou `ROLLBACK` submetido sem `referenceExternalTransactionId` (RN-06, D-020).
 *
 * É **payload inválido**, não rejeição de negócio: D-006 mapeia para `400` e
 * nenhuma transação chega a nascer. A distinção importa porque a taxonomia de
 * D-007 está fechada em 13 códigos e nenhum deles descreve "a referência não
 * veio no payload" — `REFERENCE_NOT_FOUND` é o esgotamento do TTL de RF-26,
 * situação em que o provedor mandou a referência e ela nunca apareceu.
 * Reusar aquele código aqui tiraria do provedor a distinção entre "corrija o
 * payload" e "desista", que é exatamente o que a §7.2 do enunciado pede.
 */
export class MissingReferenceError extends Error {
  constructor(public readonly kind: WagerTransactionKind) {
    super(`${kind} exige referenceExternalTransactionId (RN-06).`);
    this.name = "MissingReferenceError";
  }
}
