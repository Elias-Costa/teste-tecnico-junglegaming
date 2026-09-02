import type { OpenWalletCommand } from "../../../application/open-wallet.ts";
import { asObject, requiredMoney, requiredString } from "./parse.ts";

/**
 * Traduz o corpo de `POST /wallets` no comando de abertura (RF-08).
 *
 * Só checa forma (D-038). O saldo inicial segue como DTO: quem decide se
 * `"1000.00"` é um valor aceitável é `Money.from` no use case (D-015, D-016), e
 * quem decide que negativo não abre wallet é `Wallet.open` — as duas respostas
 * viram `400` pelo mesmo mapa de D-006, sem que esta função precise conhecê-las.
 *
 * @throws InvalidPayloadError se o corpo não tiver a forma esperada.
 */
export function parseOpenWalletRequest(body: unknown, correlationId: string): OpenWalletCommand {
  const source = asObject(body, "corpo da requisição");

  return {
    playerId: requiredString(source, "playerId"),
    initialBalance: requiredMoney(source, "initialBalance"),
    correlationId,
  };
}
