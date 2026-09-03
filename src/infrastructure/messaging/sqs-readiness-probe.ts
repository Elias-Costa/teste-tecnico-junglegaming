import { ListQueuesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { readSqsEnv, type SqsEnv } from "../config/sqs-env.ts";
import type { ReadinessProbe } from "../observability/readiness.ts";

/**
 * Readiness do SQS (RF-17): uma chamada de API real contra o endpoint
 * configurado.
 *
 * **`ListQueues` e não `GetQueueUrl`**, e a escolha é a leitura literal do
 * requisito: RF-17 pede que o SQS esteja **alcançável**. `GetQueueUrl` provaria
 * alcance *e* existência da fila, o que parece mais forte e é pior — o
 * provisionamento das filas acontece no bootstrap dos workers (D-041), e um
 * processo só-HTTP passaria a se declarar indisponível por não ter criado uma
 * fila que não é dele. É também a mesma verificação que
 * `tests/integration/infrastructure-reachability.test.ts` já usa desde E-01.
 */
export class SqsReadinessProbe implements ReadinessProbe {
  readonly name = "sqs";

  constructor(private readonly client: SQSClient) {}

  /** Constrói cliente e sonda a partir do ambiente (D-011). */
  static fromEnv(env: SqsEnv = readSqsEnv()): SqsReadinessProbe {
    return new SqsReadinessProbe(
      new SQSClient({
        region: env.region,
        endpoint: env.endpoint,
        credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
      }),
    );
  }

  async check(): Promise<boolean> {
    try {
      const result = await this.client.send(new ListQueuesCommand({}));

      return result.$metadata.httpStatusCode === 200;
    } catch {
      // Mesma razão da sonda do PostgreSQL: indisponibilidade é resposta, não erro.
      return false;
    }
  }

  /** Libera o socket do cliente. Chamado no encerramento do processo. */
  close(): void {
    this.client.destroy();
  }
}
