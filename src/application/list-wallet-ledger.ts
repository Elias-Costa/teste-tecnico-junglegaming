import type { LedgerDirection } from "../domain/ledger-direction.ts";
import type { MoneyProps } from "../domain/money.ts";
import { ResourceNotFoundError } from "./errors/resource-not-found-error.ts";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor.ts";
import type { UnitOfWork } from "./ports/unit-of-work.ts";

/** Um lançamento como o cliente o vê (RF-10, D-059). Todo dinheiro é `MoneyProps` (EL-01). */
export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** ISO 8601 explícito (D-059). */
  createdAt: string;
}

/**
 * Uma página do ledger (RF-10).
 *
 * `nextCursor` é `null` na última página — e `null`, não ausente, porque aqui a
 * distinção importa: o cliente pagina **enquanto** houver cursor, e um campo
 * omitido o obrigaria a distinguir "acabou" de "o servidor esqueceu".
 */
export interface LedgerPageView {
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

/** Pedido de uma página: a wallet, de onde continuar e quantos lançamentos. */
export interface ListWalletLedgerQuery {
  walletId: string;
  /** Cursor opaco devolvido pela página anterior; ausente começa do início. */
  cursor?: string | undefined;
  limit: number;
}

/**
 * Lista o ledger de uma wallet, paginado por cursor (RF-10, D-014).
 *
 * Pede **um lançamento a mais** do que o cliente pediu para saber se há próxima
 * página, e devolve só o que foi pedido. A alternativa — devolver `nextCursor`
 * sempre que a página vier cheia — faria a última página cheia apontar para uma
 * página vazia, e o cliente gastaria uma requisição para descobrir isso.
 */
export class ListWalletLedger {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * @throws ResourceNotFoundError se a wallet não existe (D-056 → 404). Sem esta
   * checagem, uma wallet inexistente responderia página vazia — indistinguível
   * de uma wallet real sem lançamentos.
   * @throws InvalidCursorError se o cursor não decodifica para um id (→ 400).
   */
  async execute(query: ListWalletLedgerQuery): Promise<LedgerPageView> {
    const afterId = query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor);

    return this.unitOfWork.run(async (repos) => {
      const wallet = await repos.wallets.findById(query.walletId);

      if (wallet === undefined) {
        throw new ResourceNotFoundError("wallet", query.walletId);
      }

      const found = await repos.ledger.findPage({
        walletId: query.walletId,
        afterId,
        limit: query.limit + 1,
      });

      const hasMore = found.length > query.limit;
      const page = hasMore ? found.slice(0, query.limit) : found;
      const last = page[page.length - 1];

      return {
        entries: page.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: hasMore && last !== undefined ? encodeLedgerCursor(last.id) : null,
      };
    });
  }
}
