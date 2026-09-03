import { Controller, Get, Res } from "@nestjs/common";
import type { HttpResponse } from "./http-response.ts";
import { ReadinessProbes } from "./readiness-probes.ts";

/** Resposta de `GET /health/live`. */
interface LivenessView {
  status: "live";
}

/** Resposta de `GET /health/ready`, com o resultado sonda a sonda. */
interface ReadinessView {
  status: "ready" | "not-ready";
  /** Uma chave por dependência: `postgres`, `sqs`. */
  checks: Record<string, boolean>;
}

/**
 * Health checks de RF-17: `live` e `ready` **separados**, e sem autenticação.
 *
 * A separação não é cosmética — os dois respondem a perguntas diferentes de quem
 * orquestra o processo:
 *
 *  - **`live`** é "o processo está de pé?". Não toca dependência nenhuma, de
 *    propósito: um orquestrador que reinicie o container porque o PostgreSQL caiu
 *    troca uma indisponibilidade por uma indisponibilidade **mais** longa, e
 *    ainda derruba as conexões que sobreviveriam à intermitência.
 *  - **`ready`** é "posso mandar tráfego?". Aí sim consulta PostgreSQL e SQS,
 *    porque sem eles toda requisição de escrita falharia.
 *
 * Sem autenticação por requisito, e coerente por construção: o `AuthGuard` de
 * D-012 é no-op e libera tudo. Quando houver autenticação de verdade, estas duas
 * rotas e `/metrics` são as que precisam continuar abertas.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly probes: ReadinessProbes) {}

  /**
   * Liveness: responde enquanto o processo consegue responder.
   *
   * Sem `async` e sem I/O. É a única rota do sistema que não depende de nada.
   */
  @Get("live")
  live(): LivenessView {
    return { status: "live" };
  }

  /**
   * Readiness: PostgreSQL **e** SQS alcançáveis (RF-17).
   *
   * As sondas rodam **em paralelo** — são independentes, e serializá-las faria o
   * pior caso ser a soma dos timeouts em vez do maior deles.
   *
   * `503` quando qualquer uma falha, com o corpo dizendo **qual**: um readiness
   * que responde só "não" obriga quem está de plantão a descobrir o motivo em
   * outro lugar. O status vem de `response.status(...)` com `@Res({ passthrough:
   * true })`, o mesmo mecanismo verificado em E-08 que sustenta D-036.
   */
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: HttpResponse): Promise<ReadinessView> {
    const results = await Promise.all(
      this.probes.all().map(async (probe) => [probe.name, await probe.check()] as const),
    );

    const ready = results.every(([, healthy]) => healthy);

    response.status(ready ? 200 : 503);

    return { status: ready ? "ready" : "not-ready", checks: Object.fromEntries(results) };
  }
}
