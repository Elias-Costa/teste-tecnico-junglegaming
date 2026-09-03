/**
 * Um consumidor da fila de entrada em processo próprio — o alvo de **RT-18**.
 *
 * **Não é arquivo de teste** (o `bun test` só coleta `*.test.ts`); é o programa
 * que `tests/concurrency/consumer-crash-before-ack.test.ts` executa com
 * `Bun.spawn`, no mesmo padrão que E-09 fixou em `tests/support/app-instance.ts`
 * e E-10 repetiu em `outbox-publisher-instance.ts`. Sobe o `SqsWagerConsumer` de
 * produção com o `WagerMessageHandler` de produção — a **mesma** composição do
 * `WorkersModule` —, contra PostgreSQL e LocalStack reais.
 *
 * Por que um processo separado e não o consumidor no processo do teste: RT-18
 * pede o worker **morto** entre o commit e o `ack`, e não há como matar meio
 * ciclo de dentro da suíte sem também matá-la. Só um processo de sistema
 * operacional próprio pode morrer.
 *
 * **Protocolo com o pai**, o mesmo dos outros dois harnesses:
 *  - stdout recebe uma linha JSON de anúncio quando o consumidor está de pé;
 *  - o fim do stdin — o pai fechando o pipe — encerra por `stop()` ordenado, e
 *    uma **segunda** linha relata o que **esta** instância viu;
 *  - stderr fica herdado, para que uma falha de boot apareça na saída do teste.
 *
 * **Modo de crash** (`CONSUMER_CRASH_AFTER_COMMIT=1`): o handler real processa a
 * mensagem — abrindo e **commitando** a transação financeira —, o desfecho é
 * anunciado e o processo morre **sem retornar ao laço**, ou seja, antes de o
 * `SqsWagerConsumer` chegar ao `DeleteMessage`. Esse é exatamente o instante que
 * RT-18 nomeia.
 *
 * Nada é substituído (EL-08): o envoltório de `MessageHandler` **delega** ao
 * handler de produção e só olha o que passou por ele, como o registrador de
 * `outbox-publisher-instance.ts` faz com as publicações. A única coisa simulada é
 * a **morte**, que é o cenário e não um duplo dele.
 *
 * A migration **não** é aplicada por este programa: quem prepara o schema e semeia
 * a wallet é o teste pai, e um `migrator.up()` aqui apagaria a semeadura.
 */
import { MikroORM } from "@mikro-orm/postgresql";
import { InboxLookup } from "../../src/application/inbox-lookup.ts";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction.ts";
import { readRetryEnv } from "../../src/infrastructure/config/retry-env.ts";
import type {
  MessageDisposition,
  MessageHandler,
  ReceivedMessage,
} from "../../src/infrastructure/messaging/message-handler.ts";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs-wager-consumer.ts";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger.ts";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { SystemClock } from "../../src/infrastructure/system-clock.ts";
import { UuidV7IdGenerator } from "../../src/infrastructure/uuid-v7-id-generator.ts";
import { WagerMessageHandler } from "../../src/interface/messaging/wager-message-handler.ts";

const instanceId = process.env.CONSUMER_INSTANCE_ID ?? `consumidor-${Bun.randomUUIDv7()}`;
const morrerAposCommit = process.env.CONSUMER_CRASH_AFTER_COMMIT === "1";

const anunciar = async (payload: Record<string, unknown>): Promise<void> => {
  await Bun.write(Bun.stdout, `${JSON.stringify(payload)}\n`);
};

const orm = await MikroORM.init(buildOrmConfig());
const unitOfWork = new MikroUnitOfWork(orm.em);

// Logger de produção com o destino trocado: o stdout deste processo é o
// handshake com o pai, e uma linha de log no meio dele quebraria o parse. Trocar
// o destino não substitui o mecanismo — a serialização de RNF-06 é a mesma.
const logger = new JsonLogger((linha: string) => {
  console.error(`[wager-consumer-instance] ${linha}`);
});

const handlerDeProducao = new WagerMessageHandler(
  new ProcessWagerTransaction(unitOfWork, new SystemClock(), new UuidV7IdGenerator()),
  new InboxLookup(unitOfWork),
  logger,
);

/** Desfechos que este processo observou, na ordem em que aconteceram. */
const desfechos: MessageDisposition[] = [];

/**
 * Observa o handler de produção **sem** substituí-lo.
 *
 * No modo normal, só conta: é o que permite ao pai afirmar que a instância que
 * assumiu de fato **recebeu** a redelivery, em vez de o teste inferir isso da
 * fila ter esvaziado — que também esvaziaria se alguém tivesse apagado a
 * mensagem sem processá-la.
 *
 * No modo de crash, mata o processo assim que o handler retorna. O handler já
 * commitou a transação nesse ponto; o `SqsWagerConsumer` ainda não chamou
 * `apply()`. Morrer aqui é morrer **depois do commit e antes do ack**.
 */
const observador: MessageHandler = {
  handle: async (message: ReceivedMessage): Promise<MessageDisposition> => {
    const disposition = await handlerDeProducao.handle(message);

    desfechos.push(disposition);

    if (morrerAposCommit) {
      await anunciar({
        committed: disposition,
        transportMessageId: message.transportMessageId,
        instanceId,
      });

      // Morte abrupta, de propósito: sem `orm.close()`, sem `DeleteMessage`, sem
      // dar ao consumidor a chance de fechar o ciclo. O commit da transação
      // financeira já aconteceu — é o estado que RT-18 descreve, e o que a
      // próxima instância precisa saber absorver pela inbox (RF-19).
      process.exit(1);
    }

    return disposition;
  },
};

const consumidor = await SqsWagerConsumer.fromEnv(observador, undefined, readRetryEnv());

consumidor.start();

await anunciar({ ready: true, instanceId, crashing: morrerAposCommit });

// Uma leitura basta: ela resolve tanto quando chega um byte quanto quando o pai
// fecha o pipe, e nos dois casos o significado é o mesmo — pode encerrar.
await Bun.stdin.stream().getReader().read();

await consumidor.stop();

await anunciar({
  received: desfechos.length,
  acked: desfechos.filter((desfecho) => desfecho === "ack").length,
  dispositions: desfechos,
  instanceId,
});

consumidor.close();
await orm.close(true);
