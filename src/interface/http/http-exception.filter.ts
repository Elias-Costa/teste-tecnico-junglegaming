import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import { httpProblemFor } from "./http-status-map.ts";
import type { HttpResponse } from "./http-response.ts";

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
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const problem = httpProblemFor(exception);

    response.status(problem.status).json({
      message: problem.message,
      // Chave omitida quando não há código, em vez de `failureCode: null`: o
      // provedor testa presença, e `null` o obrigaria a distinguir dois "sem
      // código". Todo `422` tem um; `503` nunca tem, por D-006.
      ...(problem.failureCode === undefined ? {} : { failureCode: problem.failureCode }),
    });
  }
}
