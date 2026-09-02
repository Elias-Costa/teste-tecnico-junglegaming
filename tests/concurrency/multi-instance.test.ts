/**
 * E-09 — três instâncias da aplicação ao mesmo tempo: RT-17.
 *
 * **A prova de EL-05**, que é a eliminatória "solução correta somente com uma
 * instância". Nenhum dos outros testes de concorrência a fecha: todos rodam num
 * processo só, e uma solução que guardasse a idempotência num `Map` de módulo, ou
 * que serializasse por mutex em memória, passaria em todos eles.
 *
 * Aqui há **três processos de sistema operacional independentes**, cada um com o
 * `AppModule` de produção inteiro (`tests/support/app-instance.ts`), servindo HTTP
 * em portas próprias contra **um** PostgreSQL. Não há memória compartilhada entre
 * eles — nem pode haver. O que sobra para coordenar o dinheiro é o banco, que é
 * exatamente o que RI-03, RI-08 e D-002 dizem.
 *
 * O cenário é de escassez, para que a disputa seja real: `100.00` de saldo e
 * **30 apostas de `20.00` disparadas de uma vez**, dez por instância. Cabem
 * cinco. As outras 25 têm de ser rejeitadas por saldo — não podem virar saldo
 * negativo (EL-02) nem lançamento a mais (EL-03).
 *
 * A sincronização entre os processos é por **handshake**, não por relógio: o pai
 * só dispara depois que as três instâncias anunciaram estar servindo. `sleep`
 * daria um teste que passa numa máquina rápida e falha numa lenta.
 *
 * Sem mock em ponto nenhum (EL-08), e sem substituição: as instâncias sobem o
 * mesmo módulo que o `main` de E-14 vai subir.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/interface/http/dto/parse-submit-transaction-request.ts";
import {
  comPrazo,
  debitosDe,
  expectLedgerReconciles,
  lerLinha,
  MOEDA,
  saldoDe,
  transacoesDe,
  unico,
  versaoDe,
} from "../support/concurrency-harness.ts";

/** O mínimo que RT-17 exige. Três processos, não três promessas. */
const INSTANCIAS = 3;

/** Apostas por instância. 3 × 10 = 30 submissões simultâneas. */
const APOSTAS_POR_INSTANCIA = 10;

/** Saldo inicial e valor da aposta: cabem exatamente cinco das trinta. */
const SALDO_INICIAL = "100.00";
const VALOR_DA_APOSTA = "20.00";
const APOSTAS_QUE_CABEM = 5;

/** Prazo para uma instância anunciar que está servindo. */
const PRAZO_DE_BOOT_MS = 60_000;

let orm: MikroORM;

/** Uma instância viva: o processo e a URL onde ela atende. */
interface Instancia {
  processo: Bun.Subprocess<"pipe", "pipe", "inherit">;
  baseUrl: string;
}

const instancias: Instancia[] = [];

/**
 * Sobe uma instância da aplicação em processo próprio.
 *
 * O ambiente é herdado inteiro: é assim que a conexão de D-011 atravessa, e é o
 * que faz o filho não saber se quem provisionou o banco foi o Compose ou o
 * Testcontainers. `stderr` herdado deixa uma falha de boot visível na saída do
 * teste em vez de sumir num pipe que ninguém lê.
 */
async function subirInstancia(): Promise<Instancia> {
  const processo = Bun.spawn({
    // `process.execPath` é o próprio Bun que está rodando a suíte — não depende
    // de `bun` estar no PATH do shell que invocou o teste.
    cmd: [process.execPath, `${import.meta.dir}/../support/app-instance.ts`],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env },
  });

  const anuncio = await comPrazo(
    lerLinha(processo.stdout),
    PRAZO_DE_BOOT_MS,
    "o anúncio de uma instância",
  );

  const payload: unknown = JSON.parse(anuncio);

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("baseUrl" in payload) ||
    typeof payload.baseUrl !== "string"
  ) {
    throw new Error(`anúncio inesperado da instância: ${anuncio}`);
  }

  return { processo, baseUrl: payload.baseUrl };
}

/** Resposta HTTP já lida, com a instância que a respondeu. */
interface Resposta {
  instancia: number;
  status: number;
  corpo: Record<string, unknown>;
}

