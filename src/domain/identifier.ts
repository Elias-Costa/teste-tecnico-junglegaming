/**
 * Forma dos identificadores internos deste sistema (D-014).
 *
 * Todo id de entidade é um UUIDv7 gerado fora do domínio. Esta função responde
 * apenas se um texto **tem forma de UUID** — e existe para ser a única fonte
 * dessa resposta: a borda HTTP a usa para recusar um id malformado na rota, e o
 * codec do cursor de RF-10 a usa para recusar um cursor corrompido. Duas cópias
 * da mesma regex divergiriam no dia em que uma delas fosse ajustada.
 *
 * **Não exige a versão 7 de propósito.** Todo id gerado aqui é v7, mas esta
 * checagem é aplicada a valores que serão comparados com linhas já gravadas, e
 * recusar um id histórico legítimo transformaria consulta em erro — o mesmo
 * motivo pelo qual `rehydrate` não revalida (§6.0). O que ela precisa impedir é
 * texto arbitrário chegando a uma coluna `uuid`, onde viraria um `22P02` que
 * D-037 não mapeia, ou seja, um `500` para o que é payload inválido.
 */
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verdadeiro se o texto tem forma de UUID (D-014). */
export function isUuid(value: string): boolean {
  return UUID_FORMAT.test(value);
}
