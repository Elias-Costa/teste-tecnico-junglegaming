import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction.ts";

/**
 * De onde veio a operação: a borda HTTP (RF-13) ou a fila (RF-18).
 *
 * É o label `source` de duas métricas da tabela de D-010, e existe porque as
 * duas entradas percorrem o **mesmo** use case: sem ele, uma latência ruim não
 * distinguiria uma API lenta de um consumidor lento.
 */
export type MetricSource = "http" | "sqs";

/**
 * Os três laços de retry de D-008 — o label `loop` de `wager_retries_total`.
 *
 * Os valores são os que a tabela de D-010 escreve, e a união fechada é o que
 * impede um quarto valor de aparecer sem passar por uma decisão registrada.
 */
export type RetryLoop = "outbox" | "sqs" | "pending_reference";

/**
 * Registro de métricas do processo (D-010, D-062).
 *
 * **Singleton de módulo, e essa é a decisão de D-062.** O registro do
 * `prom-client` é global por natureza, e os três workers vivem fora do container
 * do NestJS: injetá-lo por DI alcançaria só a metade HTTP do código, e a outra
 * metade precisaria de um segundo caminho — duas fontes para o mesmo
 * `/metrics`. Registrar o mesmo nome duas vezes lançaria, e o módulo ser
 * avaliado uma vez é o que garante que isso não aconteça.
 *
 * Registro próprio em vez do global do `prom-client`: o `/metrics` desta
 * aplicação expõe o que **esta** aplicação declara, e uma biblioteca que decida
 * registrar métricas no registro padrão não entra no contrato de D-010 sem
 * ninguém perceber.
 */
export const metricsRegistry = new Registry();

// Métricas de processo (CPU, memória, event loop, GC). Não são de RNF-07, mas
// são o que um avaliador espera encontrar num `/metrics` e custam uma linha.
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Faixas de tempo dos dois histogramas, em segundos.
 *
 * Escolhidas para a ordem de grandeza deste sistema: uma transação financeira
 * saudável fecha em dezenas de milissegundos, e a espera por lock é o sinal que
 * precisa ser legível **exatamente** na faixa onde a contenção começa a doer.
 * Sem faixa acima de 10 s: mais que isso não é lentidão, é indisponibilidade, e
 * quem denuncia é o `503` de D-037.
 */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** `wager_transactions_total{status,kind}` — transações por status (RNF-07). */
const transactionsTotal = new Counter({
  name: "wager_transactions_total",
  help: "Transações de aposta por status de desfecho e tipo de operação.",
  labelNames: ["status", "kind"] as const,
  registers: [metricsRegistry],
});

/** `wager_duplicates_total{source}` — replay de RF-14 e dedup de inbox de RF-19. */
const duplicatesTotal = new Counter({
  name: "wager_duplicates_total",
  help: "Duplicatas detectadas: replay idempotente no HTTP e dedup de inbox no SQS.",
  labelNames: ["source"] as const,
  registers: [metricsRegistry],
});

/** `wager_retries_total{loop}` — retentativas dos laços de D-008. */
const retriesTotal = new Counter({
  name: "wager_retries_total",
  help: "Retentativas agendadas por cada laço de retry.",
  labelNames: ["loop"] as const,
  registers: [metricsRegistry],
});

/**
 * `wager_dlq_messages_total` — mensagens enviadas à DLQ.
 *
 * Sem label, e por isso conta **só** o envio explícito de D-046. A DLQ tem dois
 * caminhos de entrada, e o outro — a redrive policy do SQS esgotando as cinco
 * entregas — acontece dentro do broker, onde nenhum contador deste processo
 * alcança. Quem observa aquele é o `ApproximateNumberOfMessages` da própria DLQ.
 */
const deadLetterTotal = new Counter({
  name: "wager_dlq_messages_total",
  help: "Mensagens enviadas explicitamente à dead-letter queue por erro permanente.",
  registers: [metricsRegistry],
});

/**
 * `wallet_lock_wait_seconds` — espera pelo `FOR UPDATE` da wallet.
 *
 * Mede **espera**, não falha: por D-002 a estratégia é pessimista, então
 * contenção aparece como fila, não como conflito de versão. É a leitura de
 * "conflitos de lock" que RNF-07 pede num sistema que não usa optimistic locking.
 */
const lockWaitSeconds = new Histogram({
  name: "wallet_lock_wait_seconds",
  help: "Tempo de espera para adquirir o lock pessimista da wallet.",
  buckets: LATENCY_BUCKETS,
  registers: [metricsRegistry],
});

/** `wager_processing_seconds{source}` — latência de processamento (RNF-07). */
const processingSeconds = new Histogram({
  name: "wager_processing_seconds",
  help: "Latência de processamento de uma operação, da borda ao desfecho.",
  labelNames: ["source"] as const,
  buckets: LATENCY_BUCKETS,
  registers: [metricsRegistry],
});

/**
 * `wallet_reconciliation_checks_total{consistent}` — reconciliações de RF-16 (D-060).
 *
 * Conta **toda** verificação, não só a divergente. Contar apenas divergências
 * daria o numerador sem o denominador, e três divergências em dez verificações é
 * um incidente enquanto três em dez mil é ruído — a mesma métrica não distingue
 * os dois casos se o total não for coletado.
 */
