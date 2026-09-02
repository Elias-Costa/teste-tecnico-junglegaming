/**
 * E-10 — o módulo único de configuração de retry (D-008, D-022).
 *
 * O que estes testes protegem não são os números em si: é a **propriedade** que
 * D-008 comprou ao parametrizá-los. RT-11, RT-19 e RT-20 esperariam minutos com
 * constantes fixas, ou exigiriam relógio falso; com o ambiente sobrescrevendo,
 * os testes usam milissegundos **sem trocar o mecanismo por um substituto**. Se
 * uma variável parar de ser lida, a suíte de concorrência volta a demorar
 * minutos e ninguém saberia por quê.
 *
 * O outro alvo é a queda para o default diante de valor malformado: um
 * `OUTBOX_LEASE_MS=trinta` produziria `NaN`, e `new Date(now + NaN)` é
 * `Invalid Date` — a linha da outbox ficaria com `locked_until` inválido e a
 * publicação inteira travaria por causa de um erro de digitação no `.env`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { outboxRetryPolicy, readRetryEnv } from "../../src/infrastructure/config/retry-env.ts";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

/** Limpa as seis variáveis, para que o teste veja o default e não o `.env` de quem roda. */
function semAmbiente(): void {
  delete process.env.OUTBOX_BASE_DELAY_MS;
  delete process.env.OUTBOX_MAX_DELAY_MS;
  delete process.env.OUTBOX_MAX_ATTEMPTS;
  delete process.env.OUTBOX_LEASE_MS;
  delete process.env.OUTBOX_BATCH_SIZE;
  delete process.env.OUTBOX_POLL_INTERVAL_MS;
}

describe("readRetryEnv — defaults conservadores de D-008", () => {
  it("entrega os números que D-008 fixou", () => {
    semAmbiente();

    expect(readRetryEnv()).toEqual({
      outboxBaseDelayMs: 1_000,
      outboxMaxDelayMs: 300_000,
      outboxMaxAttempts: 10,
      outboxLeaseMs: 30_000,
      outboxBatchSize: 10,
      outboxPollIntervalMs: 1_000,
    });
  });

  it("deixa o ambiente sobrescrever — é o que torna a suíte viável em ms", () => {
    process.env.OUTBOX_BASE_DELAY_MS = "5";
    process.env.OUTBOX_MAX_DELAY_MS = "40";
    process.env.OUTBOX_MAX_ATTEMPTS = "3";
    process.env.OUTBOX_LEASE_MS = "250";
    process.env.OUTBOX_BATCH_SIZE = "2";
    process.env.OUTBOX_POLL_INTERVAL_MS = "10";

    expect(readRetryEnv()).toEqual({
      outboxBaseDelayMs: 5,
      outboxMaxDelayMs: 40,
      outboxMaxAttempts: 3,
      outboxLeaseMs: 250,
      outboxBatchSize: 2,
      outboxPollIntervalMs: 10,
    });
  });

  it("valor malformado cai no default em vez de virar NaN", () => {
    semAmbiente();
    process.env.OUTBOX_LEASE_MS = "trinta";
    process.env.OUTBOX_BATCH_SIZE = "2.5";

    const env = readRetryEnv();

    // `new Date(agora + NaN)` seria `Invalid Date`, e o `locked_until` inválido
    // travaria a publicação inteira por causa de um erro de digitação no `.env`.
    expect(env.outboxLeaseMs).toBe(30_000);
    expect(env.outboxBatchSize).toBe(10);
  });

  it("valor não positivo cai no default: lote zero nunca publicaria nada", () => {
    semAmbiente();
    process.env.OUTBOX_BATCH_SIZE = "0";
    process.env.OUTBOX_LEASE_MS = "-1";

    const env = readRetryEnv();

    expect(env.outboxBatchSize).toBe(10);
    expect(env.outboxLeaseMs).toBe(30_000);
  });
});

describe("outboxRetryPolicy — a política que D-022 manda injetar", () => {
  it("leva os dois limites da configuração para a curva do domínio", () => {
    const policy = outboxRetryPolicy({
      outboxBaseDelayMs: 7,
      outboxMaxDelayMs: 99,
      outboxMaxAttempts: 10,
      outboxLeaseMs: 30_000,
      outboxBatchSize: 10,
      outboxPollIntervalMs: 1_000,
    });

    expect(policy.baseDelayMs).toBe(7);
    expect(policy.maxDelayMs).toBe(99);
  });

  it("o jitter sorteia dentro de [0, 1) — é o contrato que `scheduleRetry` assume", () => {
    semAmbiente();
    const { random } = outboxRetryPolicy();

    // Este é o único ponto do projeto onde `Math.random()` entra (a guarda de
    // EL-01 bane `Math` fora de `src/infrastructure/config/`). Se o intervalo
    // fugir de [0, 1), o equal jitter de D-022 deixa de ter piso em `h`.
    for (let i = 0; i < 100; i += 1) {
      const sorteio = random();

      expect(sorteio).toBeGreaterThanOrEqual(0);
      expect(sorteio).toBeLessThan(1);
    }
  });
});
