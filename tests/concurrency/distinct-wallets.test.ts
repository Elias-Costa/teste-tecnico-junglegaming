/**
 * E-09 — wallets distintas em paralelo: RT-16.
 *
 * O requisito tem duas metades, e só a primeira é óbvia:
 *
 *  - **Progresso independente.** Cinco apostas em cinco wallets diferentes,
 *    simultâneas, todas aplicadas, cada saldo e cada ledger corretos.
 *  - **Ausência de contenção mútua** (RNF-01, RI-06). Esta é a que um teste
 *    ingênuo não prova: cinco apostas em wallets diferentes passariam igual se
 *    houvesse um lock global, só que **em fila**. O resultado final seria o mesmo
 *    e o desenho estaria errado.
 *
 * A prova da segunda metade é estrutural, não cronométrica. Cinco transações
 * abrem juntas, cada uma trava **a sua** wallet com o `FOR UPDATE` de D-002, e
 * nenhuma delas commita antes de as cinco terem o lock na mão. Se as wallets
 * disputassem um lock compartilhado, a quinta chegada nunca aconteceria — a
 * barreira estoura no prazo e o teste **falha com mensagem**, em vez de travar.
 *
 * Medir tempo de parede seria a alternativa, e seria pior: uma máquina lenta
 * transformaria a prova em teste intermitente, e é o oposto do que o critério de
 * conclusão desta etapa pede.
 *
 * Vem junto um **controle negativo**, e ele não é zelo excessivo: uma barreira
 * decorativa — que resolvesse sozinha, sem esperar ninguém — faria a prova acima
 * passar em qualquer desenho, inclusive no errado. O controle põe as cinco
 * transações na **mesma** wallet e exige que a barreira acuse.
 *
 * O `findByIdForUpdate` usado aqui é o mesmo — e único (D-002, RI-06) — ponto de
 * aquisição de lock do sistema. Nenhuma infraestrutura é substituída (EL-08).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction.ts";
import { WagerTransactionStatus } from "../../src/domain/wager-transaction.ts";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { MikroWalletRepository } from "../../src/infrastructure/persistence/repositories/mikro-wallet-repository.ts";
import { SystemClock } from "../../src/infrastructure/system-clock.ts";
import { UuidV7IdGenerator } from "../../src/infrastructure/uuid-v7-id-generator.ts";
import {
  Barreira,
  comandoDeAposta,
  debitosDe,
  expectLedgerReconciles,
  MOEDA,
  saldoDe,
  semearCarteira,
  versaoDe,
  type CarteiraSemeada,
} from "../support/concurrency-harness.ts";

let orm: MikroORM;
let processar: ProcessWagerTransaction;

/**
 * Wallets em disputa simultânea.
 *
 * Cinco, e não cinquenta: cada participante segura uma conexão do pool enquanto
 * espera na barreira, e o `pg` abre no máximo dez por padrão. Um número acima do
 * pool faria o teste falhar por esgotamento de conexão — que não é o que ele
 * existe para detectar.
 */
const CARTEIRAS = 5;

/** Prazo da barreira. Folgado para máquina lenta, curto para não parecer trava. */
const PRAZO_DA_BARREIRA_MS = 15_000;

/**
 * Prazo do controle negativo, onde o estouro é o resultado **esperado**.
 *
 * Curto de propósito: quem segura o lock nunca vai liberar, então esperar mais
 * só faria a suíte demorar para chegar à mesma conclusão.
 */
const PRAZO_DO_CONTROLE_MS = 750;

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

/** Semeia `CARTEIRAS` wallets com o mesmo saldo. */
async function semearTodas(amount: string): Promise<CarteiraSemeada[]> {
  const carteiras: CarteiraSemeada[] = [];

  for (let indice = 0; indice < CARTEIRAS; indice += 1) {
    carteiras.push(await semearCarteira(orm, amount));
  }

  return carteiras;
}

