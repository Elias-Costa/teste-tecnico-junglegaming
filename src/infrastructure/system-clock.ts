import type { Clock } from "../application/ports/clock.ts";

/**
 * Relógio do processo — a implementação de produção de `Clock`.
 *
 * Trivial de propósito: a porta existe para o teste poder fixar o instante, não
 * porque a leitura do relógio tenha alguma complexidade a encapsular.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
