import type { Clock } from "../../application/ports/clock.ts";
import type { ProcessWagerTransaction } from "../../application/process-wager-transaction.ts";
import { backoffDelayMs, type RetryPolicy } from "../../domain/retry-policy.ts";
import { WagerTransactionStatus } from "../../domain/wager-transaction.ts";
import { recordRetry } from "../observability/metrics.ts";
import type { PendingReferenceStore } from "./pending-reference-store.ts";

/** Parâmetros operacionais do worker, preenchidos a partir de `readRetryEnv()`. */
export interface PendingReferenceWorkerOptions {
  /** Quantas pendentes examinar por ciclo. */
  batchSize: number;
  /**
   * TTL de `PENDING_REFERENCE` (RF-26, D-008). Default de produção: 15 min.
   *
   * Não é limite de tentativas: é há quanto tempo a transação **existe**. Uma
   * reversão criada há 20 min esgotou o prazo mesmo que o worker tenha subido
   * agora e nunca a tenha examinado — o que se prometeu ao provedor é uma janela
   * de espera, não um número de varreduras.
   */
  ttlMs: number;
  /** Espera entre ciclos quando o ciclo anterior não achou nada devido. */
  pollIntervalMs: number;
  /**
   * Destino dos erros que o laço absorve: falha ao resolver **uma** transação e
   * falha que aborta um ciclo inteiro (banco fora do ar, tipicamente).
   *
   * Mesmo papel que em `OutboxPublisher`: impedir que a falha suma em silêncio
   * enquanto o log estruturado de RNF-06 não existe (E-15). Um worker que
   * sobrevive calado a um PostgreSQL intermitente é cego, não resiliente.
   */
  onCycleError?: ((error: unknown) => void) | undefined;
}

/** O que uma rodada fez — a forma como os testes observam o worker. */
export interface PendingReferenceCycleResult {
  /** Pendentes devidas encontradas na varredura. */
  scanned: number;
  /** Resolvidas: a referência chegou e era válida (`PROCESSED`). */
  resolved: number;
  /** Rejeitadas: referência inválida (D-051) ou TTL esgotado (`REFERENCE_NOT_FOUND`). */
  rejected: number;
  /** Continuam esperando, com a próxima tentativa reagendada pela curva de D-022. */
  rescheduled: number;
  /** Tentativas que morreram em exceção — reportadas por `onCycleError`. */
  failed: number;
}

/**
 * Worker de referências fora de ordem (RF-26, RN-15, D-052).
 *
 * O problema que ele existe para resolver é o da §10 do enunciado: a fila entrega
 * um `ROLLBACK` **antes** da `BET` que ele estorna. Rejeitar seria errado — a
 * `BET` provavelmente vem no próximo lote —, então a reversão fica em
 * `PENDING_REFERENCE` (RN-15) e este laço volta nela com backoff exponencial até
 * a referência aparecer ou o TTL de D-008 acabar.
 *
 * O ciclo tem dois passos, e a divisão de trabalho entre eles é a decisão:
 *
 *  1. **varredura** — `PendingReferenceStore.findDue`, sem lock nenhum;
 *  2. **resolução** — `ProcessWagerTransaction.resolvePendingReference`, que trava
 *     a wallet, relê a linha e decide pelas mesmas regras da submissão (D-054).
 *
 * Quem continua pendente é reagendado por `UPDATE` direto nas colunas de retry
 * (D-052) — fora do agregado, como o lease da outbox em D-043.
 *
 * **Este worker não tem regra de negócio.** Ele varre, chama e reagenda; a decisão
 * de reverter ou rejeitar mora inteira no use case, e é isso que impede o caminho
 * de fundo de divergir do caminho de submissão no ponto em que a divergência
 * moveria dinheiro.
 */
