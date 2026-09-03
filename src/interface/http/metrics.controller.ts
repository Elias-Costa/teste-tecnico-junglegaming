import { Controller, Get, Res } from "@nestjs/common";
import { metricsRegistry } from "../../infrastructure/observability/metrics.ts";
import type { HttpResponse } from "./http-response.ts";

/**
 * `GET /metrics` no formato Prometheus (RNF-07, D-010).
 *
 * O controller não conhece nenhuma métrica: ele serializa o registro de D-062 e
 * devolve o texto. Quem incrementa são as bordas e os workers, e é essa
 * separação que permite o mesmo endpoint expor tanto o que aconteceu no HTTP
 * quanto o que aconteceu nos três laços do processo (D-063).
 *
 * Fica aberto, como os endpoints de health — decisão registrada em D-010 e
 * coerente com D-012, que não implementa autenticação.
 */
@Controller("metrics")
export class MetricsController {
  /**
   * Serializa o registro no formato de exposição do Prometheus.
   *
   * O `Content-Type` sai do próprio registro em vez de ser escrito à mão: a
   * versão do formato de exposição faz parte do contrato com o scraper, e
   * duplicá-la aqui criaria uma segunda fonte da verdade que envelhece sozinha.
   *
   * `metrics()` é assíncrono porque é ele que dispara os collect callbacks —
   * `outbox_lag_seconds` consulta o banco exatamente aqui, uma vez por scrape.
   */
  @Get()
  async scrape(@Res({ passthrough: true }) response: HttpResponse): Promise<string> {
    response.setHeader("content-type", metricsRegistry.contentType);

    return metricsRegistry.metrics();
  }
}
