/**
 * E-10 — dois publishers em processos separados sobre a mesma outbox: **RT-19**.
 *
 * É para o worker o que RT-17 é para a API: a prova de que a correção não depende
 * de estado em processo. Dois `OutboxPublisher` dentro do mesmo processo passariam
 * mesmo que a exclusão viesse de um `Set` de módulo — **EL-05 na forma exata**.
 * Aqui são dois processos de sistema operacional (`tests/support/
 * outbox-publisher-instance.ts`), sem memória compartilhada, e o que sobra para
 * coordenar é o `SKIP LOCKED` do banco, que é o que D-009 escolheu.
 *
 * Os três casos, na ordem em que RF-24 os pede:
 *
 *  1. dois publishers simultâneos publicam cada mensagem **exatamente uma vez**;
 *  2. **lease expirado é reivindicado por outra instância** — sem este, o cenário
 *     obrigatório de RF-24 não está provado (consequência registrada em D-009);
 *  3. o cenário obrigatório inteiro: commit do claim → o processo morre antes de
 *     publicar → outra instância assume → o evento é publicado.
 *
 * A prova de "exatamente uma vez" **não** pode ser a contagem de mensagens na
 * fila: o `MessageDeduplicationId` de D-040 faria o próprio SQS absorver uma
 * publicação repetida e esconder o defeito. Cada instância relata, ao encerrar, os
 * ids que publicou; a união das duas listas é que responde.
 *
 * Sincronização por anúncio e por estado no banco, nunca por `sleep` fixo — o
 * padrão que E-09 fixou. Sem mock em ponto nenhum (EL-08): PostgreSQL e LocalStack
 * reais, e a única coisa simulada é a **morte do processo**, que é o cenário.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  type Message,
  MessageSystemAttributeName,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.ts";
import { Money } from "../../src/domain/money.ts";
import { OutboxMessage } from "../../src/domain/outbox-message.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import { readSqsEnv } from "../../src/infrastructure/config/sqs-env.ts";
import { ensureQueue } from "../../src/infrastructure/messaging/sqs-queue-provisioner.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { MikroOutboxRepository } from "../../src/infrastructure/persistence/repositories/mikro-outbox-repository.ts";
import { comPrazo, lerLinha, novoId, unico } from "../support/concurrency-harness.ts";

/** O mínimo que RT-19 exige. Dois processos, não duas promessas. */
const PUBLISHERS = 2;

/**
 * Mensagens semeadas no caso de disputa.
 *
 * O número é grande e o lote (`OUTBOX_BATCH_SIZE`) é pequeno de propósito: são
 * muitas rodadas de claim, e é a quantidade de rodadas que dá chance de dois
 * publishers caírem na mesma janela. Com poucas mensagens, o primeiro drenaria a
 * outbox sozinho e o teste passaria sem nunca ter havido disputa — a prova sem
 * dentes que E-09 aprendeu a procurar.
 */
const MENSAGENS = 60;

/** Prazo para uma instância anunciar que está publicando. */
const PRAZO_DE_BOOT_MS = 60_000;

/** Prazo para a outbox esvaziar. */
const PRAZO_DE_DRENO_MS = 60_000;

/**
 * Lease curto, para que o caso 3 não espere os 30 s de D-008.
 *
 * É a razão de os parâmetros serem configuráveis (D-008): o teste anda em
 * milissegundos **sem** trocar o mecanismo por um relógio falso.
 */
const LEASE_CURTO_MS = 1_500;

let orm: MikroORM;
let sqs: SQSClient;
let filaNome: string;
let filaUrl: string;

/** Uma instância publicando, em processo próprio. */
interface Publisher {
  processo: Bun.Subprocess<"pipe", "pipe", "inherit">;
  instanceId: string;
}

async function sql(
  query: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.getConnection().execute<Record<string, unknown>[]>(query, params);
}

/** Evento de integração real, montado pelo domínio (puro, sem tocar banco). */
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

