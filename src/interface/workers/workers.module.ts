import { EntityManager } from "@mikro-orm/postgresql";
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { InboxLookup } from "../../application/inbox-lookup.ts";
import type { Clock } from "../../application/ports/clock.ts";
import type { Logger } from "../../application/ports/logger.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction.ts";
import {
  outboxRetryPolicy,
  pendingReferenceRetryPolicy,
  readRetryEnv,
} from "../../infrastructure/config/retry-env.ts";
import { CLOCK, LOGGER, UNIT_OF_WORK } from "../../infrastructure/di-tokens.ts";
import { OutboxClaimStore } from "../../infrastructure/messaging/outbox-claim-store.ts";
import {
  defaultInstanceId,
  OutboxPublisher,
} from "../../infrastructure/messaging/outbox-publisher.ts";
import { PendingReferenceStore } from "../../infrastructure/messaging/pending-reference-store.ts";
import { PendingReferenceWorker } from "../../infrastructure/messaging/pending-reference-worker.ts";
import { SqsEventPublisher } from "../../infrastructure/messaging/sqs-event-publisher.ts";
import { SqsWagerConsumer } from "../../infrastructure/messaging/sqs-wager-consumer.ts";
import { AppModule } from "../http/app.module.ts";
import { WagerMessageHandler } from "../messaging/wager-message-handler.ts";

/**
 * Sobe e encerra os três laços do processo (D-063, RF-22, RF-24, RF-26).
 *
 * Até E-14 os três workers existiam como classes que só os testes instanciavam:
 * um avaliador que subisse a aplicação não publicava evento, não consumia
 * mensagem e não resolvia pendente nenhuma. Esta classe é o que fecha esse
 * buraco — e, de quebra, é o que faz `wager_retries_total` e
 * `wager_dlq_messages_total` terem um `/metrics` onde aparecer, já que contador
 * do `prom-client` é por processo (D-010).
 *
 * **`onApplicationBootstrap`, e não o construtor:** `SqsWagerConsumer.fromEnv()`
 * provisiona as filas (D-041), o que é I/O de rede — e I/O em construtor de
 * provider deixa o container do NestJS esperando por rede antes de qualquer rota
 * existir.
 *
 * **`onApplicationShutdown` é RF-22 de verdade.** Os três `stop()` já existiam e
 * já eram exercitados; o que faltava era alguém chamá-los quando o `SIGTERM`
 * chega. `enableShutdownHooks()` em `main.ts` é o outro lado deste gancho.
 */
@Injectable()
export class WagerWorkers implements OnApplicationBootstrap, OnApplicationShutdown {
  private outbox: OutboxPublisher | undefined;
  private consumer: SqsWagerConsumer | undefined;
  private pendingReferences: PendingReferenceWorker | undefined;
  private events: SqsEventPublisher | undefined;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly processWagerTransaction: ProcessWagerTransaction,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const retry = readRetryEnv();
    const events = SqsEventPublisher.fromEnv();

    this.events = events;

    // Publicação da outbox (RF-24, D-009).
    this.outbox = new OutboxPublisher(
      new OutboxClaimStore(this.em),
      events,
      this.clock,
      outboxRetryPolicy(retry),
      {
        instanceId: defaultInstanceId(),
        batchSize: retry.outboxBatchSize,
        leaseMs: retry.outboxLeaseMs,
        pollIntervalMs: retry.outboxPollIntervalMs,
        onCycleError: (error: unknown) => {
          this.logger.error("outbox.cycle.failed", error);
        },
      },
    );

    // Consumo da fila de entrada (RF-18..RF-22). O handler recebe o **mesmo**
    // `ProcessWagerTransaction` que o controller HTTP usa — é literalmente RF-18,
    // e o que o `exports` do `AppModule` existe para garantir.
    this.consumer = await SqsWagerConsumer.fromEnv(
      new WagerMessageHandler(
        this.processWagerTransaction,
        new InboxLookup(this.unitOfWork),
        this.logger,
      ),
      undefined,
      retry,
    );

    // Referências fora de ordem (RF-26, RN-15).
    this.pendingReferences = new PendingReferenceWorker(
      new PendingReferenceStore(this.em),
      this.processWagerTransaction,
      this.clock,
      pendingReferenceRetryPolicy(retry),
      {
        batchSize: retry.pendingReferenceBatchSize,
        ttlMs: retry.pendingReferenceTtlMs,
        pollIntervalMs: retry.pendingReferencePollIntervalMs,
        onCycleError: (error: unknown) => {
          this.logger.error("pending_reference.cycle.failed", error);
        },
      },
    );

    // `outbox_lag_seconds` **não** é ligado aqui, e isso é deliberado: quem o
    // liga é `OutboxLagMetric`, no `AppModule`. O lag é estado do banco, não do
    // worker, e ligá-lo junto dos laços faria um processo só-HTTP expor `0` —
    // que se lê como "outbox em dia" quando significa "ninguém mediu".
    this.outbox.start();
    this.consumer.start();
    this.pendingReferences.start();

    this.logger.info("workers.started");
  }

  /**
   * Encerra os três laços e o publisher (RF-22).
   *
   * Os três `stop()` correm **em paralelo**: são independentes, e encerrar em
   * série faria o pior caso ser a soma das esperas — inclusive o `waitTimeSec` do
   * long polling do consumidor.
   *
   * O cliente do SQS de saída só é fechado **depois** de os laços pararem: fechar
   * antes cortaria o socket de uma publicação em andamento, que é exatamente a
   * mensagem que RF-24 não pode perder.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.outbox?.stop(),
      this.consumer?.stop(),
      this.pendingReferences?.stop(),
    ]);

    this.events?.close();

    this.logger.info("workers.stopped");
  }
}

/**
 * Módulo raiz do processo de produção (D-063).
 *
 * Importa o `AppModule` — que traz os endpoints, o filtro, o guard e o grafo de
 * use cases — e acrescenta os workers. O sentido da seta importa: é o
 * `WorkersModule` que depende do `AppModule`, nunca o contrário, e é isso que
 * mantém o `AppModule` montável sozinho pelos testes de RT-17.
 */
@Module({
  imports: [AppModule],
  providers: [WagerWorkers],
})
export class WorkersModule {}
