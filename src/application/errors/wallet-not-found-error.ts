import { BusinessFailureCode } from "../../domain/failure-code.ts";

/**
 * Operação submetida para uma wallet que não existe (D-007, D-031).
 *
 * **Rejeição que não vira linha, e a exceção é a forma disso.** D-007 lista
 * `WALLET_NOT_FOUND` entre os códigos de negócio, e o desenho geral persiste
 * toda rejeição como transação terminal auditável (RN-11). Aqui isso é
 * impossível: `fk_wager_transactions_wallet` (E-05) recusa uma transação que
 * aponta para wallet inexistente, então **nada** é gravado e nenhum evento é
 * publicado — a alternativa seria um evento sobre um agregado que não existe.
 *
 * D-031 fechou a contradição entre os dois documentos a favor da FK: a
 * integridade referencial que RI-09 cobra vale mais do que a uniformidade de
 * "toda rejeição é uma linha". A consequência é que `WALLET_NOT_FOUND` e
 * `IDEMPOTENCY_CONFLICT` são os dois códigos de D-007 que nunca aparecem na
 * coluna `failure_code` — e isso é estrutural, imposto por constraint, não uma
 * omissão do código.
 *
 * Carrega o `failureCode` para que o filtro de exceção de E-08 (D-006) responda
 * `422` com o mesmo código que uma rejeição persistida traria no corpo.
 */
export class WalletNotFoundError extends Error {
  readonly failureCode = BusinessFailureCode.WalletNotFound;

  constructor(public readonly walletId: string) {
    super(`wallet ${walletId} não existe.`);
    this.name = "WalletNotFoundError";
  }
}
