/**
 * Módulo único de configuração de retry exigido por D-008.
 *
 * Mesmo padrão de `database-env.ts` e `sqs-env.ts`: lê do ambiente, com defaults
 * conservadores. A parametrização não é conveniência — RT-11 e RT-19 esperariam
 * minutos com constantes fixas, ou exigiriam relógio falso, e o enunciado cobra
 * paralelismo real. Com os valores injetáveis, os testes usam milissegundos
 * **sem trocar o mecanismo por um substituto**.
 *
 * Fica em `src/infrastructure/config/` por uma razão técnica além da
 * organizacional: é o único diretório onde a guarda de EL-01 libera `Number()` e
 * `Math`. Limite de tentativa e duração de lease são inteiros de configuração,
 * não dinheiro — e `Math.random()` é justamente a fonte de jitter que D-022
 * mandou injetar na entidade, que não pode buscá-la sozinha.
 *
 * **Escopo atual:** os parâmetros do loop da outbox (RF-24) e os do consumidor
 * SQS (RF-21), estes acrescentados em E-11 — incluindo o `maxReceiveCount` da
 * tabela de D-008. Falta só o TTL de `PENDING_REFERENCE`, que entra **neste
 * mesmo módulo** em E-13; escrevê-lo agora seria código sem consumidor.
 *
 * Os dois loops têm números próprios e **uma fórmula só**: a curva de equal
 * jitter mora em `backoffDelayMs` (`src/domain/retry-policy.ts`), e é isso que
 * D-008 quer dizer com uma curva, não uma por loop.
 */
import { backoffDelayMs, type RetryPolicy } from "../../domain/retry-policy.ts";

/** Parâmetros dos loops de retry, resolvidos a partir do ambiente (D-008). */
export interface RetryEnv {
  /** Atraso da primeira tentativa de publicação, antes do jitter. Default 1 s. */
  outboxBaseDelayMs: number;
  /** Teto do backoff de publicação. A curva satura aqui. Default 5 min. */
  outboxMaxDelayMs: number;
  /**
   * Teto do expoente do backoff e limiar de alerta (D-008, emendado por D-042).
   *
   * **Não é ponto de desistência.** Todo evento gravado na mesma transação do
   * dinheiro precisa sair: parar de publicar na 11ª tentativa quebraria a
   * invariante de D-034 de que toda transação aplicada tem evento. Passado este
   * número, a linha continua sendo reivindicada — no teto de 5 min — e quem
   * denuncia é `outbox_lag_seconds` (D-010, E-15).
   */
  outboxMaxAttempts: number;
  /** Duração do lease do claim (D-009). Default 30 s. */
  outboxLeaseMs: number;
  /** Quantas linhas o worker reivindica por ciclo. */
  outboxBatchSize: number;
  /** Intervalo entre ciclos quando não há nada pendente. */
  outboxPollIntervalMs: number;

  /**
   * `maxReceiveCount` da redrive policy da fila de entrada (RF-21, D-008).
   *
   * É o número que o SQS usa para mover a mensagem à DLQ sozinho, e por D-046 ele
   * cobre **só o erro transitório que não cede** — o permanente vai à DLQ por
   * envio explícito, na primeira entrega. Default 5, como a tabela de D-008.
   */
  consumerMaxReceiveCount: number;
  /**
   * Visibility timeout pedido em cada `ReceiveMessage`, em segundos.
   *
   * Precisa cobrir com folga a transação financeira inteira: se vencer no meio,
   * o SQS reentrega a mensagem enquanto a primeira ainda está processando, e a
   * segunda entrega gasta uma tentativa contra a inbox sem necessidade.
   */
  consumerVisibilityTimeoutSec: number;
  /** Long polling do `ReceiveMessage`, em segundos. Zero desliga a espera. */
  consumerWaitTimeSec: number;
  /** Quantas mensagens o consumidor pede por ciclo (teto do SQS é 10). */
  consumerBatchSize: number;
  /** Atraso da primeira devolução de mensagem transitória, antes do jitter. */
  consumerBaseDelayMs: number;
  /** Teto do backoff do consumidor. A curva satura aqui. */
  consumerMaxDelayMs: number;
}

/** Defaults de D-008, em um lugar só para que o teste possa citá-los. */
const DEFAULTS: RetryEnv = {
  outboxBaseDelayMs: 1_000,
  outboxMaxDelayMs: 300_000,
  outboxMaxAttempts: 10,
  outboxLeaseMs: 30_000,
  outboxBatchSize: 10,
  outboxPollIntervalMs: 1_000,
  consumerMaxReceiveCount: 5,
  consumerVisibilityTimeoutSec: 30,
  consumerWaitTimeSec: 20,
  consumerBatchSize: 10,
  consumerBaseDelayMs: 1_000,
  consumerMaxDelayMs: 300_000,
};

/**
 * Lê os parâmetros de retry do ambiente, caindo nos defaults de D-008.
 *
 * Valor não numérico ou não positivo cai no default em vez de propagar `NaN`: um
 * `OUTBOX_LEASE_MS=trinta` produziria `locked_until` inválido e travaria a
 * publicação inteira, que é pior do que ignorar a variável mal escrita.
 */
