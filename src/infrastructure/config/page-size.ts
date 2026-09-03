/**
 * Tamanho de página das consultas paginadas (RF-10, D-058).
 *
 * **Este arquivo mora aqui por causa de EL-01.** A guarda de lint de E-01 bane
 * `Number()` e `parseInt` em todo `src/`, com exceção estreita apenas neste
 * diretório — que já é, de fato, o dono dos inteiros que entram no sistema como
 * texto: porta do banco, tamanho de lote, limites de retry (D-008) e a contagem
 * de recebimento do SQS (E-11). Tamanho de página é o mesmo tipo de valor.
 * Ampliar a exceção do lint até o parser de DTO seria a saída fácil, e E-11 já
 * registrou por que ela não é a saída.
 */

/** Padrão quando o cliente não manda `limit` — o valor que a URL de RF-10 exibe. */
export const DEFAULT_LEDGER_PAGE_SIZE = 50;

/** Teto aceito. Acima disso é `400`, não redução silenciosa (D-058). */
export const MAX_LEDGER_PAGE_SIZE = 200;

/** Forma aceita: inteiro positivo, sem zero à esquerda, no máximo 4 dígitos. */
const PAGE_SIZE_FORMAT = /^[1-9][0-9]{0,3}$/;

/**
 * Converte o `limit` da query string em inteiro, ou devolve `undefined` (D-058).
 *
 * **Não lança de propósito.** Quem transforma "malformado" em `InvalidPayloadError`
 * é a borda HTTP, que é a dona dos erros de forma (D-038); se este módulo
 * lançasse o erro da borda, `src/infrastructure` passaria a importar de
 * `src/interface`, invertendo a direção das dependências.
 *
 * Um valor acima do teto é recusado, e não reduzido: um limite ajustado em
 * silêncio faria o cliente parar de paginar achando que já recebeu tudo.
 *
 * @param raw valor cru da query string.
 * @returns o inteiro validado, ou `undefined` se a forma ou o intervalo não servirem.
 */
export function parseLedgerPageSize(raw: string): number | undefined {
  if (!PAGE_SIZE_FORMAT.test(raw)) {
    return undefined;
  }

  const value = Number(raw);

  return value > MAX_LEDGER_PAGE_SIZE ? undefined : value;
}