describe("RT-16 — wallets distintas em paralelo (RNF-01, RI-06, EL-05)", () => {
  it(
    "cinco wallets são travadas ao mesmo tempo — não há lock global",
    async () => {
      const carteiras = await semearTodas("100.00");
      const barreira = new Barreira(CARTEIRAS, PRAZO_DA_BARREIRA_MS);

      // Cada transação trava a sua wallet e **segura** o lock até que as cinco
      // tenham travado as suas. Com lock compartilhado, só a primeira chegaria.
      await Promise.all(
        carteiras.map(async (carteira) =>
          orm.em.transactional(async (tx) => {
            const travada = await new MikroWalletRepository(tx).findByIdForUpdate(carteira.id);

            expect(travada?.id).toBe(carteira.id);

            await barreira.chegar();
          }),
        ),
      );

      // Nenhuma das cinco escreveu nada — a prova é sobre a aquisição do lock, e
      // os saldos precisam continuar intactos para o próximo teste não herdar
      // efeito colateral de uma prova estrutural.
      for (const carteira of carteiras) {
        expect((await saldoDe(orm, carteira.id)).toJSON()).toEqual({
          amount: "100.00",
          currency: MOEDA,
        });
        await expectLedgerReconciles(orm, carteira.id);
      }
    },
    60_000,
  );

  it(
    "controle negativo: a mesma wallet não passa pela barreira",
    async () => {
      const disputada = await semearCarteira(orm, "100.00");
      const barreira = new Barreira(CARTEIRAS, PRAZO_DO_CONTROLE_MS);

      // Um teste que nunca falha não prova nada, e o teste acima passaria mesmo
      // que a barreira fosse decorativa. Aqui as cinco transações disputam **a
      // mesma** wallet — que é, por construção, o que um lock global faria com
      // wallets distintas. O `FOR UPDATE` serializa: cada uma só consegue o lock
      // depois de a anterior desistir, as quatro primeiras estouram o prazo, e
      // só a quinta encontra a barreira completa. É a demonstração de que o
      // instrumento da prova anterior tem como acusar contenção.
      //
      // A falha é capturada **dentro** de cada tarefa, e não por um `catch` em
      // volta do `Promise.all`: este esperaria só a primeira rejeição e deixaria
      // as outras quatro transações abertas no banco depois do fim do teste.
      const desfechos: unknown[] = await Promise.all(
        Array.from({ length: CARTEIRAS }, async (): Promise<unknown> => {
          try {
            await orm.em.transactional(async (tx) => {
              await new MikroWalletRepository(tx).findByIdForUpdate(disputada.id);
              await barreira.chegar();
            });

            return undefined;
          } catch (erro: unknown) {
            return erro;
          }
        }),
      );

      const falhas = desfechos.filter((desfecho) => desfecho !== undefined);
      const estouros = falhas.filter(
        (desfecho): desfecho is Error =>
          desfecho instanceof Error && desfecho.message.includes("barreira não completou"),
      );

      // Quatro desistem e uma passa — e as quatro desistências são estouro de
      // barreira, não outro erro qualquer que estivesse passando por prova.
      expect(falhas).toHaveLength(CARTEIRAS - 1);
      expect(estouros).toHaveLength(CARTEIRAS - 1);
    },
    60_000,
  );

  it(
    "cinco apostas simultâneas em wallets diferentes são todas aplicadas",
    async () => {
      const carteiras = await semearTodas("100.00");

      const desfechos = await Promise.all(
        carteiras.map(async (carteira) => processar.execute(comandoDeAposta(carteira, "30.00"))),
      );

      // Wallets distintas não competem por saldo: não há rejeição a explicar.
      expect(desfechos.map((desfecho) => desfecho.status)).toEqual(
        Array.from({ length: CARTEIRAS }, () => WagerTransactionStatus.Processed),
      );
      expect(desfechos.every((desfecho) => !desfecho.idempotentReplay)).toBe(true);

      // E cada wallet recebeu **o seu** débito, não o das vizinhas: um lock mal
      // escopado ou um `walletId` trocado apareceria aqui como saldo divergente.
      for (const carteira of carteiras) {
        expect((await saldoDe(orm, carteira.id)).toJSON()).toEqual({
          amount: "70.00",
          currency: MOEDA,
        });
        expect(await versaoDe(orm, carteira.id)).toBe(2);
        expect((await debitosDe(orm, carteira.id)).map((entry) => entry.amount)).toEqual(["30.00"]);

        await expectLedgerReconciles(orm, carteira.id);
      }
    },
    60_000,
  );
});
