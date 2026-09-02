/**
 * E-08 — os dois endpoints de escrita contra a aplicação de verdade.
 *
 * A aplicação NestJS sobe inteira numa porta efêmera e é exercitada por `fetch`
 * HTTP real, contra o PostgreSQL real dos containers. **Sem mock em ponto nenhum**
 * (EL-08): o `409` de wallet duplicada vem do `UNIQUE` do schema, o `409` de
 * idempotência vem da transação já gravada, e o `503` vem de uma conexão que
 * realmente falha.
 *
 * O que esta suíte prova, além dos dois endpoints:
 *
 *  - **RF-15 na prática.** O teste unitário de `http-status-map` prova que as
 *    cinco situações têm cinco códigos; aqui se prova que os endpoints
 *    realmente respondem esses códigos, que é a metade que um mapa correto e
 *    mal ligado não teria.
 *  - **RT-05 na borda** (RN-14): mesma key com payload idêntico é replay; com
 *    payload diferente é conflito.
 *  - **EL-03** — o replay não produz um segundo débito no ledger.
 *  - **EL-01 na entrada** — `{"amount": 25.5}` é recusado como forma, antes de
 *    qualquer conversão.
 *  - **RF-23 na abertura** (D-033, D-034): wallet, `OPENING`, lançamento e as
 *    duas linhas de outbox aparecem juntos, ou não aparecem.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { openingIdempotencyKey, INTERNAL_PROVIDER_ID } from "../../src/application/open-wallet.ts";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import { LedgerDirection } from "../../src/domain/ledger-direction.ts";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction.ts";
import { buildClientUrl, readDatabaseEnv } from "../../src/infrastructure/config/database-env.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { outboxMessageRowSchema } from "../../src/infrastructure/persistence/rows/outbox-message-row.ts";
import type { WagerTransactionRow } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import { wagerTransactionRowSchema } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import type { WalletLedgerEntryRow } from "../../src/infrastructure/persistence/rows/wallet-ledger-entry-row.ts";
import { walletLedgerEntryRowSchema } from "../../src/infrastructure/persistence/rows/wallet-ledger-entry-row.ts";
import { AppModule } from "../../src/interface/http/app.module.ts";
import { CORRELATION_HEADER } from "../../src/interface/http/correlation.ts";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/interface/http/dto/parse-submit-transaction-request.ts";
import { httpProblemFor } from "../../src/interface/http/http-status-map.ts";

let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;

/** Sufixo único, para que um teste não falhe pela unicidade que outro exercitou. */
function unico(prefixo: string): string {
  return `${prefixo}-${Bun.randomUUIDv7()}`;
}

/** Resposta HTTP já lida — status, corpo e o header de correlação de D-039. */
interface Resposta {
  status: number;
  corpo: Record<string, unknown>;
  correlationId: string | null;
}

/**
 * Garante que o valor é um objeto JSON antes de indexá-lo.
 *
 * Existe para manter o teste no modo estrito sem `as`: `response.json()` devolve
 * `any`, e passar por aqui converte isso em `Record<string, unknown>` verificado.
 */
function comoObjeto(valor: unknown): Record<string, unknown> {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new Error(`resposta não é objeto JSON: ${JSON.stringify(valor)}`);
  }

  return { ...valor };
}

async function postar(
  caminho: string,
  corpo: unknown,
  headers: Record<string, string> = {},
): Promise<Resposta> {
  return postarBruto(caminho, JSON.stringify(corpo), headers);
}

