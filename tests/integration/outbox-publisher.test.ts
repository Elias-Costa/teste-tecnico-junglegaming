/**
 * E-10 — o worker da outbox contra PostgreSQL e SQS reais: **RT-11**.
 *
 * O que se prova aqui é o desenho de D-009 acontecendo, passo a passo:
 *
 *  - a mensagem devida é reivindicada, publicada **fora** da transação e marcada;
 *  - o backoff de D-022 é respeitado — mensagem agendada para o futuro não sai;
 *  - lease em vigor protege a linha de outro publisher, e **lease vencido não**
 *    (é o mecanismo que faz o cenário obrigatório de RF-24 funcionar);
 *  - falha de publicação reagenda e solta o lease, sem marcar publicada;
 *  - `attempts` acima do limite de D-008 **continua** sendo reivindicada (D-042);
 *  - publishers concorrentes sobre a mesma outbox não pegam a mesma mensagem.
 *
 * Sem mock em ponto nenhum (EL-08): o claim vai ao PostgreSQL real e a publicação
 * ao LocalStack real, com a mensagem lida de volta da fila para conferir corpo,
 * `MessageGroupId` e `MessageDeduplicationId` (D-040). A única falha injetada é
 * um endpoint que **de fato** recusa conexão — indisponibilidade de verdade, não
 * um duplo que finge lançar.
 *
 * Cada arquivo de teste usa uma fila própria: a fila do LocalStack sobrevive
 * entre arquivos, e contar mensagens numa fila compartilhada leria como defeito
 * o que é só resíduo do arquivo anterior.
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
import type { RetryPolicy } from "../../src/domain/retry-policy.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import { readSqsEnv } from "../../src/infrastructure/config/sqs-env.ts";
import type { EventPublisher } from "../../src/infrastructure/messaging/event-publisher.ts";
import { OutboxClaimStore } from "../../src/infrastructure/messaging/outbox-claim-store.ts";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher.ts";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher.ts";
import { ensureQueue } from "../../src/infrastructure/messaging/sqs-queue-provisioner.ts";
import { MikroOutboxRepository } from "../../src/infrastructure/persistence/repositories/mikro-outbox-repository.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";

let orm: MikroORM;
let sqs: SQSClient;
let filaNome: string;
let filaUrl: string;

/**
 * Curva determinística e curta.
 *
 * `random: () => 0` fixa o equal jitter no **piso** — o atraso vira exatamente
 * `capped / 2`, então o teste pode afirmar o valor em vez de aceitar um
 * intervalo. Continua sendo a curva de D-022: o que muda são os números, que
 * D-008 tornou parametrizáveis justamente para isto.
 */
const CURVA_CURTA: RetryPolicy = { baseDelayMs: 20, maxDelayMs: 40, random: () => 0 };

/** UUIDv7 (D-014). */
function novoId(): string {
  return Bun.randomUUIDv7();
}

function unico(prefixo: string): string {
  return `${prefixo}-${novoId()}`;
}

/** SQL cru, para semear e inspecionar colunas que o mapeamento não expõe. */
async function sql(
  query: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.getConnection().execute<Record<string, unknown>[]>(query, params);
}

/**
 * Um evento de integração de verdade, montado pelo domínio.
 *
 * `Wallet.open` é pura — não toca banco — e devolve o lançamento que
 * `WalletBalanceChanged.from` exige por D-018. O payload que vai para a fila é
 * então o **envelope real** de RF-07, não um objeto inventado no teste: é o que
 * torna a conferência do corpo da mensagem significativa.
 */
