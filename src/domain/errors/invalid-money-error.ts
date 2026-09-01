/**
 * Entrada rejeitada pelas factories de `Money` (RF-01).
 *
 * Cobre as duas metades do `MoneyProps` num tipo só: valor fora do formato
 * canônico (D-015) e moeda fora de `[A-Z]{3}` (D-016). Separá-los criaria uma
 * distinção que ninguém consome — D-006 mapeia ambos para o mesmo `400`, porque
 * nos dois casos o payload que chegou está malformado.
 */
export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}
