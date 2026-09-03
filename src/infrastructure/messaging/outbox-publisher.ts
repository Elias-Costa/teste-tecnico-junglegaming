import type { Clock } from "../../application/ports/clock.ts";
import type { RetryPolicy } from "../../domain/retry-policy.ts";
import { recordRetry } from "../observability/metrics.ts";
import type { EventPublisher } from "./event-publisher.ts";
import type { OutboxClaimStore } from "./outbox-claim-store.ts";

/** Parâmetros operacionais do worker, preenchidos a partir de `readRetryEnv()`. */
export interface OutboxPublisherOptions {
  /** Vai para `locked_by`. A coluna é `varchar(120)`. */
  instanceId: string;
  batchSize: number;
  leaseMs: number;
  /** Espera entre ciclos quando o ciclo anterior não achou nada. */
  pollIntervalMs: number;
  /**
   * Destino dos erros que o laço absorve: falha de publicação de uma mensagem e
   * falha que aborta um ciclo inteiro (banco fora do ar, tipicamente).
   *
   * Existe para que a falha **não** seja engolida em silêncio enquanto o log
   * estruturado de RNF-06 não existe (E-15): o worker precisa sobreviver a um SQS
   * ou a um PostgreSQL momentaneamente indisponível, e sobreviver calado é a
   * diferença entre resiliência e cegueira. E-15 troca este gancho pelo logger.
   */
  onCycleError?: ((error: unknown) => void) | undefined;
}

/** O que uma rodada fez — a forma como os testes observam o worker. */
export interface OutboxCycleResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Worker de publicação da outbox (RF-24, RF-25, RI-04, EL-06, D-009).
 *
 * O ciclo tem três passos, nesta ordem e por esta razão:
 *
 *  1. **claim** — transação curta que marca `locked_by`/`locked_until` com
 *     `SKIP LOCKED` e commita **imediatamente**;
 *  2. **publish** — chamada ao SQS **fora** de qualquer transação de banco;
 *  3. **marcação** — `published_at` no sucesso, reagendamento na falha.
 *
 * Inverter 1 e 2 — publicar dentro da transação — seguraria uma conexão durante
 * I/O de rede e exauriria o pool com um SQS lento. É a alternativa que D-009
 * descartou explicitamente.
 *
 * O custo assumido é entrega **at-least-once**: um crash entre (2) e (3) faz o
 * lease vencer e outra instância republicar. O próprio enunciado assume isso
 * ("uma publicação duplicada continua segura para o consumidor"), e o
 * `MessageDeduplicationId` de D-040 ainda absorve a repetição dentro da janela
 * do SQS — reforço, nunca a garantia, que continua sendo do consumidor (RI-03).
 *
 * O worker **não toca dinheiro**: lê a outbox e marca linhas. Nenhuma escrita em
 * wallet, ledger ou transação passa por aqui.
 */
