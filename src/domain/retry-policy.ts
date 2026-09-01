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
