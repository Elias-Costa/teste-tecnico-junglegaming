/**
 * E-09 — disputa pela **mesma** wallet: RT-15 e RT-14.
 *
 * Os dois cenários mais caros do desafio, e as duas eliminatórias mais caras:
 *
 *  - **RT-15 / RNF-03 / EL-02** — o cenário obrigatório da §8. Saldo `100.00`,
 *    duas apostas de `80.00` ao mesmo tempo. Uma passa, uma é rejeitada, o saldo
 *    fica `20.00` e o ledger tem **exatamente um** débito. Não existe desfecho
 *    "as duas passaram e o saldo ficou `-60.00`", e não existe "as duas foram
 *    rejeitadas".
 *  - **RT-14 / EL-03** — a mesma aposta submetida 50 vezes em paralelo produz
 *    **um** débito, **uma** transação e **dois** eventos. Não 50.
 *
 * **Paralelismo real, sem mock em ponto nenhum** (EL-08). O que serializa as
 * execuções é o `SELECT ... FOR UPDATE` de D-002 dentro do PostgreSQL real; nada
 * neste arquivo coordena a ordem entre elas. `Promise.all` dispara e o banco
 * decide.
 *
 * O use case é montado com as mesmas peças de `app.module.ts` — `MikroUnitOfWork`
 * sobre o `EntityManager` de nível de aplicação, `SystemClock`, `UuidV7IdGenerator`.
 * Uma única instância de `UnitOfWork` recebendo `run()` concorrente é exatamente
 * o formato de produção: o container do NestJS resolve um provider só, e as
 * requisições simultâneas o compartilham. A borda HTTP fica de fora aqui porque
 * é RT-17 que a exercita, com três instâncias.
 *
 * **A invariante da §6.4 fecha os dois testes**, por `expectLedgerReconciles`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionResult,
} from "../../src/application/process-wager-transaction.ts";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import { WagerTransactionStatus } from "../../src/domain/wager-transaction.ts";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { SystemClock } from "../../src/infrastructure/system-clock.ts";
import { UuidV7IdGenerator } from "../../src/infrastructure/uuid-v7-id-generator.ts";
import {
  comandoDeAposta,
  debitosDe,
  eventosDe,
  expectLedgerReconciles,
  MOEDA,
  saldoDe,
  semearCarteira,
  transacoesDe,
  versaoDe,
} from "../support/concurrency-harness.ts";

let orm: MikroORM;
let processar: ProcessWagerTransaction;

/**
 * Rodadas do cenário obrigatório.
 *
 * Uma corrida vencida por sorte passa uma vez; dez rodadas com wallet nova a
 * cada uma tornam o acaso caro. Não substitui as 10 execuções da suíte inteira
 * que o critério de conclusão pede — soma-se a elas.
 */
const RODADAS_DO_CENARIO = 10;

/** Submissões simultâneas de RT-14. O número vem do próprio requisito. */
const SUBMISSOES_IDENTICAS = 50;

/** Desfecho de uma rodada, no formato em que ela é conferida. */
interface ResumoDaRodada {
  walletId: string;
  /** Ordenados, para que a comparação não dependa de quem ganhou a corrida. */
  status: WagerTransactionStatus[];
  codigoDaRejeicao: string | undefined;
  saldo: string;
  versao: number;
  debitos: string[];
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  processar = new ProcessWagerTransaction(
    new MikroUnitOfWork(orm.em),
    new SystemClock(),
    new UuidV7IdGenerator(),
  );
});

afterAll(async () => {
  await orm.close(true);
});

/** Uma rodada completa do cenário obrigatório da §8. */
async function rodarCenarioObrigatorio(): Promise<ResumoDaRodada> {
  const carteira = await semearCarteira(orm, "100.00");

  // As duas apostas são operações **distintas** — keys e ids externos próprios.
  // É o que as faz disputar o saldo em vez de serem a mesma submissão repetida,
  // que é o cenário de RT-14 logo abaixo.
  const primeira = comandoDeAposta(carteira, "80.00");
  const segunda = comandoDeAposta(carteira, "80.00");

  const desfechos = await Promise.all([
    processar.execute(primeira),
    processar.execute(segunda),
  ]);

  const rejeitado = desfechos.find(
    (desfecho) => desfecho.status === WagerTransactionStatus.Rejected,
  );

  return {
    walletId: carteira.id,
    status: desfechos.map((desfecho) => desfecho.status).sort(),
    codigoDaRejeicao: rejeitado?.failureCode,
    saldo: (await saldoDe(orm, carteira.id)).toJSON().amount,
    versao: await versaoDe(orm, carteira.id),
    debitos: (await debitosDe(orm, carteira.id)).map((entry) => entry.amount),
  };
}

