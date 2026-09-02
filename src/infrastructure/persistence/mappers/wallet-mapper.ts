import { Wallet } from "../../../domain/wallet.ts";
import { moneyFromColumns, moneyToColumns } from "../money-mapper.ts";
import type { WalletRow } from "../rows/wallet-row.ts";

/**
 * As colunas que um `update` de wallet escreve (D-028).
 *
 * A lista é fechada e vive num tipo: `id`, `playerId`, `currency` e `createdAt`
 * são imutáveis depois da abertura, e um `update` que os incluísse permitiria
 * reescrever a identidade da wallet por engano. Com `Pick`, tentar escrever
 * qualquer outra coluna não compila.
 */
export type WalletUpdate = Pick<WalletRow, "balance" | "version" | "updatedAt">;

/** Converte a wallet para a linha completa, para `insert`. */
export function toWalletRow(wallet: Wallet): WalletRow {
  const balance = moneyToColumns(wallet.balance);

  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

/** Extrai apenas o que muda quando o saldo se move (RF-02). */
export function toWalletUpdate(wallet: Wallet): WalletUpdate {
  return {
    balance: moneyToColumns(wallet.balance).amount,
    version: wallet.version,
    updatedAt: wallet.updatedAt,
  };
}

/**
 * Reconstrói o agregado a partir da linha (D-026).
 *
 * A moeda do saldo vem da coluna `currency` da própria wallet: `Money` é o par
 * valor+moeda, e o schema guarda os dois separados justamente para que `CHECK` e
 * `SUM` funcionem em SQL puro (D-004). Aqui os dois voltam a ser um.
 */
export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: moneyFromColumns(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