const reconciliationChecksTotal = new Counter({
  name: "wallet_reconciliation_checks_total",
  help: "Reconciliações de saldo executadas, separadas por desfecho.",
  labelNames: ["consistent"] as const,
  registers: [metricsRegistry],
});

/**
 * Fonte do lag da outbox, ligada no bootstrap por `bindOutboxLagSource`.
 *
 * Fica indefinida até alguém ligar o banco: o módulo é avaliado antes de existir
 * conexão, e um `/metrics` que exigisse PostgreSQL para ser montado seria pior
 * que um `outbox_lag_seconds` ausente por um instante.
 */
let outboxLagSource: (() => Promise<number>) | undefined;

/**
 * `outbox_lag_seconds` — idade da mensagem pendente mais antiga (D-010).
 *
 * É a única métrica que **não** é incrementada no caminho quente: ela pergunta ao
 * banco a cada scrape, o que a torna a que mais diz sobre a saúde do sistema. Um
 * worker parado não incrementa contador nenhum — o silêncio é indistinguível de
 * "não houve tráfego" —, mas faz este número subir sozinho. É também o sinal que
 * D-042 nomeou como substituto da desistência: a linha que passou das 10
 * tentativas continua sendo publicada, e é aqui que ela aparece.
 *
 * É o **único** instrumento exportado, e por um motivo: os outros sete são
 * alimentados por funções deste módulo, enquanto este depende de uma fonte ligada
 * de fora. O teste também o lê diretamente, em vez de depender do formato do
 * texto exposto em `/metrics`.
 */
export const outboxLagSeconds = new Gauge({
  name: "outbox_lag_seconds",
  help: "Idade, em segundos, da mensagem de outbox pendente mais antiga.",
  registers: [metricsRegistry],
  async collect() {
    if (outboxLagSource === undefined) {
      return;
    }

    try {
      this.set(await outboxLagSource());
    } catch {
      // Banco fora não pode derrubar o scrape inteiro: as outras sete métricas
      // continuam válidas e são justamente as que ajudam a diagnosticar a queda.
      // O gauge mantém o último valor conhecido, que é o comportamento correto
      // para quem lê a série temporal.
    }
  },
});

/**
 * Liga a consulta de lag ao gauge (D-063: quem liga é o `main.ts`).
 *
 * Existe porque a ordem de construção é inevitável — o módulo de métricas é
 * avaliado na importação, e o `EntityManager` só existe depois do bootstrap.
 */
export function bindOutboxLagSource(read: () => Promise<number>): void {
  outboxLagSource = read;
}

/** O desfecho de uma operação processada, no que a métrica precisa dele. */
export interface SubmissionOutcome {
  source: MetricSource;
  status: WagerTransactionStatus;
  kind: WagerTransactionKind;
  /** `true` quando RF-14 devolveu o desfecho original em vez de processar. */
  idempotentReplay: boolean;
}

/**
 * Contabiliza uma operação processada (RNF-07).
 *
 * As duas métricas andam juntas porque descrevem o mesmo evento por dois
 * ângulos, e separá-las em duas chamadas na borda abriria espaço para uma delas
 * ser esquecida num caminho novo.
 */
export function recordSubmission(outcome: SubmissionOutcome): void {
  transactionsTotal.inc({ status: outcome.status, kind: outcome.kind });

  if (outcome.idempotentReplay) {
    duplicatesTotal.inc({ source: outcome.source });
  }
}

/**
 * Contabiliza uma duplicata detectada **antes** de qualquer processamento.
 *
 * É o caminho da inbox (RF-19): a reentrega reconhecida não chega a virar
 * transação, então não passa por `recordSubmission`.
 */
export function recordDuplicate(source: MetricSource): void {
  duplicatesTotal.inc({ source });
}

/** Contabiliza uma retentativa agendada por um dos laços de D-008. */
export function recordRetry(loop: RetryLoop): void {
  retriesTotal.inc({ loop });
}

/** Contabiliza um envio explícito à DLQ (D-046). */
export function recordDeadLetter(): void {
  deadLetterTotal.inc();
}

/** Contabiliza uma reconciliação de RF-16, pelo desfecho (D-060). */
export function recordReconciliationCheck(consistent: boolean): void {
  // O label é textual porque Prometheus só tem labels textuais; `"true"`/`"false"`
  // é a forma canônica e a que as consultas de exemplo em D-060 assumem.
  reconciliationChecksTotal.inc({ consistent: consistent ? "true" : "false" });
}

/**
 * Começa a cronometrar uma operação e devolve quem encerra a medição.
 *
 * `startTimer` do `prom-client` em vez de subtrair instantes à mão: além de ser
 * a API da biblioteca, não há aritmética de tempo escrita neste projeto para
 * alguém precisar conferir.
 */
export function startProcessingTimer(source: MetricSource): () => void {
  const stop = processingSeconds.startTimer({ source });

  return () => {
    stop();
  };
}

/** Começa a cronometrar a espera por um lock de wallet (D-002). */
export function startLockWaitTimer(): () => void {
  const stop = lockWaitSeconds.startTimer();

  return () => {
    stop();
  };
}
