import type { Money } from "../money.ts";

/**
 * Débito que produziria saldo negativo, recusado pelo agregado (RF-02, EL-02).
 *
 * É a **guarda de último recurso** de D-019, não o caminho de negócio: o use
 * case decide a rejeição consultando `Wallet.hasSufficientBalanceFor()`, porque
 * só ele sabe o kind e, portanto, se o `failureCode` é `INSUFFICIENT_FUNDS` ou
 * `INSUFFICIENT_FUNDS_ON_REVERSAL` (RN-16). Este erro existe para que um caminho
 * novo que esqueça a consulta falhe alto em vez de gravar saldo negativo — EL-02
 * é eliminatória, e uma barreira só (o `CHECK` do banco em E-05) é barreira pouca.
 *
 * Carrega saldo e valor pedido em campos porque o log estruturado de RNF-06
 * precisa deles separados; note que RNF-06 proíbe payload financeiro completo,
 * não os dois valores que explicam a recusa.
 */
export class InsufficientFundsError extends Error {
  constructor(
    public readonly balance: Money,
    public readonly requested: Money,
  ) {
    super(`saldo insuficiente: disponível ${balance.toString()}, pedido ${requested.toString()}.`);
    this.name = "InsufficientFundsError";
  }
}
