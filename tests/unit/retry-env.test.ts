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
import {
  consumerBackoffSeconds,
  consumerRetryPolicy,
  outboxRetryPolicy,
  pendingReferenceRetryPolicy,
  readRetryEnv,
} from "../../src/infrastructure/config/retry-env.ts";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

/** Limpa as dezessete variáveis, para que o teste veja o default e não o `.env` de quem roda. */
function semAmbiente(): void {
  delete process.env.OUTBOX_BASE_DELAY_MS;
  delete process.env.OUTBOX_MAX_DELAY_MS;
  delete process.env.OUTBOX_MAX_ATTEMPTS;
  delete process.env.OUTBOX_LEASE_MS;
  delete process.env.OUTBOX_BATCH_SIZE;
  delete process.env.OUTBOX_POLL_INTERVAL_MS;
  delete process.env.CONSUMER_MAX_RECEIVE_COUNT;
  delete process.env.CONSUMER_VISIBILITY_TIMEOUT_SEC;
  delete process.env.CONSUMER_WAIT_TIME_SEC;
  delete process.env.CONSUMER_BATCH_SIZE;
  delete process.env.CONSUMER_BASE_DELAY_MS;
  delete process.env.CONSUMER_MAX_DELAY_MS;
  delete process.env.PENDING_REFERENCE_TTL_MS;
  delete process.env.PENDING_REFERENCE_BASE_DELAY_MS;
  delete process.env.PENDING_REFERENCE_MAX_DELAY_MS;
  delete process.env.PENDING_REFERENCE_BATCH_SIZE;
  delete process.env.PENDING_REFERENCE_POLL_INTERVAL_MS;
}

/** Os defaults de D-008 do consumidor, repetidos onde o teste precisa do objeto inteiro. */
const DEFAULTS_CONSUMIDOR = {
  consumerMaxReceiveCount: 5,
  consumerVisibilityTimeoutSec: 30,
  consumerWaitTimeSec: 20,
  consumerBatchSize: 10,
  consumerBaseDelayMs: 1_000,
  consumerMaxDelayMs: 300_000,
};

/** Os defaults do worker de referências fora de ordem (RF-26), idem. */
const DEFAULTS_REFERENCIA = {
  pendingReferenceTtlMs: 900_000,
  pendingReferenceBaseDelayMs: 1_000,
  pendingReferenceMaxDelayMs: 300_000,
  pendingReferenceBatchSize: 10,
  pendingReferencePollIntervalMs: 1_000,
};

/** Os defaults da outbox, idem. */
const DEFAULTS_OUTBOX = {
  outboxBaseDelayMs: 1_000,
  outboxMaxDelayMs: 300_000,
  outboxMaxAttempts: 10,
  outboxLeaseMs: 30_000,
  outboxBatchSize: 10,
  outboxPollIntervalMs: 1_000,
};

