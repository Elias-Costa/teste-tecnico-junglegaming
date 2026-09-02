import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  MessageSystemAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { RetryPolicy } from "../../domain/retry-policy.ts";
import {
  consumerBackoffSeconds,
  consumerRetryPolicy,
  readRetryEnv,
  type RetryEnv,
} from "../config/retry-env.ts";
import { readSqsEnv, type SqsEnv } from "../config/sqs-env.ts";
import type { MessageDisposition, MessageHandler } from "./message-handler.ts";
import { ensureQueue, resolveQueueUrl } from "./sqs-queue-provisioner.ts";

/** Parâmetros operacionais do consumidor, preenchidos a partir de `readRetryEnv()`. */
export interface SqsWagerConsumerOptions {
  queueUrl: string;
  /** Destino do envio explícito de D-046. Sempre resolvido, mesmo sem uso. */
  deadLetterQueueUrl: string;
  batchSize: number;
  visibilityTimeoutSec: number;
  waitTimeSec: number;
  /**
   * Destino dos erros que o laço absorve — falha de rede com o SQS, tipicamente.
   *
   * Mesmo papel que em `OutboxPublisher`: um consumidor precisa sobreviver a um
   * SQS momentaneamente fora (RNF-05), e sobreviver calado é a diferença entre
   * resiliência e cegueira. E-15 troca este gancho pelo log estruturado de RNF-06.
   */
  onCycleError?: ((error: unknown) => void) | undefined;
}

/** O que uma rodada fez — a forma como os testes observam o consumidor. */
export interface ConsumeCycleResult {
  received: number;
  acked: number;
  retried: number;
  deadLettered: number;
  /** Mensagens devolvidas por encerramento em curso, sem terem sido tocadas (RF-22). */
  released: number;
}

/**
 * Consumidor da fila de entrada `wager-transactions.fifo` (RF-18..RF-22, §10).
 *
 * O ciclo tem três passos, e a ordem é a garantia de RF-20:
 *
 *  1. **receber** um lote;
 *  2. **processar** cada mensagem pelo handler, que abre e commita a transação;
 *  3. **agir sobre o desfecho** — `DeleteMessage`, devolução com backoff ou envio
 *     à DLQ.
 *
 * O `ack` está no passo (3), depois de o handler ter retornado — ou seja, depois
 * do commit. Não há caminho neste arquivo que apague uma mensagem antes disso, e
 * é essa ausência que RF-20 cobra. Um crash entre o commit e o `DeleteMessage`
 * devolve a mensagem, e a inbox de RF-19 absorve a reentrega: at-least-once com a
 * deduplicação no banco, exatamente como RI-03 exige.
 *
 * **Este arquivo não conhece regra de negócio.** Ele não sabe o que é aposta,
 * saldo ou `failureCode`; só executa `ack` / `retry` / `dead-letter`. Quem
 * classifica é `WagerMessageHandler`, do outro lado da porta `MessageHandler` —
 * a mesma separação que D-009 fez entre `OutboxPublisher` e `SqsEventPublisher`.
 *
 * As mensagens do lote são processadas **em sequência**, e não em paralelo: a
 * fila é FIFO e a ordem por `MessageGroupId` só significa alguma coisa se o
 * consumidor a respeitar. Paralelizar aqui embaralharia operações do mesmo
 * agregado depois de o SQS ter tido o trabalho de ordená-las.
 */
