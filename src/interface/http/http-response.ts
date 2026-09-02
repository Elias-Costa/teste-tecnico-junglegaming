/**
 * A superfície do objeto de resposta que esta borda realmente usa.
 *
 * Declarada estruturalmente, e não importada do Express, por um motivo concreto:
 * `@types/express` **não** está instalado — o `express` chega como dependência
 * transitiva de `@nestjs/platform-express`. Importar tipo de um pacote transitivo
 * amarraria a compilação a uma dependência que ninguém declarou.
 *
 * Três métodos bastam, e a lista curta é a garantia: se um controller precisar de
 * um quarto, a adição fica visível no diff em vez de passar junto com o resto da
 * API do framework.
 */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}
