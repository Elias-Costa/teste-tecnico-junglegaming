/**
 * E-14 — as quatro consultas e a reconciliação contra a aplicação de verdade.
 *
 * A aplicação NestJS sobe inteira numa porta efêmera e é exercitada por `fetch`
 * HTTP real, contra o PostgreSQL real dos containers. **Sem mock em ponto nenhum**
 * (EL-08): o ledger paginado vem do índice `(wallet_id, id)` de E-05, a
 * reconciliação soma linhas que as apostas realmente gravaram, e a divergência
 * é produzida por um `UPDATE` direto na coluna de saldo — o único jeito honesto
 * de provar que o endpoint **acusa** em vez de corrigir.
 *
 * O que esta suíte prova, além dos endpoints:
 *
 *  - **RF-10 de fato pagina.** Atravessar as páginas por cursor devolve cada
 *    lançamento exatamente uma vez, em ordem — que é a única coisa que um
 *    cursor errado ainda faria parecer certo num teste de uma página só.
 *  - **D-056 na prática:** `404` sem `failureCode` para ausência, `400` para id
 *    malformado, e `422` **continua** sendo a resposta da submissão (D-031).
 *  - **RF-16 nunca corrige.** Depois de acusar divergência, o saldo e o ledger
 *    continuam exatamente como estavam.
 *  - **EL-07** por consequência: não existe caminho de escrita no ledger nestes
 *    endpoints, e a reconciliação prova que ele continua reconstruindo o saldo.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ReconcileWallet, type ReconciliationReport } from "../../src/application/reconcile-wallet.ts";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import { LedgerDirection } from "../../src/domain/ledger-direction.ts";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction.ts";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { walletRowSchema } from "../../src/infrastructure/persistence/rows/wallet-row.ts";
import { AppModule } from "../../src/interface/http/app.module.ts";
import { CORRELATION_HEADER } from "../../src/interface/http/correlation.ts";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/interface/http/dto/parse-submit-transaction-request.ts";
import { expectLedgerReconciles } from "../support/concurrency-harness.ts";

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

/** Garante que o valor é um objeto JSON antes de indexá-lo, sem `as`. */
function comoObjeto(valor: unknown): Record<string, unknown> {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new Error(`resposta não é objeto JSON: ${JSON.stringify(valor)}`);
  }

  return { ...valor };
}

/** Garante que o valor é uma lista de objetos JSON — a `entries` da página. */
function comoLista(valor: unknown): Record<string, unknown>[] {
  if (!Array.isArray(valor)) {
    throw new Error(`esperava lista, veio ${JSON.stringify(valor)}`);
  }

  return valor.map(comoObjeto);
}

/** Lê um campo obrigatoriamente textual do corpo, sem `as`. */
function texto(corpo: Record<string, unknown>, campo: string): string {
  const valor = corpo[campo];

  if (typeof valor !== "string") {
    throw new Error(`campo ${campo} não é texto em ${JSON.stringify(corpo)}`);
  }

  return valor;
}

async function requisitar(
  metodo: string,
  caminho: string,
  corpo?: unknown,
  headers: Record<string, string> = {},
): Promise<Resposta> {
  const resposta = await fetch(`${baseUrl}${caminho}`, {
    method: metodo,
    headers: { "content-type": "application/json", ...headers },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });

  const payload: unknown = await resposta.json();

  return {
    status: resposta.status,
    corpo: comoObjeto(payload),
    correlationId: resposta.headers.get(CORRELATION_HEADER),
  };
}

async function obter(caminho: string, headers: Record<string, string> = {}): Promise<Resposta> {
  return requisitar("GET", caminho, undefined, headers);
}

async function postar(
  caminho: string,
  corpo?: unknown,
  headers: Record<string, string> = {},
): Promise<Resposta> {
  return requisitar("POST", caminho, corpo, headers);
}

/** Abre uma wallet pelo endpoint e devolve o id. */
async function abrirWallet(amount = "100.00"): Promise<string> {
  const resposta = await postar("/wallets", {
    playerId: unico("player"),
    initialBalance: { amount, currency: "BRL" },
  });

  expect(resposta.status).toBe(201);

  return texto(resposta.corpo, "id");
}

/** Submete uma operação e devolve a resposta inteira — inclusive quando é rejeição. */
async function submeter(
  walletId: string,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Resposta> {
  const externalTransactionId = unico("tx");

  return postar(
    "/wagering/transactions",
    {
      providerId: "provider-a",
      externalTransactionId,
      playerId: unico("player"),
      walletId,
      roundId: unico("round"),
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: { amount: "1.00", currency: "BRL" },
      ...overrides,
    },
    { [IDEMPOTENCY_KEY_HEADER]: unico("idem"), ...headers },
  );
}

/** Um UUID que não corresponde a linha nenhuma — a forma é válida, o recurso não existe. */
function idInexistente(): string {
  return Bun.randomUUIDv7();
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  // A aplicação sobe com o mesmo módulo de produção — nada é substituído aqui.
  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();

  app = modulo.createNestApplication();
  await app.listen(0, "127.0.0.1");
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await orm.close(true);
});

