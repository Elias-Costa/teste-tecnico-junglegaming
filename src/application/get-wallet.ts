import type { MoneyProps } from "../domain/money.ts";
import { ResourceNotFoundError } from "./errors/resource-not-found-error.ts";
import type { UnitOfWork } from "./ports/unit-of-work.ts";

/**
 * Estado corrente da wallet (RF-09, D-059).
 *
 * **A mesma forma que RF-08 devolve na abertura**, e isso é decisão: uma forma
 * por recurso, nos dois verbos. Um `GET` que respondesse campos diferentes do
 * `POST` obrigaria o provedor a manter dois modelos para a mesma wallet.
 */
export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Consulta o estado corrente de uma wallet (RF-09).
 *
 * Entra por `findById`, **sem lock**: leitura não disputa saldo com ninguém, e
 * travar a wallet para responder um `GET` transformaria uma consulta de
 * observabilidade em contenção no caminho do dinheiro. O único caminho de
 * leitura que trava é a reconciliação, e por motivo registrado (D-057).
 */
export class GetWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * @throws ResourceNotFoundError se a wallet não existe (D-056 → 404).
   */
  async execute(walletId: string): Promise<WalletView> {
    return this.unitOfWork.run(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);

      if (wallet === undefined) {
        throw new ResourceNotFoundError("wallet", walletId);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
