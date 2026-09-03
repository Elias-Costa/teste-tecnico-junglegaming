/**
 * E-15/D-063 — os três laços montados no processo, e o encerramento deles.
 *
 * Até esta etapa os workers eram classes que **só os testes instanciavam**: um
 * avaliador que subisse a aplicação não publicava evento nenhum. O que esta
 * suíte prova é o outro lado disso — que `WorkersModule` de fato liga os laços
 * ao ciclo de vida da aplicação, e que `close()` os desliga.
 *
 * **Por que provar o encerramento por `close()` e não por `SIGTERM`:** o Windows
 * não tem sinais POSIX, então mandar `SIGTERM` na máquina de desenvolvimento não
 * exercita caminho nenhum — o processo é terminado à força e nenhum gancho roda.
 * O que `enableShutdownHooks()` faz em `main.ts` é ligar o sinal ao
 * `onApplicationShutdown`, e é **este** gancho que o teste exercita
 * diretamente. A metade que sobra — o sistema operacional entregar o sinal — é
 * do container, não do código.
 *
 * Roda contra PostgreSQL e SQS reais (EL-08): a publicação que se observa aqui
 * saiu de verdade pelo `SqsEventPublisher` para o LocalStack.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.ts";
import { Money } from "../../src/domain/money.ts";
import { OutboxMessage } from "../../src/domain/outbox-message.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { MikroOutboxRepository } from "../../src/infrastructure/persistence/repositories/mikro-outbox-repository.ts";
import { WorkersModule } from "../../src/interface/workers/workers.module.ts";
import { aguardar } from "../support/concurrency-harness.ts";

let orm: MikroORM;
let app: INestApplication;

function novoId(): string {
  return Bun.randomUUIDv7();
}

function unico(prefixo: string): string {
  return `${prefixo}-${novoId()}`;
}

/** Um evento de integração de verdade, montado pelo domínio (mesmo de E-10). */
function eventoDeSaldo(): WalletBalanceChanged {
  const { wallet, openingEntry } = Wallet.open({
    id: novoId(),
    playerId: unico("player"),
    initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
    openingTransactionId: novoId(),
    openingEntryId: novoId(),
    at: new Date(),
  });

  if (openingEntry === undefined) {
    throw new Error("saldo inicial acima de zero deve produzir lançamento de abertura.");
  }

  return WalletBalanceChanged.from(wallet, openingEntry, {
    eventId: novoId(),
    correlationId: unico("corr"),
    occurredAt: new Date(),
  });
}

/** Enfileira um evento na outbox pelo repositório de produção. */
async function semearMensagem(): Promise<OutboxMessage> {
  const mensagem = OutboxMessage.enqueue({ id: novoId(), event: eventoDeSaldo() });

  await orm.em.transactional(async (em) => {
    await new MikroOutboxRepository(em).insert(mensagem);
  });

  return mensagem;
}

/** `published_at` da linha, que só o worker preenche. */
async function publicadaEm(id: string): Promise<Date | undefined> {
  const [linha] = await orm.em
    .fork()
    .getConnection()
    .execute<{ published_at: Date | null }[]>(
      `select "published_at" from "outbox_messages" where "id" = ?`,
      [id],
    );

  return linha?.published_at ?? undefined;
}

/**
 * Intervalo de sondagem passado a `aguardar`, em vez do default de 25 ms.
 *
 * O worker roda no próprio ritmo, e 100 ms é frequente o bastante para não somar
 * latência perceptível ao caso feliz e esparso o bastante para não martelar o
 * banco com uma consulta a cada 25 ms durante os 15 s de prazo.
 */
const INTERVALO_MS = 100;

/**
 * Prazo do caso que espera a publicação, folgado sobre os 15 s de `aguardar`.
 *
 * O default do `bun test` é 5 s — **abaixo** do prazo que este caso pede. Sem
 * este argumento o runner mataria o teste antes de `aguardar` chegar a lançar,
 * e a falha viria como "this test timed out after 5000ms" em vez de dizer o que
 * não aconteceu. O prazo do caso precisa ser folgado em relação ao prazo da
 * espera; o contrário torna o prazo da espera decorativo.
 */