export class PendingReferenceWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly store: PendingReferenceStore,
    private readonly useCase: ProcessWagerTransaction,
    private readonly clock: Clock,
    private readonly policy: RetryPolicy,
    private readonly options: PendingReferenceWorkerOptions,
  ) {}

  /**
   * Executa **um** ciclo e devolve o que aconteceu.
   *
   * É o método que os testes dirigem, e o laço de `start()` não é nada além de
   * chamá-lo em sequência — o mesmo formato de `OutboxPublisher`, pelo mesmo
   * motivo: um ciclo determinístico prova varredura, resolução e reagendamento
   * sem depender de temporizador.
   *
   * O processamento é **sequencial** dentro do lote, e aqui isso não é só ordem:
   * duas pendentes da mesma wallet disputariam o `FOR UPDATE` uma da outra se
   * fossem em paralelo, e a cadeia de D-050 — um `ROLLBACK` esperando por um
   * `REFUND` que também espera — só desencalha inteira no mesmo ciclo se a mais
   * antiga for resolvida primeiro.
   *
   * Falha de uma transação **não** aborta as outras: cada uma tem seu desfecho.
   */
  async runOnce(): Promise<PendingReferenceCycleResult> {
    const now = this.clock.now();
    const due = await this.store.findDue(now, this.options.batchSize);

    // O prazo é um instante de **nascimento**, não de tentativa: uma transação
    // criada antes dele esgotou o TTL. Calculado uma vez por ciclo, para que
    // todas as pendentes do lote sejam julgadas pelo mesmo relógio.
    const deadline = new Date(now.getTime() - this.options.ttlMs);

    let resolved = 0;
    let rejected = 0;
    let rescheduled = 0;
    let failed = 0;

    for (const pending of due) {
      try {
        const status = await this.useCase.resolvePendingReference(pending.id, deadline);

        if (status === WagerTransactionStatus.PendingReference) {
          await this.reschedule(pending.id, pending.referenceAttempts);
          // `wager_retries_total{loop="pending_reference"}` (D-010, D-062): a
          // referência ainda não chegou e a pendente foi remarcada pela curva de
          // D-022. Subir sem parar aqui é o sinal de que um produtor está
          // mandando reversão para uma `BET` que nunca vem.
          recordRetry("pending_reference");
          rescheduled += 1;
        } else if (status === WagerTransactionStatus.Processed) {
          resolved += 1;
        } else if (status === WagerTransactionStatus.Rejected) {
          rejected += 1;
        }
      } catch (error) {
        // Nada é reagendado numa falha: a transação continua devida e o próximo
        // ciclo a pega de novo. Reagendar aqui empurraria para o futuro uma
        // pendente que não chegou a ser examinada — e, com erro transitório de
        // banco, atrasaria todas as pendentes por um problema que já passou.
        this.options.onCycleError?.(error);
        failed += 1;
      }
    }

    return { scanned: due.length, resolved, rejected, rescheduled, failed };
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
   * Esperar importa mais aqui do que na outbox: um ciclo interrompido no meio
   * pode ter travado uma wallet, e derrubar o processo com a transação aberta
   * deixaria o `FOR UPDATE` de pé até o servidor limpar a conexão.
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
   * Reagenda a próxima tentativa pela curva de D-022.
   *
   * `attempts` é a contagem **já ocorrida**, que é o que `backoffDelayMs` espera:
   * a primeira revarredura cai no degrau base, não no dobro dele. O contador
   * gravado é o incrementado, porque a tentativa que acabou de acontecer passa a
   * fazer parte do passado.
   */
  private async reschedule(id: string, attempts: number): Promise<void> {
    const at = new Date(this.clock.now().getTime() + backoffDelayMs(attempts, this.policy));

    await this.store.scheduleRetry(id, attempts + 1, at);
  }

  /**
   * O laço em si.
   *
   * Só espera quando o ciclo veio vazio: com muitas pendentes devidas, o worker
   * encadeia lotes sem latência artificial. Um erro de ciclo — banco indisponível,
   * tipicamente — não derruba o laço; ele espera o intervalo e tenta de novo, que
   * é o comportamento que RNF-05 cobra diante de infraestrutura momentaneamente
   * fora.
   */
  private async run(): Promise<void> {
    while (this.isRunning()) {
      let idle = true;

      try {
        const result = await this.runOnce();
        idle = result.scanned === 0;
      } catch (error) {
        this.options.onCycleError?.(error);
      }

      // A segunda leitura da bandeira não é redundante: `stop()` pode ter chegado
      // **durante** o ciclo, e aí `wake` ainda não existia para ser chamado. Sem
      // ela, encerrar custaria um intervalo inteiro de espera.
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

  /** Espera o intervalo, ou menos se `stop()` chegar antes. */
  private waitForNextCycle(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, this.options.pollIntervalMs);
    });
  }
}