function eventoDeSaldo(): WalletBalanceChanged {
  const walletId = novoId();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
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

/** Enfileira um evento na outbox, pelo repositório de produção. */
async function semearMensagem(): Promise<OutboxMessage> {
  const mensagem = OutboxMessage.enqueue({ id: novoId(), event: eventoDeSaldo() });

  await orm.em.transactional(async (em) => {
    await new MikroOutboxRepository(em).insert(mensagem);
  });

  return mensagem;
}

/** A linha crua, para conferir as colunas de entrega. */
async function linhaDe(id: string): Promise<Record<string, unknown>> {
  const [linha] = await sql(
    `select attempts, next_attempt_at, published_at, locked_by, locked_until
       from outbox_messages where id = ?`,
    [id],
  );

  if (linha === undefined) {
    throw new Error(`linha de outbox ${id} não existe`);
  }

  return linha;
}

/** Um worker pronto, com identidade própria — cada publisher é uma "instância". */
function workerCom(
  publisher: EventPublisher,
  overrides: { batchSize?: number; leaseMs?: number } = {},
): OutboxPublisher {
  return new OutboxPublisher(
    new OutboxClaimStore(orm.em),
    publisher,
    { now: () => new Date() },
    CURVA_CURTA,
    {
      instanceId: unico("worker"),
      batchSize: overrides.batchSize ?? 10,
      leaseMs: overrides.leaseMs ?? 30_000,
      pollIntervalMs: 5,
    },
  );
}

/**
 * Recebe e apaga mensagens da fila até esgotar ou atingir o esperado.
 *
 * Apagar é necessário em fila FIFO: sem `DeleteMessage`, o grupo fica bloqueado e
 * a leitura seguinte devolveria a mesma mensagem.
 */
async function drenarFila(esperado: number): Promise<Message[]> {
  const recebidas: Message[] = [];

  for (let tentativa = 0; tentativa < 20 && recebidas.length < esperado; tentativa += 1) {
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

/** Esvazia a fila sem esperar por nada — usado só na limpeza entre testes. */
async function limparFila(): Promise<void> {
  for (let tentativa = 0; tentativa < 10; tentativa += 1) {
    const resposta = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: filaUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }),
    );

    const mensagens = resposta.Messages ?? [];

    if (mensagens.length === 0) {
      return;
    }

    for (const mensagem of mensagens) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: filaUrl, ReceiptHandle: mensagem.ReceiptHandle }),
      );
    }
  }
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

  filaNome = `rt11-${novoId()}.fifo`;
  filaUrl = await ensureQueue(sqs, filaNome);
}, 120_000);

/**
 * Cada teste começa com outbox e fila vazias.
 *
 * Sem isso, uma mensagem que um teste deixou pendente de propósito — o lote
 * parcial, por exemplo — seria reivindicada pelo teste seguinte e a contagem de
 * `claimed` deixaria de significar o que o teste afirma. Nada aqui é atalho: o
 * `delete` só apaga a semeadura, e a limpeza da fila remove o que já saiu.
 */
beforeEach(async () => {
  await sql(`delete from outbox_messages`);
  await limparFila();
}, 60_000);

afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: filaUrl }));
  sqs.destroy();
  await orm.close(true);
}, 60_000);

describe("provisionamento idempotente da fila (D-041)", () => {
  it("criar a mesma fila duas vezes devolve a mesma URL", async () => {
    // É a propriedade que permite worker e preload de teste chamarem o mesmo
    // `ensureQueue` sem que a segunda chamada quebre ou recrie a fila.
    expect(await ensureQueue(sqs, filaNome)).toBe(filaUrl);
  });
});

