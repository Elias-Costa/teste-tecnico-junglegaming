import { WalletLedgerEntry } from "../../../domain/wallet-ledger-entry.ts";
import { moneyFromColumns, moneyToColumns } from "../money-mapper.ts";
import type { WalletLedgerEntryRow } from "../rows/wallet-ledger-entry-row.ts";

/**
 * Converte o lançamento para a linha, para `insert`.
 *
 * **Não existe contraparte de `update`** — nem aqui, nem na porta (D-027), nem
 * no banco (D-023). O ledger só aceita `insert` (RI-05, EL-07).
 *
 * As três colunas monetárias compartilham a mesma coluna `currency`: `Money`
 * já garante que valor, saldo anterior e saldo posterior são da mesma moeda —
 * `isBalanced()` opera sobre os três e lança em moeda divergente (D-017) —,
 * então guardar três moedas seria guardar três vezes o mesmo fato.
 */
export function toWalletLedgerEntryRow(entry: WalletLedgerEntry): WalletLedgerEntryRow {
  const money = moneyToColumns(entry.money);

  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: money.amount,
    currency: money.currency,
    balanceBefore: moneyToColumns(entry.balanceBefore).amount,
    balanceAfter: moneyToColumns(entry.balanceAfter).amount,
    createdAt: entry.createdAt,
  };
}

/**
 * Reconstrói o lançamento a partir da linha (D-026).
 *
 * `rehydrate` e não `create`: o que está no banco já passou pela aritmética de
 * `create` e pelo `CHECK` de balanceamento de E-05. Revalidar na leitura
 * transformaria um dado histórico legítimo em exceção durante a reconciliação
 * de RF-16, que é exatamente quando ler tudo precisa funcionar.
 */
export function toWalletLedgerEntry(row: WalletLedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction,
    money: moneyFromColumns(row.amount, row.currency),
    balanceBefore: moneyFromColumns(row.balanceBefore, row.currency),
    balanceAfter: moneyFromColumns(row.balanceAfter, row.currency),
    createdAt: row.createdAt,
  });
}