describe("GET /wallets/:walletId (RF-09, D-059)", () => {
  it("devolve o estado corrente na mesma forma da abertura", async () => {
    const walletId = await abrirWallet("100.00");

    expect((await submeter(walletId)).status).toBe(200);

    const resposta = await obter(`/wallets/${walletId}`);

    expect(resposta.status).toBe(200);
    // A forma é contrato (D-059): uma forma por recurso, nos dois verbos.
    expect(Object.keys(resposta.corpo).sort()).toEqual(["balance", "id", "playerId", "version"]);
    expect(resposta.corpo["balance"]).toEqual({ amount: "99.00", currency: "BRL" });
    // `version` 2: nasceu em 1 e o débito da aposta foi a única mudança de saldo.
    expect(resposta.corpo["version"]).toBe(2);
  });

  it("wallet inexistente é 404 **sem** failureCode (D-056)", async () => {
    const resposta = await obter(`/wallets/${idInexistente()}`);

    expect(resposta.status).toBe(404);
    // Nenhuma regra de negócio foi avaliada: nenhum dos 13 códigos de D-007
    // descreve o que aconteceu. É a diferença entre esta resposta e o `422` da
    // submissão contra wallet inexistente (D-031).
    expect(resposta.corpo["failureCode"]).toBeUndefined();
  });

  it("id malformado na rota é 400, não 404 nem 500", async () => {
    // Sem a guarda da borda, a string chegaria à coluna `uuid` e o `22P02` —
    // que D-037 não mapeia — viraria `500` para o que é payload inválido.
    const resposta = await obter("/wallets/nao-e-uuid");

    expect(resposta.status).toBe(400);
  });

  it("ecoa a correlação também na leitura", async () => {
    const correlationId = unico("corr");
    const resposta = await obter(`/wallets/${idInexistente()}`, {
      [CORRELATION_HEADER]: correlationId,
    });

    // Inclusive no erro: é justamente quando o provedor vai investigar.
    expect(resposta.status).toBe(404);
    expect(resposta.correlationId).toBe(correlationId);
  });
});

