import type { Money } from "../money.ts";

/**
 * Tentativa de abrir uma wallet com saldo inicial negativo (RF-02, EL-02).
 *
 * Erro de programação, não caminho de negócio: `Money.from()` já rejeita
 * negativo no contrato de entrada (RF-01), então um saldo inicial negativo só
 * pode ter vindo de aritmética interna — `negate()` ou `subtract()`. A guarda
 * existe porque "saldo nunca negativo" é invariante eliminatória e não deve
 * depender de nenhuma validação a montante continuar existindo.
 *
 * Distinto de `InsufficientFundsError`, que é o débito recusado com saldo válido.
 */
export class NegativeBalanceError extends Error {
  constructor(public readonly balance: Money) {
    super(`saldo inicial não pode ser negativo, recebido ${balance.toString()} (RF-02).`);
    this.name = "NegativeBalanceError";
  }
}
