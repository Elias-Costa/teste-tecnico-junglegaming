import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { OutboxLagStore } from "../../infrastructure/messaging/outbox-lag-store.ts";
import { bindOutboxLagSource } from "../../infrastructure/observability/metrics.ts";

/**
 * Liga `outbox_lag_seconds` ao banco (D-010).
 *
 * **Vive no `AppModule`, e não junto dos workers, e a razão é uma armadilha
 * concreta:** o gauge é lido em `/metrics`, que é rota do `AppModule`; se a
 * fonte fosse ligada pelo `WorkersModule`, um processo que servisse só HTTP
 * exporia `outbox_lag_seconds 0` — indistinguível de "outbox em dia" quando o
 * significado real seria "ninguém mediu". Métrica que mente para o lado saudável
 * é pior do que métrica ausente.
 *
 * E ligá-la aqui é correto pelo significado: o lag é a idade da linha pendente
 * mais antiga, ou seja, **estado do banco** — não do worker. Qualquer processo
 * com conexão pode respondê-lo, inclusive um que não publique nada.
 *
 * `onApplicationBootstrap`, e não o construtor: a consulta só deve começar a
 * existir depois de o grafo estar montado.
 */
@Injectable()
export class OutboxLagMetric implements OnApplicationBootstrap {
  private readonly store: OutboxLagStore;

  constructor(@Inject(EntityManager) em: EntityManager) {
    this.store = new OutboxLagStore(em);
  }

  onApplicationBootstrap(): void {
    bindOutboxLagSource(() => this.store.oldestPendingLagSeconds());
  }
}