export function readRetryEnv(): RetryEnv {
  return {
    outboxBaseDelayMs: positiveInt(process.env.OUTBOX_BASE_DELAY_MS, DEFAULTS.outboxBaseDelayMs),
    outboxMaxDelayMs: positiveInt(process.env.OUTBOX_MAX_DELAY_MS, DEFAULTS.outboxMaxDelayMs),
    outboxMaxAttempts: positiveInt(process.env.OUTBOX_MAX_ATTEMPTS, DEFAULTS.outboxMaxAttempts),
    outboxLeaseMs: positiveInt(process.env.OUTBOX_LEASE_MS, DEFAULTS.outboxLeaseMs),
    outboxBatchSize: positiveInt(process.env.OUTBOX_BATCH_SIZE, DEFAULTS.outboxBatchSize),
    outboxPollIntervalMs: positiveInt(
      process.env.OUTBOX_POLL_INTERVAL_MS,
      DEFAULTS.outboxPollIntervalMs,
    ),
    consumerMaxReceiveCount: positiveInt(
      process.env.CONSUMER_MAX_RECEIVE_COUNT,
      DEFAULTS.consumerMaxReceiveCount,
    ),
    consumerVisibilityTimeoutSec: positiveInt(
      process.env.CONSUMER_VISIBILITY_TIMEOUT_SEC,
      DEFAULTS.consumerVisibilityTimeoutSec,
    ),
    // Único parâmetro que aceita zero: `WaitTimeSeconds=0` é a forma documentada
    // de desligar o long polling, e é o que um teste determinístico quer. Os
    // outros cinco recusam zero porque zero ali é configuração quebrada.
    consumerWaitTimeSec: nonNegativeInt(
      process.env.CONSUMER_WAIT_TIME_SEC,
      DEFAULTS.consumerWaitTimeSec,
    ),
    consumerBatchSize: positiveInt(process.env.CONSUMER_BATCH_SIZE, DEFAULTS.consumerBatchSize),
    consumerBaseDelayMs: positiveInt(
      process.env.CONSUMER_BASE_DELAY_MS,
      DEFAULTS.consumerBaseDelayMs,
    ),
    consumerMaxDelayMs: positiveInt(
      process.env.CONSUMER_MAX_DELAY_MS,
      DEFAULTS.consumerMaxDelayMs,
    ),
  };
}

/**
 * Monta a `RetryPolicy` que `OutboxMessage.scheduleRetry` recebe (D-022).
 *
 * É aqui — e só aqui — que `Math.random()` entra no projeto. D-022 injetou o
 * gerador na chamada porque a guarda de EL-01 bane `Math` em `src/domain/`, e
 * porque com ele injetado o teste da curva fica determinístico **sem** trocar o
 * mecanismo por um gerador falso.
 */
export function outboxRetryPolicy(env: RetryEnv = readRetryEnv()): RetryPolicy {
  return {
    baseDelayMs: env.outboxBaseDelayMs,
    maxDelayMs: env.outboxMaxDelayMs,
    random: () => Math.random(),
  };
}

/**
 * Monta a `RetryPolicy` do consumidor SQS (RF-21, D-008, D-022).
 *
 * Mesma curva da outbox — `backoffDelayMs` é uma função só, como D-008 exige —,
 * com números próprios: os dois loops falham por motivos diferentes (SQS fora
 * contra PostgreSQL fora) e nada obriga a mesma cadência. O que não pode haver é
 * uma segunda **fórmula**.
 */
export function consumerRetryPolicy(env: RetryEnv = readRetryEnv()): RetryPolicy {
  return {
    baseDelayMs: env.consumerBaseDelayMs,
    maxDelayMs: env.consumerMaxDelayMs,
    random: () => Math.random(),
  };
}

/**
 * Quantos segundos devolver uma mensagem transitória à fila (RF-21, D-022).
 *
 * Recebe o `ApproximateReceiveCount` **como o SQS o entrega** — texto — e é essa
 * a razão de esta função morar aqui e não junto do consumidor: converter texto em
 * inteiro exige `Number()`, e a guarda de EL-01 só o libera neste diretório. A
 * exceção não foi ampliada; a conversão é que veio para onde ela já vale.
 *
 * A contagem do SQS começa em **1** na primeira entrega, e a curva de D-022
 * espera as tentativas **já ocorridas** — daí o desconto de um, que faz a
 * primeira devolução cair no degrau base em vez de já no dobro dele. Contagem
 * ausente ou malformada é tratada como primeira entrega: atrasar de menos é
 * recuperável, e travar o retorno da mensagem não é.
 *
 * @returns segundos inteiros, com piso de 1. A truncagem é por resto e divisão
 * porque `ChangeMessageVisibility` não aceita fração — e `Math.floor` seria
 * gratuito num arquivo que só usa `Math` para o jitter de D-022.
 */
export function consumerBackoffSeconds(
  approximateReceiveCount: string | undefined,
  policy: RetryPolicy,
): number {
  const received = intOrUndefined(approximateReceiveCount);
  const attempts = received !== undefined && received > 1 ? received - 1 : 0;

  const delayMs = backoffDelayMs(attempts, policy);
  const whole = (delayMs - (delayMs % 1_000)) / 1_000;

  return whole < 1 ? 1 : whole;
}

/** Inteiro positivo lido do ambiente, com queda para o default. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = intOrUndefined(raw);

  return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

/** Inteiro maior ou igual a zero, para o único parâmetro em que zero é válido. */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = intOrUndefined(raw);

  return parsed !== undefined && parsed >= 0 ? parsed : fallback;
}

/** Converte o texto do ambiente em inteiro, ou `undefined` se não for um. */
function intOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);

  return Number.isInteger(parsed) ? parsed : undefined;
}