export class OutboxPublisher {
  private running = false;
  private loop: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly store: OutboxClaimStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly policy: RetryPolicy,
    private readonly options: OutboxPublisherOptions,
  ) {}

  /**
   * Executa **um** ciclo e devolve o que aconteceu.
   *
   * É o método que os testes dirigem: um ciclo determinístico prova claim,
   * publicação e marcação sem depender de temporizador — e o laço de `start()`
   * não é nada além de chamá-lo em sequência.
   *
   * A publicação é **sequencial** dentro do lote, de propósito: as mensagens
   * saem na ordem dos ids (UUIDv7, cronológica), que é o que dá sentido à ordem
   * por `MessageGroupId` do lado do consumidor (D-040). Paralelizar aqui
   * embaralharia eventos do mesmo agregado antes mesmo de eles chegarem à fila.
   *
   * Falha de uma mensagem **não** aborta as outras: cada uma tem seu desfecho.
   */
  async runOnce(): Promise<OutboxCycleResult> {
    const now = this.clock.now();

    const claimed = await this.store.claim({
      instanceId: this.options.instanceId,
      now,
      batchSize: this.options.batchSize,
      leaseMs: this.options.leaseMs,
    });

    let published = 0;
    let failed = 0;

    for (const message of claimed) {
      try {
        await this.publisher.publish(message);
        // O instante da publicação é lido agora, e não reaproveitado do início
        // do ciclo: entre o claim e este ponto houve I/O de rede, e `published_at`
        // deve dizer quando a mensagem saiu, não quando o ciclo começou.
        const at = this.clock.now();
        message.markPublished(at);
        await this.store.markPublished(message.id, at);
        published += 1;
      } catch (error) {
        this.options.onCycleError?.(error);
        // A curva é do domínio (D-022); o worker só persiste o resultado dela e
        // solta o lease, para que o agendamento — e não o prazo do lease — decida
        // a próxima tentativa.
        message.scheduleRetry(this.clock.now(), this.policy);
        await this.store.releaseForRetry(message);
        // `wager_retries_total{loop="outbox"}` (D-010, D-062). Contado no ponto
        // do reagendamento, e não no `catch` inteiro: o que a métrica conta é
        // tentativa **remarcada**, que é o que vai custar mais uma publicação.
        recordRetry("outbox");
        failed += 1;
      }
    }

    return { claimed: claimed.length, published, failed };
  }

  /**
   * Inicia o laço. Idempotente: chamar duas vezes não cria dois laços.
   *
   * Não devolve promessa de propósito — quem inicia o worker não quer esperar por
   * ele. O encerramento ordenado é `stop()`.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loop = this.run();
  }

  /**
   * Encerra o laço e **aguarda o ciclo em andamento** terminar.
   *
   * Esperar importa: um ciclo interrompido no meio deixaria linhas reivindicadas
   * com lease em vigor, e a publicação delas ficaria parada até o lease vencer.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.wake?.();

    await this.loop;
    this.loop = undefined;
  }

  /**
   * O laço em si.
   *
   * Só espera quando o ciclo veio vazio: com fila cheia, o worker encadeia lotes
   * sem introduzir latência artificial entre eles. Um erro de ciclo — banco
   * indisponível, tipicamente — não derruba o laço; ele espera o intervalo e
   * tenta de novo, que é o comportamento que RNF-05 cobra da aplicação diante de
   * infraestrutura momentaneamente fora.
   */
  private async run(): Promise<void> {
    while (this.isRunning()) {
      let idle = true;

      try {
        const result = await this.runOnce();
        idle = result.claimed === 0;
      } catch (error) {
        this.options.onCycleError?.(error);
      }

      // A segunda leitura da bandeira não é redundante: `stop()` pode ter
      // chegado **durante** o ciclo, e aí `wake` ainda não existia para ser
      // chamado. Sem ela, encerrar custaria um intervalo inteiro de espera.
      if (idle && this.isRunning()) {
        await this.waitForNextCycle();
      }
    }
  }

  /**
   * Leitura da bandeira por método, e não pelo campo direto.
   *
   * O campo só muda em `stop()`, que roda fora deste laço; lido direto, o
   * compilador estreita o tipo depois do `while` e passa a considerar a segunda
   * checagem sempre verdadeira. A chamada preserva a leitura em tempo de execução,
   * que é a que importa aqui.
   */
  private isRunning(): boolean {
    return this.running;
  }

  /**
   * Espera o intervalo, ou menos se `stop()` chegar antes.
   *
   * Sem o despertar por `stop()`, encerrar o worker custaria até um intervalo
   * inteiro — e um teste que sobe e derruba o worker várias vezes pagaria esse
   * preço em cada rodada.
   */
  private waitForNextCycle(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, this.options.pollIntervalMs);
    });
  }
}

/**
 * Identidade legível e única para `locked_by`.
 *
 * O pid responde "qual processo" numa investigação; o UUIDv7 garante unicidade
 * quando dois processos reciclam o mesmo pid depois de um reinício. Cabe folgado
 * nos 120 caracteres da coluna.
 */
export function defaultInstanceId(): string {
  return `outbox-publisher#${String(process.pid)}#${Bun.randomUUIDv7()}`;
}