describe("readRetryEnv — defaults conservadores de D-008", () => {
  it("entrega os números que D-008 fixou", () => {
    semAmbiente();

    expect(readRetryEnv()).toEqual({
      ...DEFAULTS_OUTBOX,
      ...DEFAULTS_CONSUMIDOR,
      ...DEFAULTS_REFERENCIA,
    });
  });

  it("deixa o ambiente sobrescrever — é o que torna a suíte viável em ms", () => {
    process.env.OUTBOX_BASE_DELAY_MS = "5";
    process.env.OUTBOX_MAX_DELAY_MS = "40";
    process.env.OUTBOX_MAX_ATTEMPTS = "3";
    process.env.OUTBOX_LEASE_MS = "250";
    process.env.OUTBOX_BATCH_SIZE = "2";
    process.env.OUTBOX_POLL_INTERVAL_MS = "10";
    process.env.CONSUMER_MAX_RECEIVE_COUNT = "2";
    process.env.CONSUMER_VISIBILITY_TIMEOUT_SEC = "3";
    process.env.CONSUMER_WAIT_TIME_SEC = "0";
    process.env.CONSUMER_BATCH_SIZE = "1";
    process.env.CONSUMER_BASE_DELAY_MS = "5";
    process.env.CONSUMER_MAX_DELAY_MS = "40";
    process.env.PENDING_REFERENCE_TTL_MS = "120";
    process.env.PENDING_REFERENCE_BASE_DELAY_MS = "5";
    process.env.PENDING_REFERENCE_MAX_DELAY_MS = "40";
    process.env.PENDING_REFERENCE_BATCH_SIZE = "2";
    process.env.PENDING_REFERENCE_POLL_INTERVAL_MS = "10";

    expect(readRetryEnv()).toEqual({
      outboxBaseDelayMs: 5,
      outboxMaxDelayMs: 40,
      outboxMaxAttempts: 3,
      outboxLeaseMs: 250,
      outboxBatchSize: 2,
      outboxPollIntervalMs: 10,
      consumerMaxReceiveCount: 2,
      consumerVisibilityTimeoutSec: 3,
      consumerWaitTimeSec: 0,
      consumerBatchSize: 1,
      consumerBaseDelayMs: 5,
      consumerMaxDelayMs: 40,
      pendingReferenceTtlMs: 120,
      pendingReferenceBaseDelayMs: 5,
      pendingReferenceMaxDelayMs: 40,
      pendingReferenceBatchSize: 2,
      pendingReferencePollIntervalMs: 10,
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
      ...DEFAULTS_OUTBOX,
      ...DEFAULTS_CONSUMIDOR,
      ...DEFAULTS_REFERENCIA,
      outboxBaseDelayMs: 7,
      outboxMaxDelayMs: 99,
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

describe("parâmetros do consumidor — a outra metade de D-008 (E-11)", () => {
  it("`CONSUMER_WAIT_TIME_SEC=0` é aceito: é como se desliga o long polling", () => {
    semAmbiente();
    process.env.CONSUMER_WAIT_TIME_SEC = "0";

    // É o único dos doze parâmetros em que zero é configuração **válida**, e não
    // configuração quebrada — um teste determinístico não quer esperar 20 s pela
    // fila vazia. Lote zero ou visibilidade zero seriam defeito, e caem no default.
    expect(readRetryEnv().consumerWaitTimeSec).toBe(0);
  });

  it("visibilidade e lote zerados caem no default", () => {
    semAmbiente();
    process.env.CONSUMER_BATCH_SIZE = "0";
    process.env.CONSUMER_VISIBILITY_TIMEOUT_SEC = "0";

    const env = readRetryEnv();

    // Visibilidade zero devolveria a mensagem antes de a transação commitar, e
    // lote zero nunca receberia nada.
    expect(env.consumerBatchSize).toBe(10);
    expect(env.consumerVisibilityTimeoutSec).toBe(30);
  });

  it("`consumerRetryPolicy` leva os limites do consumidor, não os da outbox", () => {
    const policy = consumerRetryPolicy({
      ...DEFAULTS_OUTBOX,
      ...DEFAULTS_CONSUMIDOR,
      ...DEFAULTS_REFERENCIA,
      consumerBaseDelayMs: 11,
      consumerMaxDelayMs: 77,
    });

    // Curva única (D-008), números independentes: os três loops falham por
    // motivos diferentes e nada obriga a mesma cadência.
    expect(policy.baseDelayMs).toBe(11);
    expect(policy.maxDelayMs).toBe(77);
  });
});

describe("parâmetros do worker de referências — a terceira parte de D-008 (E-13)", () => {
  it("o TTL default é os 15 min que D-008 fixou", () => {
    semAmbiente();

    // Único número da tabela de D-008 que o enunciado cobra justificado por
    // extenso: é a janela de espera prometida ao provedor, não uma contagem de
    // varreduras (RF-26).
    expect(readRetryEnv().pendingReferenceTtlMs).toBe(900_000);
  });

  it("TTL zerado ou malformado cai no default", () => {
    semAmbiente();
    process.env.PENDING_REFERENCE_TTL_MS = "0";
    process.env.PENDING_REFERENCE_BATCH_SIZE = "quinze";

    const env = readRetryEnv();

    // TTL zero rejeitaria **toda** pendente na primeira varredura, com
    // `REFERENCE_NOT_FOUND`, antes de a referência ter qualquer chance de chegar.
    expect(env.pendingReferenceTtlMs).toBe(900_000);
    expect(env.pendingReferenceBatchSize).toBe(10);
  });

  it("`pendingReferenceRetryPolicy` leva os limites do worker, não os dos outros dois", () => {
    const policy = pendingReferenceRetryPolicy({
      ...DEFAULTS_OUTBOX,
      ...DEFAULTS_CONSUMIDOR,
      ...DEFAULTS_REFERENCIA,
      pendingReferenceBaseDelayMs: 13,
      pendingReferenceMaxDelayMs: 88,
    });

    expect(policy.baseDelayMs).toBe(13);
    expect(policy.maxDelayMs).toBe(88);
  });
});

describe("consumerBackoffSeconds — a curva de D-022 em segundos de visibilidade", () => {
  /** Jitter no piso: o atraso vira exatamente `capped / 2`, e o teste afirma o valor. */
  const curva = { baseDelayMs: 8_000, maxDelayMs: 600_000, random: () => 0 };

  it("a primeira entrega cai no degrau base, não já no dobro dele", () => {
    // O SQS conta a partir de 1; a curva de D-022 espera as tentativas **já
    // ocorridas**. Sem o desconto, a primeira devolução pularia um degrau.
    expect(consumerBackoffSeconds("1", curva)).toBe(4);
  });

  it("cresce com as entregas", () => {
    expect(consumerBackoffSeconds("2", curva)).toBe(8);
    expect(consumerBackoffSeconds("3", curva)).toBe(16);
  });

  it("satura no teto da política", () => {
    expect(consumerBackoffSeconds("30", { ...curva, maxDelayMs: 20_000 })).toBe(10);
  });

  it("contagem ausente ou malformada é tratada como primeira entrega", () => {
    // Atrasar de menos é recuperável; travar o retorno da mensagem não é.
    expect(consumerBackoffSeconds(undefined, curva)).toBe(4);
    expect(consumerBackoffSeconds("muitas", curva)).toBe(4);
  });

  it("nunca devolve zero — piso de 1 segundo", () => {
    // `ChangeMessageVisibility(0)` significa "entregue já", que é o gesto de
    // encerramento de RF-22 e não o de um erro transitório.
    expect(consumerBackoffSeconds("1", { ...curva, baseDelayMs: 10, maxDelayMs: 20 })).toBe(1);
  });
});
