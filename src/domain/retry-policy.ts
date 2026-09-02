/**
 * Parâmetros da curva de backoff, injetados a cada `scheduleRetry` (D-022).
 *
 * Existe porque a entidade **não pode** buscar esses números sozinha: a regra de
 * fronteira de E-01 impede `src/domain/` de importar a configuração de infra, e
 * a guarda de EL-01 bane `Math` em todo `src/` — logo `Math.random()` também
 * está fora. Injetar os três resolve as duas restrições de uma vez e ainda torna
 * a curva determinística sob teste, sem relógio nem gerador falsos.
 *
 * Quem preenche é o módulo de configuração de retry da infraestrutura (E-10),
 * com os defaults de D-008: base de 1 s e teto de 5 min.
 */
export interface RetryPolicy {
  /** Atraso da primeira tentativa, em ms, antes do jitter. */
  baseDelayMs: number;
  /** Teto do atraso, em ms. A curva satura aqui e não cresce mais. */
  maxDelayMs: number;
  /**
   * Fonte de aleatoriedade do jitter, no intervalo `[0, 1)`.
   *
   * Parâmetro e não `Math.random()` por duas razões que se somam: a guarda de
   * EL-01 proíbe `Math` aqui, e sem injeção o teste da curva precisaria de um
   * gerador falso — trocando o mecanismo justamente no ponto que se quer provar.
   */
  random: () => number;
}

/**
 * Teto do expoente do backoff.
 *
 * Existe para que nenhuma contagem de tentativa produza `Infinity` em
 * `2 ** attempts` — a curva já satura em `maxDelayMs` muito antes disso, então o
 * limite não altera nenhum atraso real. É guarda contra dado corrompido vindo do
 * banco (ou contra um `ApproximateReceiveCount` absurdo vindo da fila), não
 * regra de negócio.
 */
const MAX_BACKOFF_EXPONENT = 30;

/**
 * A curva de equal jitter de D-022, como função pura (RF-06, RF-21, D-008).
 *
 * `h = min(maxDelayMs, baseDelayMs · 2^tentativas) / 2` e `delay = h + rand·h`,
 * ou seja, o atraso cai entre `h` e `2h`. O piso é o ponto da decisão: com full
 * jitter o sorteio pode dar quase zero, e sob indisponibilidade prolongada as
 * primeiras tentativas ficariam quase quentes. O jitter é obrigatório (D-008)
 * porque sem ele várias instâncias sincronizam tentativas e criam picos (RI-08).
 *
 * **Mora aqui, e não dentro de `OutboxMessage`, porque há dois consumidores.** A
 * publicação da outbox (E-10) agenda `nextAttemptAt`; o consumidor SQS (E-11)
 * calcula o `ChangeMessageVisibility` de um erro transitório. D-008 pede uma
 * curva só para os três loops — reescrever a fórmula no segundo criaria duas
 * curvas para manter, que é exatamente o que aquela decisão evitou.
 *
 * @param attempt tentativas **já** ocorridas. Zero produz o degrau base, não o
 * dobro dele.
 * @returns o atraso em milissegundos inteiros. A truncagem é por resto, e não
 * por `Math.trunc`: a guarda de EL-01 bane `Math` em todo `src/`, e liberá-lo
 * aqui abriria a porta para arredondamento de dinheiro no mesmo diretório.
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  const exponent = attempt > MAX_BACKOFF_EXPONENT ? MAX_BACKOFF_EXPONENT : attempt;

  const uncapped = policy.baseDelayMs * 2 ** exponent;
  const capped = uncapped > policy.maxDelayMs ? policy.maxDelayMs : uncapped;
  const half = capped / 2;

  const jittered = half + policy.random() * half;

  return jittered - (jittered % 1);
}