const PRAZO_DO_CASO_MS = 60_000;

/**
 * Prazo do `beforeAll`. Os hooks do `bun test` caem no **mesmo** default de 5 s.
 *
 * Este hook derruba e reaplica o schema inteiro e sobe a aplicação, e o
 * `app.init()` provisiona a fila de entrada e a DLQ pela rede (D-041): num
 * LocalStack frio isso passa de 5 s com folga, e o arquivo inteiro falharia por
 * timeout de hook, sem apontar nem o banco nem a fila. Mesmo valor do hook
 * equivalente em `recovery-after-restart.test.ts`.
 */
const PRAZO_DO_HOOK_MS = 180_000;

/** Valor original de `CONSUMER_WAIT_TIME_SEC`, restaurado ao fim. */
const esperaOriginal = process.env.CONSUMER_WAIT_TIME_SEC;

beforeAll(async () => {
  // **Long polling curto, pelo mecanismo de produção.** `stop()` aguarda o
  // `ReceiveMessage` em voo terminar (RF-22), então com o default de 20 s o
  // encerramento custaria 20 s neste teste. D-008 tornou o valor configurável
  // exatamente para isto: o teste encurta o parâmetro, não substitui o mecanismo.
  process.env.CONSUMER_WAIT_TIME_SEC = "1";

  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  // O módulo raiz de produção, o mesmo que `src/main.ts` sobe. Nada substituído.
  const modulo = await Test.createTestingModule({ imports: [WorkersModule] }).compile();

  app = modulo.createNestApplication();
  // `init()` dispara `onApplicationBootstrap`, que é onde os laços começam.
  // Sem `listen()`: o que esta suíte observa são os workers, não as rotas.
  await app.init();
}, PRAZO_DO_HOOK_MS);

afterAll(async () => {
  await orm.close(true);

  if (esperaOriginal === undefined) {
    delete process.env.CONSUMER_WAIT_TIME_SEC;
  } else {
    process.env.CONSUMER_WAIT_TIME_SEC = esperaOriginal;
  }
});

describe("WorkersModule (D-063)", () => {
  it("publica uma linha da outbox sem ninguém chamar o worker à mão (RF-24)", async () => {
    const mensagem = await semearMensagem();

    // É a diferença que D-063 fez: antes desta etapa, esta linha ficaria pendente
    // para sempre num processo real, porque ninguém instanciava o publisher.
    // `aguardar` **lança** no estouro do prazo, então a asserção é ela retornar:
    // o prazo vencido vira "a linha da outbox ser publicada não aconteceu em
    // 15000ms" em vez de um `expect(false)` que não diz o que se esperava.
    await aguardar(
      async () => (await publicadaEm(mensagem.id)) !== undefined,
      15_000,
      "a linha da outbox ser publicada pelo laço do WorkersModule",
      INTERVALO_MS,
    );
  }, PRAZO_DO_CASO_MS);

  it("encerra os três laços no shutdown da aplicação (RF-22)", async () => {
    // `close()` **aguarda** o ciclo em andamento de cada laço: é o requisito, não
    // cortesia. Por isso o teste tem folga própria — o encerramento ordenado
    // custa, no pior caso, o long polling do consumidor.
    await app.close();

    // Depois do encerramento, uma linha nova **não** é publicada: os laços
    // pararam de verdade, em vez de continuarem rodando órfãos.
    const orfa = await semearMensagem();

    // **Este caso não usa `aguardar`, e é deliberado.** `aguardar` sonda até a
    // condição ficar verdadeira — é a forma de provar que algo *acontece*, e
    // ausência não se prova procurando presença. Aqui a asserção é a oposta:
    // dá-se ao laço uma janela de graça generosa em relação ao seu período de
    // poll (`OUTBOX_POLL_INTERVAL_MS`, 1 s por default) e lê-se o estado uma vez.
    // Um laço órfão publicaria dentro dela; um laço encerrado, não.
    await Bun.sleep(2_000);

    expect(await publicadaEm(orfa.id)).toBeUndefined();
  }, 20_000);
});