export class SqsWagerConsumer {
  private running = false;
  /**
   * Encerramento **pedido** — bandeira própria, e não a ausência de laço.
   *
   * A distinção é necessária porque `runOnce()` é chamado direto pelos testes,
   * sem `start()`: sem esta bandeira, "o laço não está rodando" e "alguém pediu
   * para parar" seriam a mesma condição, e todo ciclo avulso devolveria o lote
   * inteiro à fila em vez de processá-lo.
   */
  private draining = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly handler: MessageHandler,
    private readonly policy: RetryPolicy,
    private readonly options: SqsWagerConsumerOptions,
  ) {}

  /**
   * Constrói o consumidor a partir do ambiente, provisionando as duas filas.
   *
   * O provisionamento passa pelo **mesmo** `ensureQueue` do worker da outbox
   * (D-041), agora com a redrive policy de D-008 — nome, tipo e limite de
   * entregas continuam com uma fonte de verdade só.
   */
  static async fromEnv(
    handler: MessageHandler,
    env: SqsEnv = readSqsEnv(),
    retry: RetryEnv = readRetryEnv(),
  ): Promise<SqsWagerConsumer> {
    const client = new SQSClient({
      region: env.region,
      endpoint: env.endpoint,
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
    });

    const queueUrl = await ensureQueue(client, env.transactionsQueueName, {
      deadLetter: {
        queueName: env.transactionsDlqName,
        maxReceiveCount: retry.consumerMaxReceiveCount,
      },
    });

    return new SqsWagerConsumer(client, handler, consumerRetryPolicy(retry), {
      queueUrl,
      deadLetterQueueUrl: await resolveQueueUrl(client, env.transactionsDlqName),
      batchSize: retry.consumerBatchSize,
      visibilityTimeoutSec: retry.consumerVisibilityTimeoutSec,
      waitTimeSec: retry.consumerWaitTimeSec,
    });
  }

  /**
   * Executa **um** ciclo e devolve o que aconteceu.
   *
   * É o método que os testes dirigem, no mesmo formato de `OutboxPublisher`: um
   * ciclo determinístico prova recebimento, processamento e desfecho sem depender
   * de temporizador, e o laço de `start()` não é nada além de chamá-lo em
   * sequência.
   *
   * A checagem de encerramento acontece **entre** mensagens do lote (RF-22): a
   * que já começou vai até o fim, e as que ainda não foram tocadas voltam à fila
   * imediatamente, em vez de ficarem invisíveis até o visibility timeout vencer.
   */
  async runOnce(): Promise<ConsumeCycleResult> {
    const received = await this.receive();
    const result: ConsumeCycleResult = {
      received: received.length,
      acked: 0,
      retried: 0,
      deadLettered: 0,
      released: 0,
    };

    for (const message of received) {
      if (this.stopping()) {
        // Encerramento chegou no meio do lote. Devolver a visibilidade é o que
        // impede a mensagem de ficar presa pelo resto do visibility timeout —
        // "nenhuma mensagem pode ficar presa nem ser perdida" (RF-22).
        await this.releaseVisibility(message);
        result.released += 1;
        continue;
      }

      const disposition = await this.handler.handle({
        body: message.Body ?? "",
        transportMessageId: message.MessageId ?? "",
      });

      await this.apply(message, disposition);
      countInto(result, disposition);
    }

    return result;
  }

  /**
   * Inicia o laço. Idempotente: chamar duas vezes não cria dois laços.
   *
   * Não devolve promessa de propósito — quem inicia o consumidor não quer esperar
   * por ele. O encerramento ordenado é `stop()`.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.draining = false;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * Encerra o laço e **aguarda o ciclo em andamento** (RF-22).
   *
   * Esperar é o requisito, não uma cortesia: interromper no meio deixaria a
   * transação em curso sem desfecho registrado e a mensagem invisível na fila. O
   * que estiver processando termina; o resto do lote volta à fila.
   *
   * Um `ReceiveMessage` em long polling ainda em voo é aguardado até o fim. Ele
   * não segura mensagem nenhuma, então nada fica preso — só o encerramento custa,
   * no pior caso, o `waitTimeSec` configurado.
   */
  async stop(): Promise<void> {
    this.draining = true;
    this.running = false;

    await this.loop;
    this.loop = undefined;
  }

  /**
   * O laço em si.
   *
   * Sem espera artificial entre ciclos: o long polling do `ReceiveMessage` já é a
   * espera, e é a barata — dormir depois dele acrescentaria latência a uma fila
   * cheia. Um erro de ciclo não derruba o laço, que é o que RNF-05 pede diante de
   * infraestrutura momentaneamente fora.
   */
  private async run(): Promise<void> {
    while (this.isRunning()) {
      try {
        await this.runOnce();
      } catch (error) {
        this.options.onCycleError?.(error);
      }
    }
  }

  /**
   * Leitura da bandeira por método, e não pelo campo direto.
   *
   * O campo só muda em `stop()`, que roda fora deste laço; lido direto, o
   * compilador estreita o tipo depois do `while` e a regra
   * `no-unnecessary-condition` acusa a segunda checagem. A chamada preserva a
   * leitura em tempo de execução, que é a que importa.
   */
  private isRunning(): boolean {
    return this.running;
  }

  /**
   * Verdadeiro quando `stop()` já foi chamado — usado dentro do laço do lote.
   *
   * Leitura por método pelo mesmo motivo de `isRunning`: o campo muda fora deste
   * laço, e lido direto o compilador o estreita depois do primeiro `await`.
   */
  private stopping(): boolean {
    return this.draining;
  }

  /**
   * Recebe um lote da fila.
   *
   * `MessageSystemAttributeNames` é pedido explicitamente porque sem ele
   * `Message.Attributes` volta **vazio** (verificado em E-10): o
   * `ApproximateReceiveCount` alimenta o backoff de D-022 e o `MessageGroupId` é
   * obrigatório ao reenviar para a DLQ, que também é FIFO.
   */
  private async receive(): Promise<Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.options.batchSize,
        WaitTimeSeconds: this.options.waitTimeSec,
        VisibilityTimeout: this.options.visibilityTimeoutSec,
        MessageSystemAttributeNames: [
          MessageSystemAttributeName.ApproximateReceiveCount,
          MessageSystemAttributeName.MessageGroupId,
        ],
      }),
    );

    return response.Messages ?? [];
  }

  /** Executa o desfecho decidido pelo handler. */
  private async apply(message: Message, disposition: MessageDisposition): Promise<void> {
    if (disposition === "ack") {
      await this.deleteMessage(message);

      return;
    }

    if (disposition === "retry") {
      await this.scheduleRedelivery(message);

      return;
    }

    await this.deadLetter(message);
  }

  /**
   * Devolve a mensagem com o backoff de D-022, em vez de esperar o timeout fixo.
   *
   * O visibility timeout da fila é um número só; a curva com jitter é o que D-008
   * exige, e é o que impede várias instâncias de sincronizarem tentativas depois
   * de uma indisponibilidade (RI-08).
   */
  private async scheduleRedelivery(message: Message): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: consumerBackoffSeconds(
          message.Attributes?.[MessageSystemAttributeName.ApproximateReceiveCount],
          this.policy,
        ),
      }),
    );
  }

  /** Devolve a mensagem **agora**, sem backoff — o caso de encerramento (RF-22). */
  private async releaseVisibility(message: Message): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  /**
   * Envio explícito à DLQ, na primeira entrega (D-046).
   *
   * **Enviar antes de apagar**, e não o contrário: uma duplicata na DLQ é
   * recuperável por quem a inspeciona, uma mensagem perdida não é. Se o envio
   * falhar, a exceção sobe, a origem não é apagada e a mensagem volta pelo
   * visibility timeout — que é o desfecho certo.
   *
   * A DLQ é FIFO, então os dois campos são obrigatórios. O grupo é o **original**,
   * para que a DLQ preserve o agrupamento por agregado; o dedup id é o `MessageId`
   * de transporte, e não o `messageId` do corpo de D-044, porque o caso mais comum
   * de erro permanente é justamente o payload que não abre — ali o corpo não tem
   * id nenhum para oferecer.
   */
  private async deadLetter(message: Message): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.deadLetterQueueUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId:
          message.Attributes?.[MessageSystemAttributeName.MessageGroupId] ?? message.MessageId,
        MessageDeduplicationId: message.MessageId,
      }),
    );

    await this.deleteMessage(message);
  }

  /** O `ack` de RF-20. Só é chamado depois de o handler ter retornado. */
  private async deleteMessage(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  /** Libera o socket do cliente. Chamado no encerramento do processo. */
  close(): void {
    this.client.destroy();
  }
}

/** Contabiliza o desfecho no resultado do ciclo. */
function countInto(result: ConsumeCycleResult, disposition: MessageDisposition): void {
  if (disposition === "ack") {
    result.acked += 1;

    return;
  }

  if (disposition === "retry") {
    result.retried += 1;

    return;
  }

  result.deadLettered += 1;
}