describe("RT-11 — ciclo de publicação (RF-24, D-009, D-040, D-043)", () => {
  it("publica a mensagem devida, marca published_at e libera o lease", async () => {
    const mensagem = await semearMensagem();

    const resultado = await workerCom(new SqsEventPublisher(sqs, filaNome)).runOnce();

    expect(resultado).toEqual({ claimed: 1, published: 1, failed: 0 });

    const linha = await linhaDe(mensagem.id);

    expect(linha["published_at"]).not.toBeNull();
    // D-043: lease é sobre trabalho em andamento, e trabalho concluído não tem
    // lease. O par sai junto, sob pena de `ck_outbox_messages_lease_pair`.
    expect(linha["locked_by"]).toBeNull();
    expect(linha["locked_until"]).toBeNull();
    expect(linha["attempts"]).toBe(0);

    const [recebida] = await drenarFila(1);

    if (recebida === undefined) {
      throw new Error("a mensagem não chegou à fila — a publicação não aconteceu de verdade.");
    }

    // O corpo é o envelope de RF-07 tal como gravado na outbox: republicar
    // reidratando a classe de evento acoplaria a fila ao código vigente.
    expect(JSON.parse(recebida.Body ?? "null")).toEqual(mensagem.payload);
    expect(recebida.Attributes?.[MessageSystemAttributeName.MessageGroupId]).toBe(
      mensagem.aggregateId,
    );
    expect(recebida.Attributes?.[MessageSystemAttributeName.MessageDeduplicationId]).toBe(
      mensagem.id,
    );
  }, 60_000);

  it("não reivindica mensagem cujo backoff ainda não venceu (D-022)", async () => {
    const mensagem = await semearMensagem();
    await sql(`update outbox_messages set next_attempt_at = now() + interval '1 hour' where id = ?`, [
      mensagem.id,
    ]);

    expect(await workerCom(new SqsEventPublisher(sqs, filaNome)).runOnce()).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
    });

    expect((await linhaDe(mensagem.id))["published_at"]).toBeNull();
  }, 60_000);

  it("não reivindica mensagem com lease em vigor de outra instância", async () => {
    const mensagem = await semearMensagem();
    await sql(
      `update outbox_messages
          set locked_by = 'outra-instancia', locked_until = now() + interval '1 hour'
        where id = ?`,
      [mensagem.id],
    );

    expect(await workerCom(new SqsEventPublisher(sqs, filaNome)).runOnce()).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
    });

    expect((await linhaDe(mensagem.id))["locked_by"]).toBe("outra-instancia");
  }, 60_000);

  it("assume mensagem cujo lease venceu — o mecanismo de RF-24", async () => {
    const mensagem = await semearMensagem();
    // A instância que reivindicou morreu antes de publicar: é o passo (2) do
    // cenário obrigatório, e o lease vencido é o que permite o passo (3).
    await sql(
      `update outbox_messages
          set locked_by = 'instancia-morta', locked_until = now() - interval '1 second'
        where id = ?`,
      [mensagem.id],
    );

    expect(await workerCom(new SqsEventPublisher(sqs, filaNome)).runOnce()).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
    });

    const linha = await linhaDe(mensagem.id);

    expect(linha["published_at"]).not.toBeNull();
    expect(linha["locked_by"]).toBeNull();

    await drenarFila(1);
  }, 60_000);

  it("linha com attempts acima do limite de D-008 continua sendo publicada (D-042)", async () => {
    const mensagem = await semearMensagem();
    await sql(`update outbox_messages set attempts = 50 where id = ?`, [mensagem.id]);

    // Parar na 11ª tentativa deixaria de existir evento para uma transação
    // aplicada, e a invariante de D-034 passaria a ter exceção.
    expect(await workerCom(new SqsEventPublisher(sqs, filaNome)).runOnce()).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
    });

    expect((await linhaDe(mensagem.id))["published_at"]).not.toBeNull();

    await drenarFila(1);
  }, 60_000);

  it("respeita o tamanho do lote", async () => {
    await semearMensagem();
    await semearMensagem();
    await semearMensagem();

    const resultado = await workerCom(new SqsEventPublisher(sqs, filaNome), {
      batchSize: 2,
    }).runOnce();

    expect(resultado.claimed).toBe(2);

    await drenarFila(2);
  }, 60_000);
});