/** `POST` com corpo já serializado — para exercitar JSON malformado. */
async function postarBruto(
  caminho: string,
  corpo: string,
  headers: Record<string, string> = {},
): Promise<Resposta> {
  const resposta = await fetch(`${baseUrl}${caminho}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: corpo,
  });

  const payload: unknown = await resposta.json();

  return {
    status: resposta.status,
    corpo: comoObjeto(payload),
    correlationId: resposta.headers.get(CORRELATION_HEADER),
  };
}

/** Corpo válido de submissão; cada teste muda um campo por vez. */
function corpoDeAposta(
  walletId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerId: "provider-a",
    externalTransactionId: unico("tx"),
    playerId: unico("player"),
    walletId,
    roundId: unico("round"),
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

function headersDeAposta(key = unico("idem")): Record<string, string> {
  return { [IDEMPOTENCY_KEY_HEADER]: key };
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

/** Leituras num `em` novo: o que se compara é o que o banco guardou. */
async function transacoesDe(walletId: string): Promise<WagerTransactionRow[]> {
  return orm.em.fork().find(wagerTransactionRowSchema, { walletId }, { disableIdentityMap: true });
}

async function lancamentosDe(walletId: string): Promise<WalletLedgerEntryRow[]> {
  return orm.em
    .fork()
    .find(walletLedgerEntryRowSchema, { walletId }, { disableIdentityMap: true });
}

async function eventosDe(aggregateId: string): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .find(outboxMessageRowSchema, { aggregateId }, { disableIdentityMap: true });

  return rows.map((row) => row.eventType);
}

/** Devolve o erro lançado pela ação, para inspecionar seus campos. */
async function capturar(acao: () => Promise<unknown>): Promise<unknown> {
  try {
    await acao();
  } catch (erro: unknown) {
    return erro;
  }

  throw new Error("a ação deveria ter lançado, e não lançou.");
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  // A aplicação sobe com o mesmo módulo de produção — nada é substituído aqui,
  // nem relógio, nem gerador de id, nem repositório.
  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();

  app = modulo.createNestApplication();
  // Porta efêmera e host explícito: `getUrl()` devolveria um endereço IPv6 em
  // algumas máquinas, e nem todo `fetch` o resolve.
  await app.listen(0, "127.0.0.1");
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await orm.close(true);
});

describe("POST /wallets (RF-08, D-033, D-034)", () => {
  it("abre com saldo, version 1 e grava tudo numa transação só", async () => {
    const playerId = unico("player");

    const resposta = await postar("/wallets", {
      playerId,
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });

    expect(resposta.status).toBe(201);
    expect(resposta.corpo["playerId"]).toBe(playerId);
    expect(resposta.corpo["balance"]).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(resposta.corpo["version"]).toBe(1);

    const walletId = resposta.corpo["id"];

    if (typeof walletId !== "string") {
      throw new Error("abertura não devolveu id");
    }

    const transacoes = await transacoesDe(walletId);

    expect(transacoes).toHaveLength(1);
    expect(transacoes[0]?.kind).toBe(WagerTransactionKind.Opening);
    expect(transacoes[0]?.status).toBe(WagerTransactionStatus.Processed);
    expect(transacoes[0]?.amount).toBe("1000.00");

    const lancamentos = await lancamentosDe(walletId);

    expect(lancamentos).toHaveLength(1);
    expect(lancamentos[0]?.direction).toBe(LedgerDirection.Credit);
    expect(lancamentos[0]?.balanceBefore).toBe("0.00");
    expect(lancamentos[0]?.balanceAfter).toBe("1000.00");
  });

  it("usa as sentinelas internas de D-033 nas colunas que a abertura não tem", async () => {
    const walletId = await abrirWallet("50.00");
    const [opening] = await transacoesDe(walletId);

    expect(opening?.providerId).toBe(INTERNAL_PROVIDER_ID);
    // O `walletId` como id externo satisfaz `uq_wager_transactions_provider_external`
    // sem inventar sequência nova, e deixa a `OPENING` consultável por RF-12.
    expect(opening?.externalTransactionId).toBe(walletId);
    expect(opening?.idempotencyKey).toBe(openingIdempotencyKey(walletId));
    expect(opening?.payloadHash).toHaveLength(64);
  });

  it("publica os dois eventos de D-034 na outbox, e nenhum a mais", async () => {
    const walletId = await abrirWallet("75.00");
    const [opening] = await transacoesDe(walletId);

    expect(await eventosDe(opening?.id ?? "")).toEqual(["WagerTransactionProcessed"]);
    expect(await eventosDe(walletId)).toEqual(["WalletBalanceChanged"]);
  });

  it("wallet duplicada para playerId + currency é 409 (D-035)", async () => {
    const playerId = unico("player");
    const corpo = { playerId, initialBalance: { amount: "10.00", currency: "BRL" } };

    expect((await postar("/wallets", corpo)).status).toBe(201);

    const segunda = await postar("/wallets", corpo);

    expect(segunda.status).toBe(409);
    // A taxonomia de D-007 está fechada e nenhum código descreve "wallet já
    // existe" — este 409 responde só mensagem, ao contrário do de idempotência.
    expect(segunda.corpo["failureCode"]).toBeUndefined();
  });

  it("mesmo player em moeda diferente **não** é duplicata", async () => {
    const playerId = unico("player");

    expect(
      (await postar("/wallets", { playerId, initialBalance: { amount: "10.00", currency: "BRL" } }))
        .status,
    ).toBe(201);
    expect(
      (await postar("/wallets", { playerId, initialBalance: { amount: "10.00", currency: "USD" } }))
        .status,
    ).toBe(201);
  });

  it("saldo inicial zero não gera OPENING, lançamento nem evento (RF-08, RF-04)", async () => {
    const walletId = await abrirWallet("0.00");

    expect(await transacoesDe(walletId)).toHaveLength(0);
    expect(await lancamentosDe(walletId)).toHaveLength(0);
    expect(await eventosDe(walletId)).toEqual([]);
  });

  it("saldo inicial malformado é 400 (D-015)", async () => {
    const resposta = await postar("/wallets", {
      playerId: unico("player"),
      initialBalance: { amount: "10", currency: "BRL" },
    });

    expect(resposta.status).toBe(400);
  });
});

describe("POST /wagering/transactions: caminho aplicado (RF-13, RN-01)", () => {
  it("debita, responde 200 com o saldo novo e enfileira os dois eventos", async () => {
    const walletId = await abrirWallet("100.00");

    const resposta = await postar("/wagering/transactions", corpoDeAposta(walletId), headersDeAposta());

    expect(resposta.status).toBe(200);
    expect(resposta.corpo["status"]).toBe(WagerTransactionStatus.Processed);
    expect(resposta.corpo["balance"]).toEqual({ amount: "75.00", currency: "BRL" });
    expect(resposta.corpo["idempotentReplay"]).toBe(false);
    expect(resposta.corpo["failureCode"]).toBeUndefined();

    // Um débito além do crédito de abertura — nunca dois (EL-03).
    const lancamentos = await lancamentosDe(walletId);

    expect(lancamentos.filter((row) => row.direction === LedgerDirection.Debit)).toHaveLength(1);
  });
});

describe("RT-05 — idempotência na borda (RF-14, RN-14)", () => {
  it("payload idêntico sob a mesma key é replay, e não um segundo débito (EL-03)", async () => {
    const walletId = await abrirWallet("100.00");
    const corpo = corpoDeAposta(walletId);
    const headers = headersDeAposta();

    const primeira = await postar("/wagering/transactions", corpo, headers);
    const segunda = await postar("/wagering/transactions", corpo, headers);

    expect(primeira.corpo["idempotentReplay"]).toBe(false);
    expect(segunda.status).toBe(200);
    expect(segunda.corpo["idempotentReplay"]).toBe(true);
    expect(segunda.corpo["transactionId"]).toBe(primeira.corpo["transactionId"]);
    // RN-12: o saldo devolvido é o **observado no desfecho**, o mesmo das duas vezes.
    expect(segunda.corpo["balance"]).toEqual(primeira.corpo["balance"]);

    const debitos = (await lancamentosDe(walletId)).filter(
      (row) => row.direction === LedgerDirection.Debit,
    );

    expect(debitos).toHaveLength(1);
  });

  it("mesma key com payload diferente é 409, não replay", async () => {
    const walletId = await abrirWallet("100.00");
    const headers = headersDeAposta();
    const corpo = corpoDeAposta(walletId);

    expect((await postar("/wagering/transactions", corpo, headers)).status).toBe(200);

    // O **mesmo** corpo, com um único campo mudado: o conflito precisa vir da
    // divergência de payload, não de a segunda requisição ser outra operação.
    const divergente = await postar(
      "/wagering/transactions",
      { ...corpo, money: { amount: "30.00", currency: "BRL" } },
      headers,
    );

    expect(divergente.status).toBe(409);
    expect(divergente.corpo["failureCode"]).toBe(BusinessFailureCode.IdempotencyConflict);
  });
});

describe("as cinco situações de RF-15, agora nos endpoints", () => {
  it("(a) Idempotency-Key ausente é 400 (RF-13)", async () => {
    const walletId = await abrirWallet();

    expect((await postar("/wagering/transactions", corpoDeAposta(walletId))).status).toBe(400);
  });

  it("(a) valor monetário como número JSON é 400, sem conversão (EL-01)", async () => {
    const walletId = await abrirWallet();
    const corpo = corpoDeAposta(walletId, { money: { amount: 25.5, currency: "BRL" } });

    expect((await postar("/wagering/transactions", corpo, headersDeAposta())).status).toBe(400);
  });

  it("(a) `null` em campo de negócio é 400 (D-005)", async () => {
    const walletId = await abrirWallet();
    const corpo = corpoDeAposta(walletId, { roundId: null });

    expect((await postar("/wagering/transactions", corpo, headersDeAposta())).status).toBe(400);
  });

  it("(a) JSON malformado é 400, e não 500", async () => {
    const resposta = await postarBruto(
      "/wagering/transactions",
      "{ isto não é json",
      headersDeAposta(),
    );

    expect(resposta.status).toBe(400);
  });

  it("(c) saldo insuficiente é 422 com o corpo de RF-13 (RN-01)", async () => {
    const walletId = await abrirWallet("10.00");
    const corpo = corpoDeAposta(walletId, { money: { amount: "25.00", currency: "BRL" } });

    const resposta = await postar("/wagering/transactions", corpo, headersDeAposta());

    expect(resposta.status).toBe(422);
    expect(resposta.corpo["failureCode"]).toBe(BusinessFailureCode.InsufficientFunds);
    // A rejeição **é** uma transação persistida (RN-11): o provedor recebe o id
    // para consultá-la, o que a rejeição sem linha (D-031) não tem como oferecer.
    expect(typeof resposta.corpo["transactionId"]).toBe("string");
    expect(resposta.corpo["status"]).toBe(WagerTransactionStatus.Rejected);
    expect(resposta.corpo["balance"]).toEqual({ amount: "10.00", currency: "BRL" });

    // RN-11: rejeição não move saldo nem gera lançamento.
    const debitos = (await lancamentosDe(walletId)).filter(
      (row) => row.direction === LedgerDirection.Debit,
    );

    expect(debitos).toHaveLength(0);
  });

  it("(c) moeda divergente da wallet é 422 (RF-02, RT-04)", async () => {
    const walletId = await abrirWallet("100.00");
    const corpo = corpoDeAposta(walletId, { money: { amount: "25.00", currency: "USD" } });

    const resposta = await postar("/wagering/transactions", corpo, headersDeAposta());

    expect(resposta.status).toBe(422);
    expect(resposta.corpo["failureCode"]).toBe(BusinessFailureCode.CurrencyMismatch);
  });

  it("(c) wallet inexistente é 422 sem gravar linha (D-031)", async () => {
    const inexistente = Bun.randomUUIDv7();
    const corpo = corpoDeAposta(inexistente);

    const resposta = await postar("/wagering/transactions", corpo, headersDeAposta());

    expect(resposta.status).toBe(422);
    expect(resposta.corpo["failureCode"]).toBe(BusinessFailureCode.WalletNotFound);
    expect(resposta.corpo["transactionId"]).toBeUndefined();
    expect(await transacoesDe(inexistente)).toHaveLength(0);
  });

  it("(c) OPENING submetido de fora é 422 com KIND_NOT_SUBMITTABLE (RN-13)", async () => {
    const walletId = await abrirWallet();
    const corpo = corpoDeAposta(walletId, { kind: "OPENING" });

    const resposta = await postar("/wagering/transactions", corpo, headersDeAposta());

    expect(resposta.status).toBe(422);
    expect(resposta.corpo["failureCode"]).toBe(BusinessFailureCode.KindNotSubmittable);
  });

  it("(e) indisponibilidade real do PostgreSQL é classificada como 503 (D-037)", async () => {
    // Sem mock: um MikroORM apontado para uma porta onde ninguém escuta produz o
    // erro de conexão de verdade, com o `code` que o driver propaga. O que se
    // testa é a classificação desse erro real — o `503` que o filtro responderia.
    const urlMorta = buildClientUrl({ ...readDatabaseEnv(), port: 1 });

    const configMorta = buildOrmConfig();
    configMorta.clientUrl = urlMorta;

    const erro = await capturar(async () => {
      const morto = await MikroORM.init(configMorta);

      try {
        await morto.em.getConnection().execute("select 1");
      } finally {
        await morto.close(true);
      }
    });

    expect(httpProblemFor(erro).status).toBe(503);
  });
});

describe("limite de etapa e correlação", () => {
  it("kind ainda não processado é 501, não 500 (E-12 o remove)", async () => {
    const walletId = await abrirWallet("100.00");
    const corpo = corpoDeAposta(walletId, { kind: "WIN" });

    expect((await postar("/wagering/transactions", corpo, headersDeAposta())).status).toBe(501);
  });

  it("ecoa o X-Correlation-Id do provedor quando ele manda (D-039)", async () => {
    const walletId = await abrirWallet("100.00");
    const correlacao = "provider-a:trace-42";

    const resposta = await postar("/wagering/transactions", corpoDeAposta(walletId), {
      ...headersDeAposta(),
      [CORRELATION_HEADER]: correlacao,
    });

    expect(resposta.correlationId).toBe(correlacao);
  });

  it("gera correlação quando o provedor não manda, e ecoa também no erro", async () => {
    const semCorrelacao = await postar("/wagering/transactions", { nada: true }, headersDeAposta());

    expect(semCorrelacao.status).toBe(400);
    expect(semCorrelacao.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ignora correlação malformada em vez de derrubar a operação (D-039)", async () => {
    const walletId = await abrirWallet("100.00");

    const resposta = await postar("/wagering/transactions", corpoDeAposta(walletId), {
      ...headersDeAposta(),
      [CORRELATION_HEADER]: "trace com espaço",
    });

    expect(resposta.status).toBe(200);
    expect(resposta.correlationId).not.toBe("trace com espaço");
  });
});
