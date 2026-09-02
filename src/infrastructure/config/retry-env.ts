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
 * **Escopo atual:** os parâmetros do loop da outbox (RF-24). O TTL de
 * `PENDING_REFERENCE` e o `maxReceiveCount` do SQS completam a tabela de D-008 e
 * entram **neste mesmo módulo** em E-11 e E-13 — escrevê-los agora seria código
 * sem consumidor, e D-008 pede uma curva só, não uma por loop.
 */
import type { RetryPolicy } from "../../domain/retry-policy.ts";

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
}

/** Defaults de D-008, em um lugar só para que o teste possa citá-los. */
const DEFAULTS: RetryEnv = {
  outboxBaseDelayMs: 1_000,
  outboxMaxDelayMs: 300_000,
  outboxMaxAttempts: 10,
  outboxLeaseMs: 30_000,
  outboxBatchSize: 10,
  outboxPollIntervalMs: 1_000,
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

/** Inteiro positivo lido do ambiente, com queda para o default. */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