async function postar(
  instancia: number,
  caminho: string,
  corpo: unknown,
  headers: Record<string, string> = {},
): Promise<Resposta> {
  const alvo = instancias[instancia];

  if (alvo === undefined) {
    throw new Error(`instância ${String(instancia)} não está de pé`);
  }

  const resposta = await fetch(`${alvo.baseUrl}${caminho}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(corpo),
  });

  const payload: unknown = await resposta.json();

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`resposta não é objeto JSON: ${JSON.stringify(payload)}`);
  }

  return { instancia, status: resposta.status, corpo: { ...payload } };
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  // Sequencial de propósito: o que precisa ser simultâneo são as **apostas**, e
  // subir três NestJS ao mesmo tempo só disputaria CPU no boot.
  for (let indice = 0; indice < INSTANCIAS; indice += 1) {
    instancias.push(await subirInstancia());
  }
}, 180_000);

afterAll(async () => {
  // Fechar o stdin é o sinal de encerramento; ver `app-instance.ts`.
  for (const instancia of instancias) {
    await instancia.processo.stdin.end();
  }

  await Promise.all(instancias.map(async (instancia) => instancia.processo.exited));
  await orm.close(true);
}, 60_000);

describe("RT-17 — três instâncias simultâneas (RNF-02, RI-08, EL-05, EL-02)", () => {
  it("as três sobem em processos distintos e atendem em portas distintas", () => {
    expect(instancias).toHaveLength(INSTANCIAS);

    const pids = new Set(instancias.map((instancia) => instancia.processo.pid));
    const urls = new Set(instancias.map((instancia) => instancia.baseUrl));

    // Três PIDs distintos é o que separa RT-17 de "três promessas no mesmo
    // processo", que é o que a §13 chama de mock sequencial e recusa.
    expect(pids.size).toBe(INSTANCIAS);
    expect(urls.size).toBe(INSTANCIAS);
  });

  it(
    "30 apostas simultâneas em 100.00 de saldo: cinco passam, 25 são rejeitadas",
    async () => {
      const abertura = await postar(0, "/wallets", {
        playerId: unico("player"),
        initialBalance: { amount: SALDO_INICIAL, currency: MOEDA },
      });

      expect(abertura.status).toBe(201);

      const walletId = abertura.corpo["id"];

      if (typeof walletId !== "string") {
        throw new Error(`abertura não devolveu id: ${JSON.stringify(abertura.corpo)}`);
      }

      const playerId = abertura.corpo["playerId"];

      if (typeof playerId !== "string") {
        throw new Error("abertura não devolveu playerId");
      }

      // 30 submissões **distintas** — cada uma com a sua key —, distribuídas em
      // rodízio pelas três instâncias e disparadas de uma vez só.
      const submissoes = Array.from(
        { length: INSTANCIAS * APOSTAS_POR_INSTANCIA },
        (_, indice) => indice,
      );

      const respostas = await Promise.all(
        submissoes.map(async (indice) =>
          postar(
            indice % INSTANCIAS,
            "/wagering/transactions",
            {
              providerId: "provider-multi",
              externalTransactionId: unico("ext"),
              playerId,
              walletId,
              roundId: unico("round"),
              gameId: "fortune-chimp",
              kind: WagerTransactionKind.Bet,
              money: { amount: VALOR_DA_APOSTA, currency: MOEDA },
            },
            { [IDEMPOTENCY_KEY_HEADER]: unico("idem") },
          ),
        ),
      );

      const aplicadas = respostas.filter((resposta) => resposta.status === 200);
      const rejeitadas = respostas.filter((resposta) => resposta.status === 422);

      // O saldo comporta cinco apostas de 20.00, e é isso que tem de acontecer —
      // independentemente de qual instância atendeu qual requisição.
      expect(aplicadas).toHaveLength(APOSTAS_QUE_CABEM);
      expect(rejeitadas).toHaveLength(
        INSTANCIAS * APOSTAS_POR_INSTANCIA - APOSTAS_QUE_CABEM,
      );

      expect(aplicadas.every((r) => r.corpo["status"] === WagerTransactionStatus.Processed)).toBe(
        true,
      );
      expect(
        rejeitadas.every((r) => r.corpo["failureCode"] === BusinessFailureCode.InsufficientFunds),
      ).toBe(true);

      // Nenhuma resposta ficou fora das duas situações previstas: um `409` aqui
      // seria corrida perdida no `UNIQUE` em vez de decisão serializada pelo
      // lock, e um `500` seria erro engolido virando "rejeição".
      expect(aplicadas.length + rejeitadas.length).toBe(respostas.length);

      // As três instâncias serviram tráfego — sem isso, "três processos" seria
      // afirmação, não fato observado.
      for (let indice = 0; indice < INSTANCIAS; indice += 1) {
        expect(respostas.filter((resposta) => resposta.instancia === indice)).toHaveLength(
          APOSTAS_POR_INSTANCIA,
        );
      }

      // O efeito no dinheiro: saldo zerado, cinco débitos, nem um a mais.
      expect((await saldoDe(orm, walletId)).toJSON()).toEqual({
        amount: "0.00",
        currency: MOEDA,
      });
      expect((await debitosDe(orm, walletId)).map((entry) => entry.amount)).toEqual(
        Array.from({ length: APOSTAS_QUE_CABEM }, () => VALOR_DA_APOSTA),
      );
      // Abertura levou à versão 1; cinco débitos levaram à 6 (RF-02).
      expect(await versaoDe(orm, walletId)).toBe(APOSTAS_QUE_CABEM + 1);

      // Toda submissão virou transação terminal auditável, inclusive as
      // rejeitadas (RN-11) — mais a `OPENING` da abertura.
      const transacoes = await transacoesDe(orm, walletId);

      expect(transacoes).toHaveLength(INSTANCIAS * APOSTAS_POR_INSTANCIA + 1);
      expect(
        transacoes.filter((linha) => linha.status === WagerTransactionStatus.Processed),
      ).toHaveLength(APOSTAS_QUE_CABEM + 1);

      await expectLedgerReconciles(orm, walletId);
    },
    180_000,
  );
});
