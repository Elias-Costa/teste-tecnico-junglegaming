import { inboxMessageRowSchema } from "./inbox-message-row.ts";
import { outboxMessageRowSchema } from "./outbox-message-row.ts";
import { wagerTransactionRowSchema } from "./wager-transaction-row.ts";
import { walletLedgerEntryRowSchema } from "./wallet-ledger-entry-row.ts";
import { walletRowSchema } from "./wallet-row.ts";

/**
 * Lista explícita dos mapeamentos, para `entities` em `orm-config.ts`.
 *
 * Mesmo motivo de `migrations/index.ts`: o MikroORM também descobre entidades
 * varrendo pasta por glob, mas a descoberta por filesystem depende de o processo
 * rodar de `src/` ou de `dist/` — e este projeto roda TS direto no Bun, sem
 * build. Um arquivo que ninguém importa também some do `tsc --noEmit` e do lint,
 * que são o gate de toda etapa (`AGENTS.md` §5).
 *
 * A ordem é a das dependências de chave estrangeira, e é decorativa: por D-028
 * quem manda na ordem dos `INSERT` é o código do repositório, não esta lista.
 */
export const ROW_SCHEMAS = [
  walletRowSchema,
  wagerTransactionRowSchema,
  walletLedgerEntryRowSchema,
  inboxMessageRowSchema,
  outboxMessageRowSchema,
] as const;
