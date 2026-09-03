/**
 * E-15 — observabilidade contra a infraestrutura real (RF-17, RNF-06, RNF-07).
 *
 * A aplicação sobe inteira numa porta efêmera, contra o PostgreSQL e o SQS dos
 * containers. **Sem mock em ponto nenhum** (EL-08): `GET /health/ready` responde
 * `200` porque o `select 1` e o `ListQueues` de verdade funcionaram, e as
 * métricas se movem porque uma aposta de verdade atravessou o sistema.
 *
 * O que esta suíte prova, além dos três itens do roteiro:
 *
 *  - **os oito nomes de D-010 aparecem no `/metrics` exposto**, e não apenas no
 *    registro em memória — que é o que o teste unitário já cobria;
 *  - **`outbox_lag_seconds` reflete o banco**: a submissão deixa linha pendente
 *    na outbox (nenhum worker roda aqui), e o gauge sai de zero por causa dela;
 *  - **`wallet_lock_wait_seconds` foi observado**, o que só acontece se o
 *    caminho do dinheiro passou pelo `FOR UPDATE` de D-002;
 *  - **a reconciliação de RF-16 é contabilizada** com o nome de D-060.
 *
 * O registro de métricas é singleton de processo (D-062), então tudo é medido de
 * forma **relativa**: lê antes, age, lê depois.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { AppModule } from "../../src/interface/http/app.module.ts";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/interface/http/dto/parse-submit-transaction-request.ts";

let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;

/** Sufixo único, para que um teste não falhe pela unicidade que outro exercitou. */
function unico(prefixo: string): string {
  return `${prefixo}-${Bun.randomUUIDv7()}`;
}

/** Garante que o valor é um objeto JSON antes de indexá-lo, sem `as`. */
function comoObjeto(valor: unknown): Record<string, unknown> {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new Error(`resposta não é objeto JSON: ${JSON.stringify(valor)}`);
  }

  return { ...valor };
}

async function obterJson(caminho: string): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const resposta = await fetch(`${baseUrl}${caminho}`);
  const payload: unknown = await resposta.json();

  return { status: resposta.status, corpo: comoObjeto(payload) };
}

async function postar(
  caminho: string,
  corpo: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const resposta = await fetch(`${baseUrl}${caminho}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(corpo),
  });

  const payload: unknown = await resposta.json();

  return { status: resposta.status, corpo: comoObjeto(payload) };
}

/** O texto do `/metrics`, como um scraper o veria. */
async function raspar(): Promise<string> {
  const resposta = await fetch(`${baseUrl}/metrics`);

  return resposta.text();
}

/**
 * Lê uma série do texto exposto pelo Prometheus.
 *
 * Aqui o teste **lê o texto de propósito**, ao contrário do unitário: o que se
 * prova nesta suíte é que o valor chega ao scraper, e não que o registro em
 * memória tem o número certo.
 */
function serie(texto: string, linhaProcurada: string): number {
  const linha = texto
    .split("\n")
    .find((candidata) => candidata.startsWith(linhaProcurada) && !candidata.startsWith("#"));

  if (linha === undefined) {
    return 0;
  }

  const valor = linha.slice(linha.lastIndexOf(" ") + 1);

  return Number.parseFloat(valor);
}

/** Abre uma wallet pelo endpoint e devolve o id. */
async function abrirWallet(amount = "100.00"): Promise<string> {
  const resposta = await postar("/wallets", {
    playerId: unico("player"),
    initialBalance: { amount, currency: "BRL" },
  });

  expect(resposta.status).toBe(201);

  const id = resposta.corpo["id"];

  if (typeof id !== "string") {
    throw new Error(`abertura não devolveu id: ${JSON.stringify(resposta.corpo)}`);
  }

  return id;
}

/** Submete uma aposta válida pela borda HTTP. */
async function apostar(walletId: string, amount = "25.00"): Promise<Record<string, unknown>> {
  const resposta = await postar(
    "/wagering/transactions",
    {
      providerId: "provider-a",
      externalTransactionId: unico("tx"),
      playerId: unico("player"),
      walletId,
      roundId: unico("round"),
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount, currency: "BRL" },
    },
    { [IDEMPOTENCY_KEY_HEADER]: unico("idem") },
  );

  expect(resposta.status).toBe(200);

  return resposta.corpo;
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  // O módulo de produção, sem nada substituído — inclusive o logger, que aqui
  // escreve no stdout do teste como escreveria no do container.
  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();

  app = modulo.createNestApplication();
  await app.listen(0, "127.0.0.1");
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await orm.close(true);
});

describe("GET /health/live e /health/ready (RF-17)", () => {
  it("liveness responde 200 sem tocar dependência nenhuma", async () => {
    const resposta = await obterJson("/health/live");

    expect(resposta.status).toBe(200);
    expect(resposta.corpo).toEqual({ status: "live" });
  });

  it("readiness responde 200 com PostgreSQL e SQS alcançáveis", async () => {
    const resposta = await obterJson("/health/ready");

    expect(resposta.status).toBe(200);
    // As duas dependências que RF-17 nomeia, verificadas por chamada real — o
    // `select 1` porque `isConnected()` é preguiçoso (D-001), e o `ListQueues`
    // porque alcance é o que o requisito pede.
    expect(resposta.corpo).toEqual({
      status: "ready",
      checks: { postgres: true, sqs: true },
    });
  });

  it("são rotas separadas: readiness diz por dependência, liveness não opina", async () => {
    const vivo = await obterJson("/health/live");
    const pronto = await obterJson("/health/ready");

    expect(vivo.corpo["checks"]).toBeUndefined();
    expect(Object.keys(comoObjeto(pronto.corpo["checks"]))).toEqual(["postgres", "sqs"]);
  });

  it("responde sem autenticação (RF-17, D-012)", async () => {
    // Nenhum header de credencial é enviado em nenhuma requisição desta suíte, e
    // é isso que este teste afirma explicitamente para quem for implementar auth
    // depois: estas rotas e `/metrics` precisam continuar abertas.
    const resposta = await fetch(`${baseUrl}/health/live`);

    expect(resposta.status).toBe(200);
  });
});

describe("GET /metrics (RNF-07, D-010)", () => {
  it("expõe no formato Prometheus, com o content-type do registro", async () => {
    const resposta = await fetch(`${baseUrl}/metrics`);

    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toContain("text/plain");
  });

  it("expõe os oito nomes da tabela de D-010", async () => {
    const texto = await raspar();

    for (const nome of [
      "wager_transactions_total",
      "wager_duplicates_total",
      "wager_retries_total",
      "wager_dlq_messages_total",
      "wallet_lock_wait_seconds",
      "outbox_lag_seconds",
      "wager_processing_seconds",
      "wallet_reconciliation_checks_total",
    ]) {
      expect(texto).toContain(`# TYPE ${nome}`);
    }
  });
});