describe("RT-15 — cenário obrigatório da §8 (RNF-03, EL-02, EL-03)", () => {
  it(
    "100.00 com duas apostas de 80.00 simultâneas: uma passa, saldo 20.00, um débito",
    async () => {
      const resumos: ResumoDaRodada[] = [];

      for (let rodada = 0; rodada < RODADAS_DO_CENARIO; rodada += 1) {
        // Sequencial de propósito: o paralelismo que interessa é o de **dentro**
        // de cada rodada. Rodadas concorrentes só disputariam o pool de conexões
        // e diriam menos sobre a disputa por saldo.
        const resumo = await rodarCenarioObrigatorio();

        resumos.push(resumo);
        await expectLedgerReconciles(orm, resumo.walletId);
      }

      // Comparação do lote inteiro, e não asserção dentro do laço: assim a
      // rodada que divergir aparece no diff com o `walletId` para investigar.
      expect(
        resumos.map((resumo) => ({
          status: resumo.status,
          codigoDaRejeicao: resumo.codigoDaRejeicao,
          saldo: resumo.saldo,
          versao: resumo.versao,
          debitos: resumo.debitos,
        })),
      ).toEqual(
        Array.from({ length: RODADAS_DO_CENARIO }, () => ({
          status: [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected],
          codigoDaRejeicao: BusinessFailureCode.InsufficientFunds,
          saldo: "20.00",
          // A `OPENING` levou a wallet à versão 1; um único débito a levou à 2.
          // Se as duas apostas tivessem sido aplicadas, aqui apareceria 3 — é a
          // asserção que denuncia o débito duplicado mesmo que o saldo mentisse.
          versao: 2,
          debitos: ["80.00"],
        })),
      );
    },
    120_000,
  );

  it("a aposta rejeitada vira transação terminal auditável, sem lançamento (RN-11)", async () => {
    const carteira = await semearCarteira(orm, "100.00");

    const desfechos = await Promise.all([
      processar.execute(comandoDeAposta(carteira, "80.00")),
      processar.execute(comandoDeAposta(carteira, "80.00")),
    ]);

    const transacoes = await transacoesDe(orm, carteira.id);
    const rejeitadas = transacoes.filter(
      (linha) => linha.status === WagerTransactionStatus.Rejected,
    );

    // A rejeição existe no banco, com código e com o saldo observado no desfecho
    // (D-030) — é isso que separa "recusado com registro" de "sumiu".
    expect(rejeitadas).toHaveLength(1);
    expect(rejeitadas[0]?.failureCode).toBe(BusinessFailureCode.InsufficientFunds);
    expect(rejeitadas[0]?.observedBalance).toBe("20.00");

    // E ela não moveu dinheiro: um débito ao todo, o da aposta que passou.
    expect(await debitosDe(orm, carteira.id)).toHaveLength(1);

    // Cada desfecho publicou o seu evento, e só ele (RF-25, RI-04).
    const processada = desfechos.find(
      (desfecho) => desfecho.status === WagerTransactionStatus.Processed,
    );
    const rejeitada = desfechos.find(
      (desfecho) => desfecho.status === WagerTransactionStatus.Rejected,
    );

    expect(await eventosDe(orm, processada?.transactionId ?? "")).toEqual([
      "WagerTransactionProcessed",
    ]);
    expect(await eventosDe(orm, rejeitada?.transactionId ?? "")).toEqual([
      "WagerTransactionRejected",
    ]);

    await expectLedgerReconciles(orm, carteira.id);
  }, 30_000);
});

describe("RT-14 — a mesma aposta 50 vezes em paralelo (EL-03, EL-04)", () => {
  it(
    "produz um único débito, uma única transação e dois eventos",
    async () => {
      const carteira = await semearCarteira(orm, "100.00");
      const aposta = comandoDeAposta(carteira, "20.00");

      // 50 cópias do **mesmo** comando: mesma `Idempotency-Key`, mesmo payload.
      // É a retentativa de rede do provedor, multiplicada — e o que RF-14 promete
      // é que ela custe um débito, não 50.
      const desfechos: ProcessWagerTransactionResult[] = await Promise.all(
        Array.from({ length: SUBMISSOES_IDENTICAS }, () => processar.execute({ ...aposta })),
      );

      const ids = new Set(desfechos.map((desfecho) => desfecho.transactionId));
      const aplicacoes = desfechos.filter((desfecho) => !desfecho.idempotentReplay);

      // Todas as 50 respostas descrevem a **mesma** transação.
      expect(ids.size).toBe(1);
      expect(desfechos.every((d) => d.status === WagerTransactionStatus.Processed)).toBe(true);

      // Exatamente uma foi trabalho novo; as outras 49 são replay (RN-12). Este
      // número é consequência direta de o lock de D-002 vir **antes** da consulta
      // de idempotência: sem essa ordem, várias responderiam "ainda não existe"
      // ao mesmo tempo e disputariam o `insert`.
      expect(aplicacoes).toHaveLength(1);

      // E o efeito no dinheiro é o de uma aposta só.
      expect(await debitosDe(orm, carteira.id)).toHaveLength(1);
      expect((await saldoDe(orm, carteira.id)).toJSON()).toEqual({
        amount: "80.00",
        currency: MOEDA,
      });
      expect(await versaoDe(orm, carteira.id)).toBe(2);

      const transacoes = await transacoesDe(orm, carteira.id);
      const apostas = transacoes.filter((linha) => linha.idempotencyKey === aposta.idempotencyKey);

      expect(apostas).toHaveLength(1);

      // A outbox recebeu os eventos de **uma** aplicação. 100 linhas aqui seriam
      // EL-03 vazando pelo lado da mensageria, com o ledger aparentemente são.
      expect(await eventosDe(orm, desfechos[0]?.transactionId ?? "")).toEqual([
        "WagerTransactionProcessed",
      ]);
      expect(await eventosDe(orm, carteira.id)).toEqual(["WalletBalanceChanged"]);

      await expectLedgerReconciles(orm, carteira.id);
    },
    120_000,
  );
});
