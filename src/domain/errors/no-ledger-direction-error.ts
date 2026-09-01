/**
 * `ledgerDirectionFor` chamado onde não existe direção de lançamento (RF-04).
 *
 * Duas situações, ambas erro de programação:
 *
 * - **`LOSS`** — RN-03 e RF-04 dizem que a operação não move saldo e não gera
 *   lançamento. Perguntar a direção de um lançamento que não vai existir é bug
 *   do chamador, que deveria ter consultado `affectsBalance()` antes.
 * - **`ROLLBACK` sem a referência resolvida** — RN-05 define a direção como o
 *   inverso da referência, então ela não é derivável do kind sozinho. Devolver
 *   um palpite aqui inverteria o sinal de um estorno em silêncio.
 */
export class NoLedgerDirectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoLedgerDirectionError";
  }
}
