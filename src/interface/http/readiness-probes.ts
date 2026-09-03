import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { SqsReadinessProbe } from "../../infrastructure/messaging/sqs-readiness-probe.ts";
import { PostgresReadinessProbe } from "../../infrastructure/persistence/postgres-readiness-probe.ts";
import type { ReadinessProbe } from "../../infrastructure/observability/readiness.ts";

/**
 * As duas dependências externas que `GET /health/ready` verifica (RF-17).
 *
 * É uma classe, e não um array montado por factory, por causa do **encerramento**:
 * a sonda do SQS carrega um cliente com pool de conexões, e o
 * `onApplicationShutdown` do NestJS é o gancho que o fecha quando a aplicação
 * termina. Um array puro não tem ciclo de vida, e o socket sobreviveria ao
 * `close()` da aplicação — que é o tipo de vazamento que só aparece como teste
 * que não encerra.
 *
 * A lista é montada aqui e o controller apenas itera: acrescentar uma terceira
 * dependência externa no futuro é acrescentar um item a este array, sem tocar na
 * rota. E é aqui que a borda HTTP consegue ter uma sonda de SQS sem importar
 * `@aws-sdk/*`, o que a regra de lint de EL-06 veta nesta camada.
 */
@Injectable()
export class ReadinessProbes implements OnApplicationShutdown {
  private readonly sqs = SqsReadinessProbe.fromEnv();
  private readonly probes: readonly ReadinessProbe[];

  constructor(@Inject(EntityManager) em: EntityManager) {
    this.probes = [new PostgresReadinessProbe(em), this.sqs];
  }

  /** As sondas, na ordem em que aparecem no corpo da resposta. */
  all(): readonly ReadinessProbe[] {
    return this.probes;
  }

  /** Fecha o cliente do SQS no encerramento da aplicação (RF-22, por analogia). */
  onApplicationShutdown(): void {
    this.sqs.close();
  }
}