/** Enfileira uma mensagem pela via de produção e devolve o id da linha. */
async function semearMensagem(): Promise<string> {
  return (await semearMensagens(1))[0] ?? "";
}

/**
 * Enfileira N mensagens numa **única** transação.
 *
 * A atomicidade importa para a prova: as N linhas ficam visíveis no mesmo
 * instante, e os publishers já em execução as encontram de uma vez. Semear uma a
 * uma escalonaria a chegada e reduziria a disputa justamente no teste que existe
 * para provocá-la.
 */
async function semearMensagens(quantidade: number): Promise<string[]> {
  const mensagens = Array.from({ length: quantidade }, () =>
    OutboxMessage.enqueue({ id: novoId(), event: eventoDeSaldo() }),
  );

  await orm.em.transactional(async (em) => {
    const outbox = new MikroOutboxRepository(em);

    for (const mensagem of mensagens) {
      await outbox.insert(mensagem);
    }
  });

  return mensagens.map((mensagem) => mensagem.id);
}

/**
 * Sobe um publisher em processo próprio.
 *
 * O ambiente é herdado inteiro — é assim que a conexão de D-011 e a fila desta
 * execução atravessam —, com os parâmetros de retry ajustados por cima. `stderr`
 * herdado deixa falha de boot visível na saída do teste.
 */
function subirPublisher(extra: Record<string, string> = {}): Publisher {
  const instanceId = unico("publisher");

  const processo = Bun.spawn({
    // `process.execPath` é o próprio Bun que roda a suíte — não depende de `bun`
    // estar no PATH do shell que invocou o teste.
    cmd: [process.execPath, `${import.meta.dir}/../support/outbox-publisher-instance.ts`],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      SQS_EVENTS_QUEUE: filaNome,
      OUTBOX_INSTANCE_ID: instanceId,
      OUTBOX_POLL_INTERVAL_MS: "5",
      OUTBOX_BATCH_SIZE: "2",
      OUTBOX_LEASE_MS: String(LEASE_CURTO_MS),
      ...extra,
    },
  });

  return { processo, instanceId };
}

/** Lê uma linha de anúncio do filho e devolve o objeto JSON. */
async function lerAnuncio(
  publisher: Publisher,
  oQue: string,
): Promise<Record<string, unknown>> {
  const linha = await comPrazo(lerLinha(publisher.processo.stdout), PRAZO_DE_BOOT_MS, oQue);
  const payload: unknown = JSON.parse(linha);

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`anúncio inesperado do publisher: ${linha}`);
  }

  return { ...payload };
}

/**
 * Encerra o publisher e devolve os ids que **ele** publicou.
 *
 * Fechar o stdin é o sinal de encerramento; ver `outbox-publisher-instance.ts`.
 */
async function encerrar(publisher: Publisher): Promise<string[]> {
  await publisher.processo.stdin.end();

  const relato = await lerAnuncio(publisher, "o relato de saída do publisher");

  await publisher.processo.exited;

  const { published } = relato;

  if (!Array.isArray(published)) {
    throw new Error(`relato de saída sem lista de publicados: ${JSON.stringify(relato)}`);
  }

  return published.filter((id): id is string => typeof id === "string");
}

/** Quantas linhas da outbox continuam pendentes. */
async function pendentes(): Promise<number> {
  const [linha] = await sql(
    `select count(*)::int as total from outbox_messages where published_at is null`,
  );

  return typeof linha?.["total"] === "number" ? linha["total"] : -1;
}

/**
 * Espera a outbox esvaziar, observando o **banco**.
 *
 * A condição de parada é o estado real, não um `sleep` calibrado: numa máquina
 * lenta o `sleep` daria falso negativo, e numa rápida desperdiçaria tempo.
 */
async function esperarOutboxVazia(prazoMs = PRAZO_DE_DRENO_MS): Promise<void> {
  const limite = Date.now() + prazoMs;

  while (Date.now() < limite) {
    if ((await pendentes()) === 0) {
      return;
    }

    await Bun.sleep(50);
  }

  throw new Error(
    `a outbox ainda tem ${String(await pendentes())} mensagens pendentes após ${String(prazoMs)}ms.`,
  );
}

