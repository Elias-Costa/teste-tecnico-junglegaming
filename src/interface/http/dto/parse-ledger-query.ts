import {
  DEFAULT_LEDGER_PAGE_SIZE,
  MAX_LEDGER_PAGE_SIZE,
  parseLedgerPageSize,
} from "../../../infrastructure/config/page-size.ts";
import { InvalidPayloadError } from "../errors/invalid-payload-error.ts";

/** A query string de RF-10 já validada: de onde continuar e quantos lançamentos. */
export interface LedgerQuery {
  cursor: string | undefined;
  limit: number;
}

/**
 * Traduz `?cursor=...&limit=50` (RF-10, D-038, D-058).
 *
 * Checa **forma**, como todo parser desta borda. O conteúdo do cursor é
 * validado por quem sabe o que ele significa — o codec da camada de aplicação —,
 * e a conversão do `limit` em inteiro vem de `infrastructure/config`, porque a
 * guarda de EL-01 não permite `Number()` aqui (D-058).
 *
 * Parâmetro repetido (`?limit=1&limit=2`) chega como array e é recusado: duas
 * respostas possíveis para a mesma pergunta não têm desempate correto — mesmo
 * argumento do `Idempotency-Key` repetido em `requiredHeader`.
 *
 * @throws InvalidPayloadError se cursor ou limit não tiverem forma aceitável.
 */
export function parseLedgerQuery(query: Record<string, unknown>): LedgerQuery {
  return { cursor: parseCursor(query["cursor"]), limit: parseLimit(query["limit"]) };
}

/** Cursor ausente é início da lista; presente precisa ser texto não vazio. */
function parseCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidPayloadError("cursor precisa ser o texto devolvido em `nextCursor`.");
  }

  return value;
}

/** Limit ausente vale o padrão de D-058; fora da forma ou acima do teto é `400`. */
function parseLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_LEDGER_PAGE_SIZE;
  }

  if (typeof value !== "string") {
    throw new InvalidPayloadError("limit precisa ser um inteiro em texto.");
  }

  const limit = parseLedgerPageSize(value);

  if (limit === undefined) {
    throw new InvalidPayloadError(
      `limit precisa ser um inteiro entre 1 e ${String(MAX_LEDGER_PAGE_SIZE)}.`,
    );
  }

  return limit;
}
