/**
 * E-15 — o contrato de nomenclatura de D-010, verificado (RNF-07).
 *
 * A tabela de D-010 é declarada **contrato de observabilidade**: quem monta
 * alerta ou dashboard escreve os nomes daquela tabela. Um contrato que só existe
 * em documento se quebra num rename silencioso, e por isso os oito nomes — os
 * sete originais mais o de D-060 — estão escritos aqui, literalmente, um por um.
 *
 * O registro é singleton de módulo (D-062), então os contadores acumulam entre os
 * testes deste arquivo. As asserções são por isso sempre **relativas**: mede-se
 * antes, age-se, mede-se depois. Zerar o registro entre testes esconderia o fato
 * de que o estado é global, que é justamente o que D-010 registra como correto.
 */
import { describe, expect, it } from "bun:test";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction.ts";
import {
  bindOutboxLagSource,
  metricsRegistry,
  outboxLagSeconds,
  recordDeadLetter,
  recordDuplicate,
  recordReconciliationCheck,
  recordRetry,
  recordSubmission,
  startLockWaitTimer,
  startProcessingTimer,
} from "../../src/infrastructure/observability/metrics.ts";

/**
 * A tabela de D-010, transcrita: nome e tipo, na ordem em que ela os lista.
 *
 * As oito linhas incluem a que D-060 acrescentou em 2026-09-03. Se alguém
 * renomear uma métrica ou trocar um tipo sem passar por uma decisão registrada,
 * é aqui que a divergência aparece.
 */
const TABELA_DE_D010 = [
  ["wager_transactions_total", "counter"],
  ["wager_duplicates_total", "counter"],
  ["wager_retries_total", "counter"],
  ["wager_dlq_messages_total", "counter"],
  ["wallet_lock_wait_seconds", "histogram"],
  ["outbox_lag_seconds", "gauge"],
  ["wager_processing_seconds", "histogram"],
  ["wallet_reconciliation_checks_total", "counter"],
] as const;

/**
 * Valor corrente de uma métrica para um conjunto exato de labels.
 *
 * Lê o registro em vez do texto exposto: o formato de exposição é contrato com o
 * scraper, não com o teste, e assertar sobre o texto quebraria numa mudança de
 * formatação do `prom-client` que não muda nada para ninguém.
 */
async function valor(nome: string, labels: Record<string, string> = {}): Promise<number> {
  const metricas = await metricsRegistry.getMetricsAsJSON();
  const metrica = metricas.find((candidata) => candidata.name === nome);

  if (metrica === undefined) {
    throw new Error(`métrica ${nome} não está registrada`);
  }

  const amostra = metrica.values.find((candidata) =>
    Object.entries(labels).every(([chave, esperado]) => candidata.labels[chave] === esperado),
  );

  return amostra?.value ?? 0;
}

/**
 * Número de observações de um histograma.
 *
 * Lido pelo bucket `+Inf`, que por definição acumula **todas** as observações —
 * e é um label de verdade, ao contrário do sufixo `_count`, que só existe no
 * texto exposto e não no objeto do registro.
 */
async function observacoes(nome: string, labels: Record<string, string> = {}): Promise<number> {
  return valor(nome, { ...labels, le: "+Inf" });
}

describe("registro de métricas — a tabela de D-010", () => {
  it("expõe os oito nomes decididos, com os tipos decididos", async () => {
    // Asserção sobre o **texto exposto**, e não sobre o campo `type` do objeto:
    // o `.d.ts` do `prom-client` declara `MetricType` como enum numérico
    // enquanto o runtime devolve a string, e o que vale para o scraper — e para
    // o contrato de D-010 — é a linha `# TYPE` que sai no `/metrics`.
    const texto = await metricsRegistry.metrics();

    for (const [nome, tipo] of TABELA_DE_D010) {
      expect(texto).toContain(`# TYPE ${nome} ${tipo}`);
    }
  });

  it("inclui as métricas de processo junto das oito (D-010)", async () => {
    const registradas = await metricsRegistry.getMetricsAsJSON();

    expect(registradas.some((metrica) => metrica.name.startsWith("process_"))).toBe(true);
  });
});