/** Recebe e apaga mensagens da fila — `DeleteMessage` é obrigatório em FIFO. */
async function drenarFila(esperado: number): Promise<Message[]> {
  const recebidas: Message[] = [];

  for (let tentativa = 0; tentativa < 30 && recebidas.length < esperado; tentativa += 1) {
    const resposta = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: filaUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: [MessageSystemAttributeName.All],
      }),
    );

    for (const mensagem of resposta.Messages ?? []) {
      recebidas.push(mensagem);
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: filaUrl, ReceiptHandle: mensagem.ReceiptHandle }),
      );
    }
  }

  return recebidas;
}

/**
 * Uma espiada na fila, para afirmar que **nada** foi publicado.
 *
 * `drenarFila(0)` não serviria: o laço dela nem chega a consultar o SQS quando o
 * esperado é zero, e o teste passaria sem ter olhado. O que é apagado aqui vai
 * junto na mensagem de falha, para que "publicou o que não devia" seja legível.
 */
async function espiarFila(): Promise<Message[]> {
  const resposta = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: filaUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: [MessageSystemAttributeName.All],
    }),
  );

  const recebidas = resposta.Messages ?? [];

  for (const mensagem of recebidas) {
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: filaUrl, ReceiptHandle: mensagem.ReceiptHandle }),
    );
  }

  return recebidas;
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  const env = readSqsEnv();
  sqs = new SQSClient({
    region: env.region,
    endpoint: env.endpoint,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });

  // Fila própria desta execução: a fila do LocalStack sobrevive entre arquivos de
  // teste, e contar mensagens numa fila compartilhada leria resíduo como defeito.
  filaNome = `rt19-${novoId()}.fifo`;
  filaUrl = await ensureQueue(sqs, filaNome);
}, 180_000);

/**
 * Cada cenário começa com outbox e fila vazias.
 *
 * Os três casos contam mensagens, e uma linha ou uma mensagem herdada do cenário
 * anterior faria a contagem afirmar outra coisa. Os publishers são criados e
 * encerrados dentro de cada `it`, então nenhuma limpeza acontece com processo vivo.
 */
beforeEach(async () => {
  await sql(`delete from outbox_messages`);

  for (let tentativa = 0; tentativa < 10; tentativa += 1) {
    const resposta = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: filaUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
    );

    const mensagens = resposta.Messages ?? [];

    if (mensagens.length === 0) {
      break;
    }

    for (const mensagem of mensagens) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: filaUrl, ReceiptHandle: mensagem.ReceiptHandle }),
      );
    }
  }
}, 60_000);

afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: filaUrl }));
  sqs.destroy();
  await orm.close(true);
}, 60_000);

