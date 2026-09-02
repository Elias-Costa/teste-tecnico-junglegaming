import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { OutboxMessage } from "../../domain/outbox-message.ts";
import { readSqsEnv, type SqsEnv } from "../config/sqs-env.ts";
import type { EventPublisher } from "./event-publisher.ts";
import { ensureQueue } from "./sqs-queue-provisioner.ts";

/**
 * Publica eventos de integração na fila FIFO de saída (RF-24, RF-25, D-040).
 *
 * É o **único** ponto do sistema que fala com o SQS na direção de saída. A regra
 * de lint que veta `@aws-sdk/*` em `src/application/**` e `src/interface/**`
 * existe para que continue assim: publicar de dentro do use case colocaria o
 * evento no barramento antes do commit da transação financeira, que é EL-06.
 *
 * **A URL da fila é resolvida uma vez e memoizada.** Resolver a cada publicação
 * acrescentaria uma ida à rede no caminho quente do worker; resolver na
 * construção obrigaria o construtor a ser assíncrono e espalharia `await` por
 * quem só quer montar o grafo de dependências.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  /**
   * Constrói cliente e publisher a partir do ambiente (D-011).
   *
   * O endereço vem do módulo único de configuração, então nem este publisher nem
   * quem o usa sabe se quem provisionou o SQS foi o Docker Compose ou o
   * Testcontainers.
   */
  static fromEnv(env: SqsEnv = readSqsEnv()): SqsEventPublisher {
    const client = new SQSClient({
      region: env.region,
      endpoint: env.endpoint,
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
    });

    return new SqsEventPublisher(client, env.eventsQueueName);
  }

  /**
   * Envia o envelope já serializado da outbox (RF-07, D-040).
   *
   * O corpo é o `payload` da linha, gravado como `event.toJSON()` lá em E-04 — a
   * classe do evento **não** é reidratada aqui de propósito: republicar um evento
   * de seis meses atrás reconstruindo a classe vigente acoplaria a fila ao código
   * de hoje.
   *
   * `MessageGroupId = aggregateId` dá ordem FIFO **por agregado**, sem serializar
   * wallets que nada têm a ver umas com as outras (RI-06, RNF-01). Um grupo por
   * tipo de evento daria ordem global e um consumidor lento travaria eventos de
   * agregados sem relação nenhuma.
   *
   * `MessageDeduplicationId = id da linha da outbox`, e não o `eventId` de dentro
   * do payload: é estável entre as republicações que o at-least-once de D-009
   * assume, e lê-lo não exige abrir o `jsonb`. Com ele, a republicação após crash
   * cai na janela de dedup do próprio SQS — reforço ao item 5 de RF-24, nunca a
   * garantia dele, que continua sendo do consumidor por RI-03.
   */
  async publish(message: OutboxMessage): Promise<void> {
    const queueUrl = await this.resolveQueueUrl();

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }

  /** Libera o socket do cliente. Chamado no encerramento do processo. */
  close(): void {
    this.client.destroy();
  }

  /**
   * Resolve a URL na primeira publicação e guarda a **promessa**, não o valor.
   *
   * Guardar a promessa é o que torna a resolução única sob concorrência: duas
   * publicações simultâneas na primeira vez compartilham a mesma ida à rede em
   * vez de dispararem duas.
   *
   * A memoização é **descartada quando a resolução falha**. Sem isso, um SQS
   * momentaneamente fora no primeiro ciclo do worker deixaria uma promessa
   * rejeitada em cache e o publisher nunca mais publicaria nada — a falha
   * transitória viraria permanente, que é o oposto do que RNF-05 pede.
   */
  private async resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= ensureQueue(this.client, this.queueName).catch((error: unknown) => {
      this.queueUrl = undefined;

      throw error;
    });

    return this.queueUrl;
  }
}
