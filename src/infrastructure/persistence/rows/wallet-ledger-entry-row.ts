import { EntitySchema } from "@mikro-orm/core";
import type { LedgerDirection } from "../../../domain/ledger-direction.ts";

/**
 * A tabela `wallet_ledger_entries` como linha (D-026).
 *
 * Todas as colunas são obrigatórias: o lançamento nasce completo e nunca muda.
 * A linha não tem — e não pode ganhar — coluna de estado mutável, porque
 * qualquer `UPDATE` sobre esta tabela morre no `P0001` da trigger de D-023
 * (RI-05, EL-07).
 */
export interface WalletLedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  /** Coluna `numeric(19,2)` lida como string (D-004, EL-01). Sempre positiva (D-021). */
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

/** Mapeamento da linha do ledger. */
export const walletLedgerEntryRowSchema = new EntitySchema<WalletLedgerEntryRow>({
  name: "WalletLedgerEntryRow",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", columnType: "uuid", fieldName: "id", primary: true },
    walletId: { type: "uuid", columnType: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", columnType: "uuid", fieldName: "transaction_id" },
    direction: { type: "string", columnType: "varchar(10)", fieldName: "direction" },
    amount: { type: "string", columnType: "numeric(19,2)", fieldName: "amount" },
    currency: { type: "string", columnType: "varchar(3)", fieldName: "currency" },
    balanceBefore: { type: "string", columnType: "numeric(19,2)", fieldName: "balance_before" },
    balanceAfter: { type: "string", columnType: "numeric(19,2)", fieldName: "balance_after" },
    createdAt: { type: "datetime", columnType: "timestamptz", fieldName: "created_at" },
  },
});