describe("RT-11 — falha de publicação (RF-24, D-022)", () => {
  it("reagenda, solta o lease e não marca publicada; a tentativa seguinte publica", async () => {
    const mensagem = await semearMensagem();

    // Indisponibilidade **real**: porta 1 recusa conexão. `maxAttempts: 1` evita
    // que o retry interno do SDK transforme a falha numa espera longa.
    const sqsMorto = new SQSClient({
      region: "us-east-1",
      endpoint: "http://127.0.0.1:1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
    });

    try {
      const falha = await workerCom(new SqsEventPublisher(sqsMorto, filaNome)).runOnce();

      expect(falha).toEqual({ claimed: 1, published: 0, failed: 1 });
    } finally {
      sqsMorto.destroy();
    }

    const depoisDaFalha = await linhaDe(mensagem.id);

    expect(depoisDaFalha["published_at"]).toBeNull();
    expect(depoisDaFalha["attempts"]).toBe(1);
    expect(depoisDaFalha["next_attempt_at"]).not.toBeNull();
    // O lease sai na falha para que o **agendamento**, e não o prazo do lease,
    // decida quando a próxima tentativa acontece.
    expect(depoisDaFalha["locked_by"]).toBeNull();
    expect(depoisDaFalha["locked_until"]).toBeNull();

    // `CURVA_CURTA` com jitter no piso: 20ms de base, atraso de 10ms.
    await Bun.sleep(60);

    expect(await workerCom(new SqsEventPublisher(sqs, filaNome)).runOnce()).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
    });

    expect((await linhaDe(mensagem.id))["published_at"]).not.toBeNull();

    await drenarFila(1);
  }, 60_000);
});

describe("RT-11 — publishers concorrentes sobre a mesma outbox (RF-24, RI-08)", () => {
  it("quatro publishers disputando vinte mensagens publicam cada uma exatamente uma vez", async () => {
    const TOTAL = 20;
    const PUBLISHERS = 4;

    const semeadas = new Set<string>();

    for (let indice = 0; indice < TOTAL; indice += 1) {
      semeadas.add((await semearMensagem()).id);
    }

    /**
     * Registra o que cada publisher publicou, **sem substituir** a publicação:
     * delega ao `SqsEventPublisher` real e só anota o id.
     *
     * A anotação é a prova direta de "não pegam a mesma mensagem". Contar
     * mensagens na fila não serviria: o `MessageDeduplicationId` de D-040 faria
     * o próprio SQS absorver a segunda publicação e esconder o defeito.
     */
    const publicadas: string[] = [];
    const real = new SqsEventPublisher(sqs, filaNome);
    const registrador: EventPublisher = {
      publish: async (mensagem) => {
        await real.publish(mensagem);
        publicadas.push(mensagem.id);
      },
    };

    const workers = Array.from({ length: PUBLISHERS }, () =>
      workerCom(registrador, { batchSize: 3 }),
    );

    // Cada publisher varre em laço até a outbox esvaziar. Ciclos simultâneos são
    // o ponto: é o `SKIP LOCKED` do banco que decide quem fica com qual linha.
    await Promise.all(
      workers.map(async (worker) => {
        for (let ciclo = 0; ciclo < 40 && publicadas.length < TOTAL; ciclo += 1) {
          await worker.runOnce();
        }
      }),
    );

    expect(publicadas).toHaveLength(TOTAL);
    // Conjunto do mesmo tamanho da lista: nenhuma mensagem publicada duas vezes.
    expect(new Set(publicadas).size).toBe(TOTAL);
    expect(new Set(publicadas)).toEqual(semeadas);

    const [{ pendentes } = { pendentes: "-1" }] = await sql(
      `select count(*)::text as pendentes from outbox_messages where published_at is null`,
    );

    expect(pendentes).toBe("0");

    const [{ presas } = { presas: "-1" }] = await sql(
      `select count(*)::text as presas from outbox_messages where locked_by is not null`,
    );

    // Nenhuma linha ficou com lease pendurado depois de publicada (D-043).
    expect(presas).toBe("0");

    expect(await drenarFila(TOTAL)).toHaveLength(TOTAL);
  }, 120_000);
});