describe("as métricas se movem com o tráfego real (RNF-07, D-062)", () => {
  it("conta a transação por status e kind depois de uma aposta de verdade", async () => {
    const antes = serie(await raspar(), 'wager_transactions_total{status="PROCESSED",kind="BET"}');

    const walletId = await abrirWallet();
    await apostar(walletId);

    const depois = serie(await raspar(), 'wager_transactions_total{status="PROCESSED",kind="BET"}');

    expect(depois).toBe(antes + 1);
  });

  it("conta o replay idempotente de RF-14 como duplicata", async () => {
    const walletId = await abrirWallet();
    const chave = unico("idem");
    const corpo = {
      providerId: "provider-a",
      externalTransactionId: unico("tx"),
      playerId: unico("player"),
      walletId,
      roundId: unico("round"),
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    };

    await postar("/wagering/transactions", corpo, { [IDEMPOTENCY_KEY_HEADER]: chave });

    const antes = serie(await raspar(), 'wager_duplicates_total{source="http"}');

    // A **mesma** key com o **mesmo** payload: replay, não processamento novo.
    const replay = await postar("/wagering/transactions", corpo, {
      [IDEMPOTENCY_KEY_HEADER]: chave,
    });

    expect(replay.corpo["idempotentReplay"]).toBe(true);
    expect(serie(await raspar(), 'wager_duplicates_total{source="http"}')).toBe(antes + 1);
  });

  it("observa a espera pelo lock da wallet — prova de que o caminho passou pelo FOR UPDATE", async () => {
    const antes = serie(await raspar(), 'wallet_lock_wait_seconds_bucket{le="+Inf"}');

    const walletId = await abrirWallet();
    await apostar(walletId);

    // Cada submissão adquire o lock uma vez (RI-06: ponto único de aquisição).
    expect(serie(await raspar(), 'wallet_lock_wait_seconds_bucket{le="+Inf"}')).toBeGreaterThan(
      antes,
    );
  });

  it("observa a latência de processamento com source=http", async () => {
    const antes = serie(await raspar(), 'wager_processing_seconds_bucket{le="+Inf",source="http"}');

    const walletId = await abrirWallet();
    await apostar(walletId);

    expect(
      serie(await raspar(), 'wager_processing_seconds_bucket{le="+Inf",source="http"}'),
    ).toBe(antes + 1);
  });
});

describe("reconciliação contabilizada (RF-16, D-060)", () => {
  it("conta a verificação consistente — o denominador que D-060 exige", async () => {
    const walletId = await abrirWallet();
    await apostar(walletId);

    const antes = serie(await raspar(), 'wallet_reconciliation_checks_total{consistent="true"}');

    const resposta = await postar(`/wallets/${walletId}/reconciliation`, {});

    expect(resposta.status).toBe(200);
    expect(resposta.corpo["consistent"]).toBe(true);
    expect(serie(await raspar(), 'wallet_reconciliation_checks_total{consistent="true"}')).toBe(
      antes + 1,
    );
  });
});

describe("outbox_lag_seconds reflete o banco (D-010)", () => {
  it("sobe com uma linha pendente na outbox e volta a zero quando não há nenhuma", async () => {
    // Nenhum worker roda nesta suíte — o `AppModule` é HTTP puro (D-063) —,
    // então tudo que a abertura e a aposta gravam na outbox fica pendente. É o
    // cenário que o gauge existe para denunciar: worker parado, evento preso.
    const walletId = await abrirWallet();
    await apostar(walletId);

    expect(serie(await raspar(), "outbox_lag_seconds")).toBeGreaterThan(0);

    // Publicar não é escopo daqui: marcar as linhas como publicadas prova que o
    // gauge lê o **banco** a cada scrape, e não um contador acumulado em memória.
    await orm.em
      .fork()
      .getConnection()
      .execute(`update "outbox_messages" set "published_at" = now() where "published_at" is null`);

    expect(serie(await raspar(), "outbox_lag_seconds")).toBe(0);
  });
});