describe("GET /wallets/:walletId/ledger (RF-10, D-014)", () => {
  it("atravessa as páginas pelo cursor sem repetir nem pular lançamento", async () => {
    const walletId = await abrirWallet("100.00");

    for (let i = 0; i < 5; i += 1) {
      expect((await submeter(walletId)).status).toBe(200);
    }

    // 6 lançamentos: o `CREDIT` de abertura (RF-08) mais os 5 débitos.
    const completa = await obter(`/wallets/${walletId}/ledger`);
    const todos = comoLista(completa.corpo["entries"]).map((entry) => texto(entry, "id"));

    expect(todos).toHaveLength(6);
    expect(completa.corpo["nextCursor"]).toBeNull();

    // Agora o mesmo conteúdo em páginas de 2. Um cursor errado ainda passaria
    // num teste de página única; é a travessia que o denuncia.
    const paginados: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;

    do {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const pagina: Resposta = await obter(`/wallets/${walletId}/ledger${query}`);

      expect(pagina.status).toBe(200);

      const entries = comoLista(pagina.corpo["entries"]);

      expect(entries.length).toBeLessThanOrEqual(2);
      paginados.push(...entries.map((entry) => texto(entry, "id")));

      const proximo = pagina.corpo["nextCursor"];

      cursor = typeof proximo === "string" ? proximo : null;
      paginas += 1;
    } while (cursor !== null);

    expect(paginas).toBe(3);
    expect(paginados).toEqual(todos);
    // Ordem total e determinística: é o que D-014 comprou com o UUIDv7.
    expect([...paginados].sort()).toEqual(paginados);
    expect(new Set(paginados).size).toBe(6);
  });

  it("cada lançamento sai na forma de D-059, com dinheiro como objeto", async () => {
    const walletId = await abrirWallet("10.00");
    const pagina = await obter(`/wallets/${walletId}/ledger`);
    const [entry] = comoLista(pagina.corpo["entries"]);

    if (entry === undefined) {
      throw new Error("a abertura deveria ter gravado o lançamento de `OPENING`");
    }

    expect(Object.keys(entry).sort()).toEqual([
      "balanceAfter",
      "balanceBefore",
      "createdAt",
      "direction",
      "id",
      "money",
      "transactionId",
    ]);
    expect(entry["direction"]).toBe(LedgerDirection.Credit);
    // Nunca número (EL-01) — nem no valor, nem nos dois saldos.
    expect(entry["money"]).toEqual({ amount: "10.00", currency: "BRL" });
    expect(entry["balanceBefore"]).toEqual({ amount: "0.00", currency: "BRL" });
    expect(entry["balanceAfter"]).toEqual({ amount: "10.00", currency: "BRL" });
  });

  it("o cursor é opaco: não repete o id em claro", async () => {
    const walletId = await abrirWallet("10.00");

    expect((await submeter(walletId)).status).toBe(200);

    const pagina = await obter(`/wallets/${walletId}/ledger?limit=1`);
    const [entry] = comoLista(pagina.corpo["entries"]);
    const cursor = texto(pagina.corpo, "nextCursor");

    expect(entry).toBeDefined();
    expect(cursor).not.toContain(entry === undefined ? "" : texto(entry, "id"));
  });

  it("cursor corrompido e limit fora do intervalo são 400", async () => {
    const walletId = await abrirWallet("10.00");

    expect((await obter(`/wallets/${walletId}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await obter(`/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await obter(`/wallets/${walletId}/ledger?limit=201`)).status).toBe(400);
  });

  it("ledger de wallet inexistente é 404, não página vazia", async () => {
    // Página vazia seria indistinguível de uma wallet real sem lançamentos.
    expect((await obter(`/wallets/${idInexistente()}/ledger`)).status).toBe(404);
  });
});

describe("GET /wagering/transactions/:transactionId (RF-11, D-059)", () => {
  it("devolve identidade, desfecho e auditoria — e **não** o payloadHash", async () => {
    const walletId = await abrirWallet("100.00");
    const correlationId = unico("corr");
    const submissao = await submeter(walletId, {}, { [CORRELATION_HEADER]: correlationId });

    expect(submissao.status).toBe(200);

    const transactionId = texto(submissao.corpo, "transactionId");
    const resposta = await obter(`/wagering/transactions/${transactionId}`);

    expect(resposta.status).toBe(200);
    expect(resposta.corpo["id"]).toBe(transactionId);
    expect(resposta.corpo["status"]).toBe(WagerTransactionStatus.Processed);
    expect(resposta.corpo["kind"]).toBe(WagerTransactionKind.Bet);
    expect(resposta.corpo["money"]).toEqual({ amount: "1.00", currency: "BRL" });
    expect(resposta.corpo["observedBalance"]).toEqual({ amount: "99.00", currency: "BRL" });

    // Auditoria: o que fecha um atendimento sem acesso ao banco (D-059).
    expect(resposta.corpo["idempotencyKey"]).toBeString();
    expect(resposta.corpo["correlationId"]).toBe(correlationId);

    // Mecanismo interno de D-005 — não atravessa a fronteira.
    expect(resposta.corpo["payloadHash"]).toBeUndefined();

    // Campo ausente é **omitido**, não `null`: o cliente testa presença.
    expect("failureCode" in resposta.corpo).toBe(false);
    expect("referenceExternalTransactionId" in resposta.corpo).toBe(false);
  });

  it("transação rejeitada é 200 com o failureCode no corpo, não 422", async () => {
    const walletId = await abrirWallet("10.00");
    const rejeicao = await submeter(walletId, { money: { amount: "50.00", currency: "BRL" } });

    expect(rejeicao.status).toBe(422);

    const transactionId = texto(rejeicao.corpo, "transactionId");
    const consulta = await obter(`/wagering/transactions/${transactionId}`);

    // A consulta não decide nada de negócio: repetir o `422` faria parecer que
    // ela está produzindo a rejeição de novo.
    expect(consulta.status).toBe(200);
    expect(consulta.corpo["status"]).toBe(WagerTransactionStatus.Rejected);
    expect(consulta.corpo["failureCode"]).toBe(BusinessFailureCode.InsufficientFunds);
  });

  it("transação inexistente é 404 e id malformado é 400", async () => {
    expect((await obter(`/wagering/transactions/${idInexistente()}`)).status).toBe(404);
    expect((await obter("/wagering/transactions/nao-e-uuid")).status).toBe(400);
  });
});

describe("GET /providers/:providerId/wagering/transactions/:externalTransactionId (RF-12)", () => {
  it("encontra pela identidade do provedor", async () => {
    const walletId = await abrirWallet("100.00");
    const externalTransactionId = unico("tx");
    const submissao = await submeter(walletId, { externalTransactionId });

    expect(submissao.status).toBe(200);

    const resposta = await obter(
      `/providers/provider-a/wagering/transactions/${externalTransactionId}`,
    );

    expect(resposta.status).toBe(200);
    expect(resposta.corpo["id"]).toBe(texto(submissao.corpo, "transactionId"));
    expect(resposta.corpo["externalTransactionId"]).toBe(externalTransactionId);
  });

  it("o mesmo externalTransactionId sob outro provedor é 404, não 403", async () => {
    // O par **é** a identidade, e não há autorização a violar (D-012).
    const walletId = await abrirWallet("100.00");
    const externalTransactionId = unico("tx");

    expect((await submeter(walletId, { externalTransactionId })).status).toBe(200);
    expect(
      (await obter(`/providers/provider-b/wagering/transactions/${externalTransactionId}`)).status,
    ).toBe(404);
  });

  it("`internal` devolve a OPENING da abertura de wallet (D-033)", async () => {
    // Auditoria legítima da transação interna: o `externalTransactionId` da
    // `OPENING` é o próprio `walletId`.
    const walletId = await abrirWallet("42.00");
    const resposta = await obter(`/providers/internal/wagering/transactions/${walletId}`);

    expect(resposta.status).toBe(200);
    expect(resposta.corpo["kind"]).toBe(WagerTransactionKind.Opening);
    expect(resposta.corpo["status"]).toBe(WagerTransactionStatus.Processed);
    expect(resposta.corpo["money"]).toEqual({ amount: "42.00", currency: "BRL" });
  });
});

describe("POST /wallets/:walletId/reconciliation (RF-16, §6.4)", () => {
  it("reconstrói o saldo pelo ledger e confirma consistência", async () => {
    const walletId = await abrirWallet("100.00");

    for (let i = 0; i < 3; i += 1) {
      expect((await submeter(walletId)).status).toBe(200);
    }

    const resposta = await postar(`/wallets/${walletId}/reconciliation`);

    expect(resposta.status).toBe(200);
    expect(resposta.corpo).toEqual({
      walletId,
      storedBalance: { amount: "97.00", currency: "BRL" },
      calculatedBalance: { amount: "97.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      // A `OPENING` mais os três débitos.
      checkedEntries: 4,
    });

    await expectLedgerReconciles(orm, walletId);
  });

  it("acusa divergência e **não corrige**", async () => {
    const walletId = await abrirWallet("100.00");

    expect((await submeter(walletId)).status).toBe(200);

    // A divergência é produzida por fora do domínio, que é o único jeito de
    // produzi-la: nenhum caminho da aplicação move saldo sem gravar lançamento.
    await orm.em.fork().nativeUpdate(walletRowSchema, { id: walletId }, { balance: "150.00" });

    const resposta = await postar(`/wallets/${walletId}/reconciliation`);

    expect(resposta.status).toBe(200);
    expect(resposta.corpo["consistent"]).toBe(false);
    expect(resposta.corpo["storedBalance"]).toEqual({ amount: "150.00", currency: "BRL" });
    expect(resposta.corpo["calculatedBalance"]).toEqual({ amount: "99.00", currency: "BRL" });
    // `stored − calculated`: quanto o saldo tem a mais do que o ledger justifica.
    expect(resposta.corpo["difference"]).toEqual({ amount: "51.00", currency: "BRL" });

    // **O ponto do requisito.** Reconciliar de novo tem de acusar a mesma coisa:
    // se a primeira chamada tivesse "consertado" o saldo, esta viria consistente
    // e a evidência da violação teria sido apagada.
    const segunda = await postar(`/wallets/${walletId}/reconciliation`);

    expect(segunda.corpo).toEqual(resposta.corpo);
    expect((await obter(`/wallets/${walletId}`)).corpo["balance"]).toEqual({
      amount: "150.00",
      currency: "BRL",
    });
    // E o ledger continua com os dois lançamentos originais, intocado.
    expect(comoLista((await obter(`/wallets/${walletId}/ledger`)).corpo["entries"])).toHaveLength(2);
  });

  it("avisa o observador de divergência — o gancho onde E-15 liga log e métrica", async () => {
    const walletId = await abrirWallet("20.00");

    await orm.em.fork().nativeUpdate(walletRowSchema, { id: walletId }, { balance: "30.00" });

    const avisos: ReconciliationReport[] = [];
    const useCase = new ReconcileWallet(new MikroUnitOfWork(orm.em), (report) => {
      avisos.push(report);
    });

    const relatorio = await useCase.execute(walletId);

    expect(relatorio.consistent).toBe(false);
    expect(avisos).toEqual([relatorio]);

    // Consistente não avisa: o gancho existe para a divergência, e um aviso por
    // verificação bem-sucedida afogaria o sinal que RF-16 quer que chegue.
    const saudavel = await abrirWallet("20.00");

    await useCase.execute(saudavel);
    expect(avisos).toHaveLength(1);
  });

  it("wallet inexistente é 404 e id malformado é 400", async () => {
    expect((await postar(`/wallets/${idInexistente()}/reconciliation`)).status).toBe(404);
    expect((await postar("/wallets/nao-e-uuid/reconciliation")).status).toBe(400);
  });
});
