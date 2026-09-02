/**
 * Wallet já existente para o mesmo `playerId` + `currency` (RF-08, D-035).
 *
 * A garantia é do banco: `uq_wallets_player_currency` (E-05) é quem recusa a
 * segunda wallet, como RI-09 exige. Este erro é a **tradução** dessa recusa para
 * uma linguagem que a aplicação entende — o repositório converte a exceção do
 * MikroORM aqui, porque só ele sabe qual das cinco constraints únicas desta base
 * foi violada, e porque `src/application` não pode importar o ORM (D-028).
 *
 * **Não carrega `failureCode`**, e a ausência é decisão, não esquecimento: os 13
 * códigos de D-007 estão fechados e nenhum descreve "wallet já existe". Este
 * `409` responde só mensagem — ao contrário do `409` de idempotência, que carrega
 * `IDEMPOTENCY_CONFLICT` porque esse código existe na taxonomia (D-031).
 */
export class WalletAlreadyExistsError extends Error {
  constructor(
    public readonly playerId: string,
    public readonly currency: string,
  ) {
    super(`jogador ${playerId} já tem wallet em ${currency} (RF-08).`);
    this.name = "WalletAlreadyExistsError";
  }
}
