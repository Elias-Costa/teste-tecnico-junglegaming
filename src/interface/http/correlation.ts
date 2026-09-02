import type { IdGenerator } from "../../application/ports/id-generator.ts";

/** Header de correlação de ponta a ponta (RNF-06, D-039). */
export const CORRELATION_HEADER = "x-correlation-id";

/**
 * Forma aceita para um `correlationId` vindo de fora.
 *
 * O valor é **ecoado num header de resposta**, então precisa ser inerte:
 * qualquer coisa fora deste alfabeto — `\r`, `\n`, espaço — sai daqui recusada,
 * e não sanitizada, porque um valor "consertado" não corresponde mais ao que o
 * provedor mandou e o rastro deixa de fechar dos dois lados.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Resolve o `correlationId` da requisição (D-039).
 *
 * Usa o `X-Correlation-Id` do provedor quando ele manda um, e gera um UUIDv7
 * quando não manda. Gerar sempre quebraria o rastro de quem já correlaciona do
 * seu lado; exigir o header acrescentaria a RF-13 um segundo header obrigatório
 * que o enunciado não pede.
 *
 * Um header presente mas malformado é **substituído**, não recusado: correlação
 * é observabilidade, e derrubar uma aposta válida por causa do id de log seria
 * trocar dinheiro por telemetria.
 *
 * O id gerado sai do mesmo `IdGenerator` de D-014 — uma fonte de id no projeto.
 */
export function resolveCorrelationId(header: unknown, ids: IdGenerator): string {
  if (typeof header === "string" && SAFE_CORRELATION_ID.test(header)) {
    return header;
  }

  return ids.next();
}
