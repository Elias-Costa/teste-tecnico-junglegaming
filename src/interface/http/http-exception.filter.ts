import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from "@nestjs/common";
import type { Logger } from "../../application/ports/logger.ts";
import { LOGGER } from "../../infrastructure/di-tokens.ts";
import { CORRELATION_HEADER } from "./correlation.ts";
import { httpProblemFor } from "./http-status-map.ts";
import type { HttpResponse } from "./http-response.ts";

/** Menor status considerado falha do servidor — o limiar do que vira log de erro. */
const SERVER_ERROR_THRESHOLD = 500;

/**
 * A superfície da requisição que este filtro usa.
 *
 * Declarada estruturalmente pela mesma razão de `HttpResponse`: `@types/express`
 * não está instalado, e importar tipo de dependência transitiva amarraria a
 * compilação a um pacote que ninguém declarou.
 */
interface HttpRequest {
  headers: Record<string, unknown>;
}

/**
 * O **filtro de exceção único** exigido por D-006, aplicado a todos os endpoints.
 *
 * `@Catch()` sem argumento é deliberado: qualquer exceção que escape de qualquer
 * controller passa por aqui. A alternativa — capturar só os tipos conhecidos —
 * deixaria o resto cair no handler padrão do Nest, que responde `500` com um
 * corpo de forma diferente. Duas formas de erro na mesma API é exatamente a
 * inconsistência que a §9 cobra.
 *
 * O filtro não decide nada: quem decide é `httpProblemFor`, e o motivo de ele
 * viver em `http-status-map.ts`, junto do mapa do caminho normal, é que as duas
 * metades da resposta de RF-15 precisam ser lidas lado a lado para se conferir
 * que as cinco situações continuam com cinco códigos distintos.
 *
 * Desde E-15 ele também **loga** (RNF-06). O ponto é único de propósito: toda
 * falha de requisição passa por aqui, então uma linha aqui cobre a API inteira
 * sem espalhar `try/catch` por controller nenhum.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<HttpResponse>();
    const problem = httpProblemFor(exception);

    // **Só `5xx` vira log de erro.** Um `400` ou um `422` é o sistema
    // funcionando: o provedor mandou payload inválido ou a regra de negócio
    // recusou, e os dois já são visíveis na resposta e no banco. Logar tudo como
    // erro faria o alerta de erro disparar com tráfego normal, que é a forma mais
    // comum de um log estruturado deixar de ser lido.
    if (problem.status >= SERVER_ERROR_THRESHOLD) {
      this.logger.error("http.request.failed", exception, {
        correlationId: correlationOf(http.getRequest<HttpRequest>()),
        failureCode: problem.failureCode,
      });
    }

    response.status(problem.status).json({
      message: problem.message,
      // Chave omitida quando não há código, em vez de `failureCode: null`: o
      // provedor testa presença, e `null` o obrigaria a distinguir dois "sem
      // código". Todo `422` tem um; `503` nunca tem, por D-006.
      ...(problem.failureCode === undefined ? {} : { failureCode: problem.failureCode }),
    });
  }
}

/**
 * Lê a correlação da requisição que falhou (D-039).
 *
 * Lê o header cru em vez de chamar `resolveCorrelationId`: aqui não há id a
 * gerar. Se o provedor não mandou correlação, o registro sai sem ela — inventar
 * um id neste ponto produziria um valor que não aparece em lugar nenhum, nem na
 * resposta nem no banco, e que só atrapalharia quem tentasse segui-lo.
 */
function correlationOf(request: HttpRequest): string | undefined {
  const header = request.headers[CORRELATION_HEADER];

  return typeof header === "string" ? header : undefined;
}