describe("RT-19 — dois publishers sobre a mesma outbox (RF-24, RI-08, EL-05, EL-06)", () => {
  it(
    "publicam cada mensagem exatamente uma vez, sem pegar a mesma",
    async () => {
      // **Os publishers sobem antes da semeadura**, e essa ordem é a prova.
      // Semeando primeiro, o publisher que sobe em ~1 s drenaria a outbox inteira
      // enquanto o segundo ainda inicializa o ORM — o teste passaria sem nunca ter
      // havido dois claims simultâneos, que é exatamente o que RT-19 mede.
      const publishers: Publisher[] = [];

      for (let indice = 0; indice < PUBLISHERS; indice += 1) {
        const publisher = subirPublisher();
        await lerAnuncio(publisher, "o anúncio de um publisher");
        publishers.push(publisher);
      }

      // Dois PIDs distintos é o que separa RT-19 de "dois workers no mesmo
      // processo", que é o mock sequencial que a §13 do enunciado recusa.
      expect(new Set(publishers.map((p) => p.processo.pid)).size).toBe(PUBLISHERS);

      // Com os dois já varrendo, as 60 linhas aparecem de uma vez.
      const semeadas = new Set(await semearMensagens(MENSAGENS));

      await esperarOutboxVazia();

      const relatos = await Promise.all(publishers.map(async (p) => encerrar(p)));
      const publicadas = relatos.flat();

      // A prova: a união das listas tem exatamente MENSAGENS entradas, e nenhuma
      // repetida. Uma linha reivindicada por dois processos apareceria duas vezes.
      expect(publicadas).toHaveLength(MENSAGENS);
      expect(new Set(publicadas).size).toBe(MENSAGENS);
      expect(new Set(publicadas)).toEqual(semeadas);

      // Os dois processos trabalharam — sem isso, "dois publishers" seria
      // afirmação e não fato observado.
      expect(relatos.every((relato) => relato.length > 0)).toBe(true);

      const [linha] = await sql(
        `select count(*)::int as presas from outbox_messages where locked_by is not null`,
      );

      // Nenhum lease pendurado depois da publicação (D-043).
      expect(linha?.["presas"]).toBe(0);

      expect(await drenarFila(MENSAGENS)).toHaveLength(MENSAGENS);
    },
    240_000,
  );

  it(
    "lease expirado é reivindicado por outra instância",
    async () => {
      const id = await semearMensagem();

      // Uma instância que sumiu deixou o lease para trás, já vencido.
      await sql(
        `update outbox_messages
            set locked_by = 'instancia-que-sumiu', locked_until = now() - interval '1 second'
          where id = ?`,
        [id],
      );

      const publisher = subirPublisher();
      await lerAnuncio(publisher, "o anúncio do publisher");

      await esperarOutboxVazia();

      const publicadas = await encerrar(publisher);

      expect(publicadas).toEqual([id]);

      const [linha] = await sql(
        `select published_at, locked_by from outbox_messages where id = ?`,
        [id],
      );

      expect(linha?.["published_at"]).not.toBeNull();
      expect(linha?.["locked_by"]).toBeNull();

      expect(await drenarFila(1)).toHaveLength(1);
    },
    180_000,
  );
});

describe("RF-24 — cenário obrigatório: o processo morre entre o commit e a publicação", () => {
  it(
    "A reivindica e morre; B assume quando o lease vence e publica o evento",
    async () => {
      const id = await semearMensagem();

      // (1) e (2): o claim commita e o processo morre antes de publicar.
      const morrendo = subirPublisher({ OUTBOX_CRASH_AFTER_CLAIM: "1" });
      const relato = await lerAnuncio(morrendo, "o anúncio da instância que vai morrer");

      expect(relato["claimed"]).toEqual([id]);
      expect(await morrendo.processo.exited).toBe(1);

      const [aposAMorte] = await sql(
        `select published_at, locked_by from outbox_messages where id = ?`,
        [id],
      );

      // O commit do claim sobreviveu à morte; a publicação não aconteceu.
      expect(aposAMorte?.["locked_by"]).toBe(morrendo.instanceId);
      expect(aposAMorte?.["published_at"]).toBeNull();
      expect(await espiarFila()).toHaveLength(0);

      // (3) e (4): outra instância assume — só depois de o lease vencer — e publica.
      const assumindo = subirPublisher();
      await lerAnuncio(assumindo, "o anúncio da instância que assume");

      await esperarOutboxVazia();

      expect(await encerrar(assumindo)).toEqual([id]);

      const [aoFim] = await sql(
        `select published_at, locked_by, locked_until from outbox_messages where id = ?`,
        [id],
      );

      expect(aoFim?.["published_at"]).not.toBeNull();
      expect(aoFim?.["locked_by"]).toBeNull();
      expect(aoFim?.["locked_until"]).toBeNull();

      // (5): o evento chegou à fila, uma vez.
      const recebidas = await drenarFila(1);

      expect(recebidas).toHaveLength(1);
      expect(recebidas[0]?.Attributes?.[MessageSystemAttributeName.MessageDeduplicationId]).toBe(
        id,
      );
    },
    180_000,
  );
});
