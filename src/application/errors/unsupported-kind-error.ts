import type { WagerTransactionKind } from "../../domain/wager-transaction.ts";

/**
 * Kind que o use case ainda não sabe processar — **limite de etapa, não regra**.
 *
 * E-07 fecha `BET` (RN-01); `WIN`, `LOSS`, `REFUND` e `ROLLBACK` chegam em E-12,
 * e `OPENING` submetido de fora vira `KIND_NOT_SUBMITTABLE` na borda de E-08
 * (RN-13). Falhar alto é deliberado: a alternativa — processar o que dá e
 * ignorar o resto — deixaria uma operação financeira sem desfecho e sem sinal.
 *
 * **Não carrega `failureCode`**: nenhum dos 13 códigos de D-007 descreve "esta
 * versão ainda não implementa", e inventar um seria mudar contrato de
 * integração para registrar uma pendência de roteiro.
 */
export class UnsupportedKindError extends Error {
  constructor(public readonly kind: WagerTransactionKind) {
    super(`kind ${kind} ainda não é processado por este use case.`);
    this.name = "UnsupportedKindError";
  }
}
