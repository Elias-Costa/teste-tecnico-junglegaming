/**
 * Um publisher da outbox em processo próprio — o alvo de RT-19 e do cenário
 * obrigatório de RF-24.
 *
 * **Não é arquivo de teste** (o `bun test` só coleta `*.test.ts`); é o programa
 * que `tests/concurrency/outbox-publishers.test.ts` executa com `Bun.spawn`,
 * no mesmo padrão que E-09 fixou em `tests/support/app-instance.ts`. Sobe o
 * worker de produção sem substituir nada: mesmo `OutboxClaimStore`, mesmo
 * `SqsEventPublisher` contra o LocalStack real, mesma `RetryPolicy` lida do
 * ambiente.
 *
 * Por que processos separados e não duas instâncias no mesmo processo: RF-24
 * exige múltiplos publishers concorrentes e EL-05 é "solução correta somente com
 * uma instância". Dois `OutboxPublisher` no mesmo processo passariam mesmo que a
 * exclusão viesse de um `Set` em memória — só processos distintos obrigam a
 * disputa a acontecer no `SKIP LOCKED` do banco.
 *
 * **Protocolo com o pai**, o mesmo de `app-instance.ts`:
 *  - stdout recebe uma linha JSON de anúncio quando o worker está de pé. É o
 *    handshake que sincroniza os processos sem depender de relógio;
 *  - o fim do stdin — o pai fechando o pipe — encerra por `stop()` ordenado, e
 *    uma **segunda** linha relata os ids que **esta** instância publicou;
 *  - stderr fica herdado, para que uma falha de boot apareça na saída do teste.
 *
 * O relato de saída é o que torna RT-19 verificável. Contar mensagens na fila não
 * provaria nada: o `MessageDeduplicationId` de D-040 faria o próprio SQS absorver
 * uma publicação repetida e **esconder** exatamente o defeito que o teste procura.
 * Comparando as listas dos dois processos, a dupla publicação aparece.
 *
 * **Modo de crash** (`OUTBOX_CRASH_AFTER_CLAIM=1`): reivindica um lote, anuncia
 * os ids reivindicados e **morre sem publicar**. É o passo (2) do cenário de
 * RF-24 — "o processo morre antes de publicar" —, e ele exige um processo real
 * morrendo depois de um commit real. Não há substituição de infraestrutura aqui
 * (EL-08): o que se simula é a **morte**, que é o cenário, não um duplo dele.
 *
 * A migration **não** é aplicada por este programa: quem prepara o schema e
 * semeia a outbox é o teste pai, e um `migrator.up()` aqui apagaria a semeadura.
 */
import { MikroORM } from "@mikro-orm/postgresql";
import { outboxRetryPolicy, readRetryEnv } from "../../src/infrastructure/config/retry-env.ts";
import type { EventPublisher } from "../../src/infrastructure/messaging/event-publisher.ts";
import { OutboxClaimStore } from "../../src/infrastructure/messaging/outbox-claim-store.ts";
import {
  defaultInstanceId,
  OutboxPublisher,
} from "../../src/infrastructure/messaging/outbox-publisher.ts";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { SystemClock } from "../../src/infrastructure/system-clock.ts";

const retry = readRetryEnv();
// Id vindo do ambiente quando o teste quer reconhecer quem publicou o quê; caso
// contrário, o mesmo default do worker de produção.
const instanceId = process.env.OUTBOX_INSTANCE_ID ?? defaultInstanceId();

const orm = await MikroORM.init(buildOrmConfig());
const store = new OutboxClaimStore(orm.em);
const events = SqsEventPublisher.fromEnv();

const anunciar = async (payload: Record<string, unknown>): Promise<void> => {
  await Bun.write(Bun.stdout, `${JSON.stringify(payload)}\n`);
};

if (process.env.OUTBOX_CRASH_AFTER_CLAIM === "1") {
  const reivindicadas = await store.claim({
    instanceId,
    now: new Date(),
    batchSize: retry.outboxBatchSize,
    leaseMs: retry.outboxLeaseMs,
  });

  await anunciar({ claimed: reivindicadas.map((mensagem) => mensagem.id), instanceId });

  // Morte abrupta, de propósito: sem `orm.close()`, sem soltar o lease, sem dar
  // ao worker chance de publicar. O claim já commitou — é exatamente o estado
  // que RF-24 descreve, e o que outra instância precisa saber assumir.
  process.exit(1);
}

/**
 * Anota o que foi publicado **sem substituir** a publicação.
 *
 * Delega ao `SqsEventPublisher` real — o LocalStack recebe a mensagem de fato — e
 * só registra o id depois do sucesso. Observar não é simular: EL-08 proíbe trocar
 * a infraestrutura por um duplo, não olhar o que passou por ela.
 */
const publicadas: string[] = [];
const registrador: EventPublisher = {
  publish: async (mensagem) => {
    await events.publish(mensagem);
    publicadas.push(mensagem.id);
  },
};

const publisher = new OutboxPublisher(store, registrador, new SystemClock(), outboxRetryPolicy(retry), {
  instanceId,
  batchSize: retry.outboxBatchSize,
  leaseMs: retry.outboxLeaseMs,
  pollIntervalMs: retry.outboxPollIntervalMs,
  // Erro de ciclo vai para o stderr herdado; o stdout é do handshake e uma linha
  // extra ali quebraria o parse do pai.
  onCycleError: (error: unknown) => {
    console.error("[outbox-publisher-instance] ciclo falhou:", error);
  },
});

publisher.start();

await anunciar({ ready: true, instanceId });

// Uma leitura basta: ela resolve tanto quando chega um byte quanto quando o pai
// fecha o pipe, e nos dois casos o significado é o mesmo — pode encerrar.
await Bun.stdin.stream().getReader().read();

await publisher.stop();

await anunciar({ published: publicadas, instanceId });

events.close();
await orm.close(true);