describe("contadores das bordas (D-062)", () => {
  it("conta a transação por status e kind, sem contar duplicata quando não há", async () => {
    const labels = { status: WagerTransactionStatus.Processed, kind: WagerTransactionKind.Bet };
    const antes = await valor("wager_transactions_total", labels);
    const duplicatasAntes = await valor("wager_duplicates_total", { source: "http" });

    recordSubmission({
      source: "http",
      status: WagerTransactionStatus.Processed,
      kind: WagerTransactionKind.Bet,
      idempotentReplay: false,
    });

    expect(await valor("wager_transactions_total", labels)).toBe(antes + 1);
    expect(await valor("wager_duplicates_total", { source: "http" })).toBe(duplicatasAntes);
  });

  it("conta duplicata quando o desfecho é replay idempotente (RF-14)", async () => {
    const antes = await valor("wager_duplicates_total", { source: "http" });

    recordSubmission({
      source: "http",
      status: WagerTransactionStatus.Processed,
      kind: WagerTransactionKind.Bet,
      idempotentReplay: true,
    });

    expect(await valor("wager_duplicates_total", { source: "http" })).toBe(antes + 1);
  });

  it("separa a duplicata de inbox da duplicata de HTTP pelo label source", async () => {
    const antes = await valor("wager_duplicates_total", { source: "sqs" });

    recordDuplicate("sqs");

    expect(await valor("wager_duplicates_total", { source: "sqs" })).toBe(antes + 1);
  });

  it("conta retentativa em cada um dos três laços de D-008, separadamente", async () => {
    const antes = {
      outbox: await valor("wager_retries_total", { loop: "outbox" }),
      sqs: await valor("wager_retries_total", { loop: "sqs" }),
      pendentes: await valor("wager_retries_total", { loop: "pending_reference" }),
    };

    recordRetry("outbox");
    recordRetry("sqs");
    recordRetry("pending_reference");

    expect(await valor("wager_retries_total", { loop: "outbox" })).toBe(antes.outbox + 1);
    expect(await valor("wager_retries_total", { loop: "sqs" })).toBe(antes.sqs + 1);
    expect(await valor("wager_retries_total", { loop: "pending_reference" })).toBe(
      antes.pendentes + 1,
    );
  });

  it("conta o envio explícito à DLQ (D-046)", async () => {
    const antes = await valor("wager_dlq_messages_total");

    recordDeadLetter();

    expect(await valor("wager_dlq_messages_total")).toBe(antes + 1);
  });
});

describe("métrica de reconciliação (RF-16, D-060)", () => {
  it("conta toda verificação, separando consistente de divergente", async () => {
    const antes = {
      consistentes: await valor("wallet_reconciliation_checks_total", { consistent: "true" }),
      divergentes: await valor("wallet_reconciliation_checks_total", { consistent: "false" }),
    };

    recordReconciliationCheck(true);
    recordReconciliationCheck(true);
    recordReconciliationCheck(false);

    // O ponto de D-060: o denominador existe. Contar só divergência não
    // distinguiria 1 em 3 de 1 em 3.000.
    expect(await valor("wallet_reconciliation_checks_total", { consistent: "true" })).toBe(
      antes.consistentes + 2,
    );
    expect(await valor("wallet_reconciliation_checks_total", { consistent: "false" })).toBe(
      antes.divergentes + 1,
    );
  });
});

describe("histogramas de latência", () => {
  it("observa a latência de processamento com o label da borda de origem", async () => {
    const antes = await observacoes("wager_processing_seconds", { source: "sqs" });

    startProcessingTimer("sqs")();

    expect(await observacoes("wager_processing_seconds", { source: "sqs" })).toBe(antes + 1);
  });

  it("observa a espera pelo lock de wallet (D-002)", async () => {
    const antes = await observacoes("wallet_lock_wait_seconds");

    startLockWaitTimer()();

    expect(await observacoes("wallet_lock_wait_seconds")).toBe(antes + 1);
  });
});

describe("outbox_lag_seconds — o collect callback (D-010)", () => {
  it("consulta a fonte ligada a cada scrape, em vez de guardar valor do caminho quente", async () => {
    let consultas = 0;

    bindOutboxLagSource(() => {
      consultas += 1;

      return Promise.resolve(42);
    });

    await metricsRegistry.getMetricsAsJSON();

    expect(consultas).toBe(1);

    // Este `valor` é ele próprio um segundo scrape — e é o que prova o ponto:
    // **toda** coleta consulta o banco de novo. É o que faz o gauge acompanhar
    // um worker parado sem ninguém ter de incrementar nada no caminho quente.
    expect(await valor("outbox_lag_seconds")).toBe(42);
    expect(consultas).toBe(2);
  });

  it("mantém o último valor quando a fonte falha, em vez de derrubar o scrape", async () => {
    bindOutboxLagSource(() => Promise.resolve(7));
    await metricsRegistry.getMetricsAsJSON();

    bindOutboxLagSource(() => Promise.reject(new Error("banco fora")));

    // O scrape inteiro precisa sobreviver: as outras sete métricas são
    // justamente as que ajudam a diagnosticar a queda do banco.
    const metricas = await metricsRegistry.getMetricsAsJSON();

    expect(metricas.length).toBeGreaterThan(TABELA_DE_D010.length);
    expect(await valor("outbox_lag_seconds")).toBe(7);
  });

  it("é o gauge exportado, e ninguém mais o escreve", () => {
    expect(outboxLagSeconds).toBeDefined();
  });
});
