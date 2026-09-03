import { isUuid } from "../../../domain/identifier.ts";
import type { MoneyProps } from "../../../domain/money.ts";
import { InvalidPayloadError } from "../errors/invalid-payload-error.ts";

/**
 * Primitivas do parser artesanal da borda (D-038).
 *
 * A escolha de não usar biblioteca está registrada em D-038: a validação de
 * **valor** já existe no domínio, e o que falta aqui é estritamente forma. Estas
 * funções são o vocabulário inteiro dessa checagem — quatro perguntas, nenhuma
 * delas sobre regra de negócio.
 *
 * Todas recebem `unknown` e devolvem tipo estreito ou lançam. Nenhuma converte:
 * um número onde se espera string é **erro**, não algo a coagir. É o que dá a
 * EL-01 uma barreira já na entrada — `{"amount": 25.5}` é recusado antes de o
 * ponto flutuante encostar em qualquer código de dinheiro.
 */

/** Comprimento máximo aceito num campo de identificação, alinhado ao schema (E-05). */
const MAX_IDENTIFIER_LENGTH = 120;

/**
 * Garante que o corpo é um objeto JSON.
 *
 * Array é recusado junto com `null` e primitivos: `typeof [] === "object"` faria
 * um array passar por objeto e cada campo obrigatório falhar depois, com uma
 * mensagem que não diz o que realmente está errado.
 *
 * @throws InvalidPayloadError se o valor não for um objeto JSON simples.
 */
export function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidPayloadError(`${what} precisa ser um objeto JSON.`);
  }

  return { ...value };
}

/**
 * Lê um campo de texto obrigatório.
 *
 * `null` tem mensagem própria porque tem significado próprio: D-005 manda
 * rejeitá-lo explicitamente, e quem o enviou provavelmente serializou um campo
 * ausente como `null` — dizer "omita o campo" resolve o problema de quem lê.
 *
 * Texto em branco é tratado como ausência: um `providerId` de espaços passaria
 * pelo `varchar` do schema e viraria uma identidade impossível de consultar.
 *
 * @param label nome usado na mensagem, quando difere da chave — é o que permite
 * a `money.amount` ser lida em `money` e ainda assim se identificar pelo caminho
 * completo no erro, que é como o provedor encontra o campo no corpo que enviou.
 * @throws InvalidPayloadError se estiver ausente, for `null`, não for texto,
 * estiver em branco ou exceder o limite da coluna.
 */
export function requiredString(
  source: Record<string, unknown>,
  key: string,
  label: string = key,
): string {
  const value = source[key];
  const field = label;

  if (value === null) {
    throw new InvalidPayloadError(`${field} não pode ser null. Omita o campo se não houver valor.`);
  }

  if (value === undefined) {
    throw new InvalidPayloadError(`${field} é obrigatório.`);
  }

  if (typeof value !== "string") {
    throw new InvalidPayloadError(`${field} precisa ser texto, recebido ${typeof value}.`);
  }

  if (value.trim() === "") {
    throw new InvalidPayloadError(`${field} não pode ser vazio.`);
  }

  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new InvalidPayloadError(
      `${field} excede ${String(MAX_IDENTIFIER_LENGTH)} caracteres.`,
    );
  }

  return value;
}

/**
 * Lê um campo de texto opcional.
 *
 * Ausente devolve `undefined`, que é o que a lista de D-005 **omite** do hash —
 * uma operação sem referência não hasheia como uma com referência vazia. Mas
 * `null` continua sendo erro, e não sinônimo de ausente: aceitar os dois faria a
 * mesma operação ter dois hashes possíveis, e o segundo reenvio viraria
 * `IDEMPOTENCY_CONFLICT` falso.
 *
 * @throws InvalidPayloadError se for `null` ou não for texto válido.
 */
export function optionalString(
  source: Record<string, unknown>,
  field: string,
): string | undefined {
  if (source[field] === undefined) {
    return undefined;
  }

  return requiredString(source, field);
}

/**
 * Lê um valor monetário como DTO — **sem** construir `Money`.
 *
 * A forma canônica de D-015/D-016 é decidida por `Money.from`, dentro do use
 * case. Aqui só se verifica que os dois campos vieram como texto: é o ponto em
 * que `{"amount": 25.5}` morre, antes de qualquer coisa converter o número.
 *
 * @throws InvalidPayloadError se o objeto ou os campos estiverem malformados.
 */
export function requiredMoney(source: Record<string, unknown>, field: string): MoneyProps {
  const money = asObject(source[field], field);

  return {
    amount: requiredString(money, "amount", `${field}.amount`),
    currency: requiredString(money, "currency", `${field}.currency`),
  };
}

/**
 * Lê um valor de header obrigatório.
 *
 * `Idempotency-Key` ausente é payload inválido por RF-13, e não uma variante do
 * caminho feliz: sem ela não existe fonte da verdade para a idempotência (RF-14),
 * e processar assim mesmo seria decidir por conta própria que aquela submissão
 * pode ser duplicada.
 *
 * Header repetido chega como array no Node; recusado, porque duas keys diferentes
 * na mesma requisição não têm desempate correto.
 *
 * @throws InvalidPayloadError se ausente, vazio ou repetido.
 */
export function requiredHeader(
  headers: Record<string, unknown>,
  name: string,
): string {
  const value = headers[name];

  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidPayloadError(`header ${name} é obrigatório.`);
  }

  return value;
}

/**
 * Valida um id interno vindo da rota (D-056, D-014).
 *
 * Existe porque `walletId` e `transactionId` viram comparação com coluna `uuid`:
 * uma rota como `/wallets/nao-e-uuid` produziria `22P02` no PostgreSQL, que não
 * está na lista de D-037 e portanto viraria `500` — um erro de servidor para o
 * que é payload malformado. Aqui isso é `400`, a situação (a) de RF-15.
 *
 * `400` e não `404`: a diferença é entre "não existe" e "isso nem é um id".
 *
 * @param what nome do parâmetro na mensagem, como o cliente o vê na rota.
 * @throws InvalidPayloadError se o valor não tiver forma de UUID.
 */
export function uuidParam(value: string, what: string): string {
  if (!isUuid(value)) {
    throw new InvalidPayloadError(`${what} precisa ser um UUID.`);
  }

  return value;
}
