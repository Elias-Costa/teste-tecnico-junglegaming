import type { WagerTransactionStatus } from "../wager-transaction.ts";

/**
 * Transição fora do grafo fechado de D-013 (RF-03, RT-07).
 *
 * É **erro de programação, não caminho de negócio** — o enunciado é explícito
 * nisso na §6.3. Uma transação que chegou a `PROCESSED`, `REJECTED` ou `FAILED`
 * não muda mais de estado, e quem tentar mudá-la tem um bug, não uma rejeição
 * para devolver ao provedor. Por isso não existe `failureCode` correspondente.
 *
 * Carrega origem e destino porque a mensagem formatada não é interface: um log
 * estruturado (RNF-06) precisa dos dois valores em campos, não dentro de texto.
 */
export class InvalidTransactionStateError extends Error {
  constructor(
    public readonly from: WagerTransactionStatus,
    public readonly to: WagerTransactionStatus,
  ) {
    super(`transição inválida de ${from} para ${to} (D-013).`);
    this.name = "InvalidTransactionStateError";
  }
}
