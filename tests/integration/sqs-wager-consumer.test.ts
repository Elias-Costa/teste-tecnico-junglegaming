/**
 * E-11 — o consumidor SQS contra PostgreSQL e LocalStack reais: **RT-10** e **RT-12**.
 *
 * O que se prova aqui, em ordem de importância:
 *
 *  - **RF-18** — a fila entra pelo **mesmo** use case da API. Uma aposta submetida
 *    por mensagem move saldo, ledger, transação e outbox exatamente como a
 *    submetida por HTTP, e nenhuma regra vive só do lado da fila.
 *  - **RF-19 / RT-10** — a mesma mensagem entregue duas vezes produz **um** débito.
 *    Nos dois sentidos que importam: a reentrega genuína da mesma entrega, e o
 *    reenvio do produtor com `MessageId` de transporte novo, que é o caso que
 *    D-044 comprou ao usar o `messageId` do corpo.
 *  - **RF-20 / D-047** — com o PostgreSQL **de fato** inalcançável, a mensagem
 *    volta para a fila e o banco fica com **zero** linhas. Não há transação
 *    queimada, porque não há transação: E-07 insere já no estado terminal, então
 *    o rollback não deixa rastro. É a prova por ausência que corrigiu o roteiro.
 *  - **RF-21 / D-046 / D-048** — as três classificações têm três destinos, e o
 *    critério é "deixou rastro ou não deixou": rejeição com linha e evento dá
 *    `ack`; wallet inexistente e payload malformado vão à DLQ na **primeira**
 *    entrega, sem gastar as cinco de D-008.
 *  - **RT-12** — o limite de tentativas é respeitado: uma falha transitória que
 *    não cede chega à DLQ pela redrive policy, sem envio explícito.
 *  - **RF-22** — parando no meio de um lote, a mensagem em andamento termina e as
 *    intocadas voltam à fila **imediatamente**. Nenhuma presa, nenhuma perdida.
 *
 * **Sem mock em ponto nenhum** (EL-08). A indisponibilidade do banco é um segundo
 * `MikroORM` apontado para uma porta fechada — `ECONNREFUSED` de verdade, vindo
 * do driver de verdade, no mesmo espírito do endpoint recusado que E-10 usou para
 * o SQS. O único envoltório do arquivo **observa** o handler real sem substituí-lo,
 * como o registrador de `outbox-publisher-instance.ts`.
 *
 * Fila própria por arquivo: a fila do LocalStack sobrevive entre arquivos, e
 * contar mensagens numa fila compartilhada leria como defeito o que é só resíduo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  QueueAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { InboxLookup } from "../../src/application/inbox-lookup.ts";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction.ts";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import type { RetryPolicy } from "../../src/domain/retry-policy.ts";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction.ts";
import { buildClientUrl, readDatabaseEnv } from "../../src/infrastructure/config/database-env.ts";
import { readSqsEnv } from "../../src/infrastructure/config/sqs-env.ts";
import type {
  MessageDisposition,
  MessageHandler,
  ReceivedMessage,
} from "../../src/infrastructure/messaging/message-handler.ts";
import {
  ensureQueue,
  resolveQueueUrl,
} from "../../src/infrastructure/messaging/sqs-queue-provisioner.ts";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs-wager-consumer.ts";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { SystemClock } from "../../src/infrastructure/system-clock.ts";
import { UuidV7IdGenerator } from "../../src/infrastructure/uuid-v7-id-generator.ts";
import { WAGER_TRANSACTIONS_CONSUMER } from "../../src/interface/messaging/consumer-name.ts";
import { WagerMessageHandler } from "../../src/interface/messaging/wager-message-handler.ts";
import {
  type CarteiraSemeada,
  comPrazo,
  debitosDe,
  eventosDe,
  expectLedgerReconciles,
  novoId,
  saldoDe,
  semearCarteira,
  transacoesDe,
  unico,
} from "../support/concurrency-harness.ts";

let orm: MikroORM;
/** ORM apontado para porta fechada — a indisponibilidade real de RF-20/RT-12. */
let ormQuebrado: MikroORM;
let sqs: SQSClient;
let filaNome: string;
let filaUrl: string;
let dlqNome: string;
let dlqUrl: string;

/**
 * Limite de entregas curto, para RT-12 caber num teste.
 *
 * É a propriedade que D-008 comprou ao parametrizar: o mecanismo é o mesmo da
 * produção — redrive policy do SQS —, só o número muda. Com o default 5 e o piso
 * de 1 s do backoff, o teste levaria quase um minuto.
 */
const MAX_ENTREGAS = 2;

/** Jitter no piso e curva curta: o retorno da mensagem custa 1 s, não 1 minuto. */
const CURVA_CURTA: RetryPolicy = { baseDelayMs: 10, maxDelayMs: 20, random: () => 0 };

/** SQL cru, para inspecionar colunas que o mapeamento não expõe. */
async function sql(
  query: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.getConnection().execute<Record<string, unknown>[]>(query, params);
}

/** O handler de produção, ligado ao banco que se quiser. */
function handlerSobre(alvo: MikroORM): WagerMessageHandler {
  const unitOfWork = new MikroUnitOfWork(alvo.em);

  return new WagerMessageHandler(
    new ProcessWagerTransaction(unitOfWork, new SystemClock(), new UuidV7IdGenerator()),
    new InboxLookup(unitOfWork),
  );
}

/** O consumidor de produção sobre a fila deste arquivo. */
function consumidorCom(handler: MessageHandler, batchSize = 10): SqsWagerConsumer {
  return new SqsWagerConsumer(sqs, handler, CURVA_CURTA, {
    queueUrl: filaUrl,
    deadLetterQueueUrl: dlqUrl,
    batchSize,
    visibilityTimeoutSec: 30,
    // Sem long polling: o teste já sabe que a mensagem está lá, e esperar 20 s
    // por ciclo transformaria a suíte inteira em espera.
    waitTimeSec: 0,
  });
}

/** O envelope da §10, com a identidade que cada cenário precisar fixar. */
function envelope(
  carteira: CarteiraSemeada,
  overrides: { messageId?: string; amount?: string; walletId?: string } = {},
): Record<string, unknown> {
  const externalTransactionId = unico("ext");

  return {
    messageId: overrides.messageId ?? unico("msg"),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: carteira.playerId,
      walletId: overrides.walletId ?? carteira.id,
      roundId: unico("round"),
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: overrides.amount ?? "25.00", currency: "BRL" },
    },
  };
}

/** Publica um corpo na fila de entrada. FIFO exige os dois campos. */
async function enviar(corpo: unknown, grupo = "grupo-unico"): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: filaUrl,
      MessageBody: JSON.stringify(corpo),
      MessageGroupId: grupo,
      MessageDeduplicationId: novoId(),
    }),
  );
}

/** Esvazia uma fila sem esperar por nada — limpeza entre testes. */
async function limparFila(url: string): Promise<void> {
  for (let tentativa = 0; tentativa < 10; tentativa += 1) {
    const resposta = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
    );

    const mensagens = resposta.Messages ?? [];

    if (mensagens.length === 0) {
      return;
    }

    for (const mensagem of mensagens) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: mensagem.ReceiptHandle }));
    }
  }
}

/**
 * Recebe o que estiver visível numa fila, **sem** apagar.
 *
 * Só serve para afirmar que a fila está **vazia**: uma mensagem recebida e não
 * apagada fica em voo pelo visibility timeout e, numa fila FIFO, **bloqueia o
 * `MessageGroupId` inteiro** — o teste seguinte não veria a própria mensagem.
 * Onde o teste espera encontrar algo, o certo é `drenar`.
 */
async function espiar(url: string): Promise<Message[]> {
  const resposta = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
  );

  return resposta.Messages ?? [];
}

/**
 * Espera até a fila entregar algo e **apaga** o que veio, dentro do prazo.
 *
 * Apagar é o que impede o grupo FIFO de ficar bloqueado para o teste seguinte —
 * o mesmo cuidado que `drenarFila` toma em `outbox-publisher.test.ts`. A espera é
 * por estado observado, nunca por `sleep`: o backoff de D-022 e o relógio do
 * LocalStack não são previsíveis o bastante, e um `sleep` que passa na máquina
 * rápida e falha na lenta é pior que teste nenhum.
 */
async function drenar(url: string, prazoMs: number): Promise<Message[]> {
  const inicio = Date.now();

  while (Date.now() - inicio < prazoMs) {
    const mensagens = await espiar(url);

    if (mensagens.length > 0) {
      for (const mensagem of mensagens) {
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: mensagem.ReceiptHandle }),
        );
      }

      return mensagens;
    }
  }

  return [];
}

/** Linhas da inbox de um `messageId` — a prova de RF-19 no banco. */
async function inboxDe(messageId: string): Promise<Record<string, unknown>[]> {
  return sql(
    `select consumer_name, message_id, processed_at from inbox_messages where message_id = ?`,
    [messageId],
  );
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  // `MikroORM.init` **não** conecta (verificado em `node_modules`: o método só
  // descobre metadata). O `ECONNREFUSED` acontece na primeira query, que é
  // exatamente onde o consumidor precisa vê-lo.
  ormQuebrado = await MikroORM.init({
    ...buildOrmConfig(),
    clientUrl: buildClientUrl({ ...readDatabaseEnv(), port: 1 }),
  });

  const env = readSqsEnv();
  sqs = new SQSClient({
    region: env.region,
    endpoint: env.endpoint,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });

  const sufixo = novoId();
  filaNome = `rt10-${sufixo}.fifo`;
  dlqNome = `rt10-${sufixo}-dlq.fifo`;
  filaUrl = await ensureQueue(sqs, filaNome, {
    deadLetter: { queueName: dlqNome, maxReceiveCount: MAX_ENTREGAS },
  });
  dlqUrl = await resolveQueueUrl(sqs, dlqNome);
}, 180_000);

beforeEach(async () => {
  await limparFila(filaUrl);
  await limparFila(dlqUrl);
}, 60_000);

afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: filaUrl }));
  await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
  sqs.destroy();
  await ormQuebrado.close(true);
  await orm.close(true);
}, 60_000);

describe("provisionamento da fila de entrada (D-041, D-046)", () => {
  it("a fila nasce com a redrive policy de D-008 apontando para a DLQ", async () => {
    const atributos = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: filaUrl,
        AttributeNames: [QueueAttributeName.RedrivePolicy],
      }),
    );

    const policy = atributos.Attributes?.[QueueAttributeName.RedrivePolicy];

    // Sem esta policy, RT-12 provaria só metade: o envio explícito de D-046
    // funcionaria e o esgotamento de entregas não teria para onde ir.
    expect(policy).toBeDefined();
    expect(policy).toContain(dlqNome);
    expect(policy).toContain(String(MAX_ENTREGAS));
  });
});

describe("RF-18 / RF-20 — a fila entra pelo mesmo use case da API", () => {
  it("uma aposta pela fila move saldo, ledger, transação e outbox", async () => {
    const carteira = await semearCarteira(orm, "100.00");
    const corpo = envelope(carteira);

    await enviar(corpo);

    const resultado = await consumidorCom(handlerSobre(orm)).runOnce();

    expect(resultado).toMatchObject({ received: 1, acked: 1, retried: 0, deadLettered: 0 });

    // O mesmo desfecho que a entrada HTTP produz — é o ponto de RF-18.
    expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe("75.00");
    expect(await debitosDe(orm, carteira.id)).toHaveLength(1);
    expect(await eventosDe(orm, carteira.id)).toContain("WalletBalanceChanged");

    const transacoes = await transacoesDe(orm, carteira.id);
    const aposta = transacoes.find((linha) => linha.kind === WagerTransactionKind.Bet);
    expect(aposta?.status).toBe(WagerTransactionStatus.Processed);

    await expectLedgerReconciles(orm, carteira.id);
  }, 60_000);

  it("a inbox é gravada na mesma transação, já processada (RF-19, RF-23)", async () => {
    const carteira = await semearCarteira(orm, "100.00");
    const corpo = envelope(carteira);

    await enviar(corpo);
    await consumidorCom(handlerSobre(orm)).runOnce();

    const linhas = await inboxDe(String(corpo["messageId"]));

    // `processed_at` preenchido significa que a transação financeira **commitou**:
    // a linha é gravada dentro dela. É o que autoriza o `ack` de uma reentrega.
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.["consumer_name"]).toBe(WAGER_TRANSACTIONS_CONSUMER);
    expect(linhas[0]?.["processed_at"]).not.toBeNull();
  }, 60_000);

  it("o `ack` apaga a mensagem — e só depois do commit (RF-20)", async () => {
    const carteira = await semearCarteira(orm, "100.00");

    await enviar(envelope(carteira));
    await consumidorCom(handlerSobre(orm)).runOnce();

    // Não existe caminho no consumidor que apague antes de o handler retornar; o
    // que este teste fixa é o outro lado — depois do commit, a mensagem some.
    expect(await espiar(filaUrl)).toHaveLength(0);
  }, 60_000);
});

describe("RF-19 / RT-10 — inbox e redelivery não duplicam efeito (EL-03, EL-04)", () => {
  it("a mesma entrega processada duas vezes produz um débito só", async () => {
    const carteira = await semearCarteira(orm, "100.00");
    const corpo = envelope(carteira);
    const handler = handlerSobre(orm);

    // Reentrega **genuína**: o mesmo corpo levado ao handler de produção duas
    // vezes, que é literalmente o que acontece quando o `ack` se perde entre o
    // commit e o `DeleteMessage`. Nada é simulado.
    const primeira = await handler.handle(entrega(corpo));
    const segunda = await handler.handle(entrega(corpo));

    expect(primeira).toBe("ack");
    expect(segunda).toBe("ack");

    expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe("75.00");
    expect(await debitosDe(orm, carteira.id)).toHaveLength(1);
    expect(await inboxDe(String(corpo["messageId"]))).toHaveLength(1);

    await expectLedgerReconciles(orm, carteira.id);
  }, 60_000);

  it("o reenvio do produtor também é deduplicado — o caso que D-044 comprou", async () => {
    const carteira = await semearCarteira(orm, "100.00");
    const messageId = unico("msg");

    // Dois `SendMessage` distintos: o SQS atribui `MessageId` de transporte
    // **diferente** para cada um. Só o `messageId` do corpo é igual, e é ele que
    // deduplica (D-044) — com o id de transporte como chave, este caso passaria
    // batido pela inbox e cairia inteiro sobre a `idempotencyKey`.
    await enviar(envelope(carteira, { messageId }));
    await enviar(envelope(carteira, { messageId }));

    const consumidor = consumidorCom(handlerSobre(orm));
    await consumidor.runOnce();
    await consumidor.runOnce();

    expect(await debitosDe(orm, carteira.id)).toHaveLength(1);
    expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe("75.00");
    expect(await inboxDe(messageId)).toHaveLength(1);

    await expectLedgerReconciles(orm, carteira.id);
  }, 60_000);
});

describe("RF-21 / D-048 — três classificações, três destinos", () => {
  it("rejeição de negócio com linha e evento dá `ack`", async () => {
    const carteira = await semearCarteira(orm, "100.00");

    await enviar(envelope(carteira, { amount: "500.00" }));

    const resultado = await consumidorCom(handlerSobre(orm)).runOnce();

    // Deixou rastro: linha `REJECTED` e `WagerTransactionRejected` na outbox. O
    // provedor fica sabendo pelo evento, então o `ack` fecha o assunto (D-048).
    expect(resultado).toMatchObject({ acked: 1, deadLettered: 0, retried: 0 });

    const aposta = (await transacoesDe(orm, carteira.id)).find(
      (linha) => linha.kind === WagerTransactionKind.Bet,
    );
    expect(aposta?.status).toBe(WagerTransactionStatus.Rejected);
    expect(aposta?.failureCode).toBe(BusinessFailureCode.InsufficientFunds);

    // O `aggregateId` de `WagerTransactionRejected` é a **transação**, não a
    // wallet: o saldo não mudou, então não há agregado de wallet a anunciar.
    expect(await eventosDe(orm, aposta?.id ?? "")).toContain("WagerTransactionRejected");
    expect(await debitosDe(orm, carteira.id)).toHaveLength(0);
    expect(await espiar(filaUrl)).toHaveLength(0);

    await expectLedgerReconciles(orm, carteira.id);
  }, 60_000);

  it("wallet inexistente vai à DLQ em vez de sumir (D-031, D-048)", async () => {
    const carteira = await semearCarteira(orm, "100.00");

    await enviar(envelope(carteira, { walletId: novoId() }));

    const resultado = await consumidorCom(handlerSobre(orm)).runOnce();

    // D-031 impede a linha (a FK recusa), então não há evento nem resposta. `ack`
    // aqui apagaria a mensagem sem deixar traço em lugar nenhum — a DLQ é a única
    // superfície que sobra.
    expect(resultado).toMatchObject({ acked: 0, deadLettered: 1 });
    expect(await drenar(dlqUrl, 10_000)).toHaveLength(1);
  }, 60_000);

  it("payload malformado vai à DLQ na **primeira** entrega (D-046)", async () => {
    await enviar({ nada: "disto é um envelope" });

    const resultado = await consumidorCom(handlerSobre(orm)).runOnce();

    // Um único ciclo. Gastar as 5 entregas de D-008 com um payload que nunca vai
    // passar bloquearia o `MessageGroupId` inteiro — e numa fila FIFO isso atrasa
    // operações de agregados que nada têm com o defeito.
    expect(resultado).toMatchObject({ deadLettered: 1 });
    expect(await drenar(dlqUrl, 10_000)).toHaveLength(1);
    expect(await espiar(filaUrl)).toHaveLength(0);
  }, 60_000);
});

describe("RF-20 / D-047 — erro transitório não queima transação nenhuma", () => {
  it("PostgreSQL inalcançável devolve a mensagem e não escreve nada", async () => {
    const carteira = await semearCarteira(orm, "100.00");
    const corpo = envelope(carteira);

    await enviar(corpo);

    // Indisponibilidade **de verdade**: porta fechada, `ECONNREFUSED` do driver.
    const resultado = await consumidorCom(handlerSobre(ormQuebrado)).runOnce();

    expect(resultado).toMatchObject({ received: 1, acked: 0, retried: 1, deadLettered: 0 });

    // Nada foi escrito — e é essa **ausência** que corrigiu o roteiro em D-047. A
    // transação não fica em `PENDING`: ela não existe, porque E-07 insere já no
    // estado terminal e o rollback levou tudo. Status nenhum foi tocado (D-013).
    const apostas = (await transacoesDe(orm, carteira.id)).filter((l) => l.kind === WagerTransactionKind.Bet);
    expect(apostas).toHaveLength(0);
    expect(await debitosDe(orm, carteira.id)).toHaveLength(0);
    expect(await inboxDe(String(corpo["messageId"]))).toHaveLength(0);
    expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe("100.00");

    // A mensagem continua na fila: sem commit não há `ack` (RF-20).
    expect(await comPrazo(esperarVisivel(filaUrl, 15_000), 20_000, "retorno da mensagem")).toBe(1);

    await expectLedgerReconciles(orm, carteira.id);
  }, 90_000);
});

describe("RT-12 — limite de tentativas respeitado, mensagem chega à DLQ", () => {
  it("falha transitória que não cede chega à DLQ pela redrive policy", async () => {
    const carteira = await semearCarteira(orm, "100.00");

    await enviar(envelope(carteira));

    // Nenhum envio explícito aqui: o erro é **transitório**, então o consumidor
    // devolve a mensagem toda vez. Quem a move é o SQS, ao ultrapassar o
    // `maxReceiveCount` da redrive policy — o limite de D-008 sendo respeitado.
    const consumidor = consumidorCom(handlerSobre(ormQuebrado));
    const inicio = Date.now();
    let naDlq: Message[] = [];

    while (Date.now() - inicio < 45_000 && naDlq.length === 0) {
      const resultado = await consumidor.runOnce();

      // Nenhum envio explícito em momento nenhum: o desfecho é sempre `retry`.
      expect(resultado.deadLettered).toBe(0);

      // Um prazo curto por volta: enquanto a mensagem estiver invisível pelo
      // backoff, nem a origem nem a DLQ entregam nada, e o laço só tenta de novo.
      naDlq = await drenar(dlqUrl, 2_000);
    }

    expect(naDlq).toHaveLength(1);
    // E o banco continua intocado durante todo o percurso até a DLQ.
    expect(await debitosDe(orm, carteira.id)).toHaveLength(0);
  }, 90_000);
});

describe("RF-22 — encerramento gracioso: nada preso, nada perdido", () => {
  it("a mensagem em andamento termina e as intocadas voltam à fila na hora", async () => {
    const carteira = await semearCarteira(orm, "300.00");

    // Grupos distintos: numa fila FIFO, mensagens do mesmo grupo são entregues
    // uma a uma, e o lote de três nunca chegaria junto.
    for (let i = 0; i < 3; i += 1) {
      await enviar(envelope(carteira), `grupo-${String(i)}`);
    }

    const real = handlerSobre(orm);
    // Preenchido logo abaixo, quando o consumidor existir. O laço só é executado
    // depois disso, então a indireção nunca é observada pelo teste.
    let pedirParada: () => Promise<void> = () => Promise.resolve();

    // Observador, não substituto: delega ao handler de produção e só **então**
    // pede o encerramento — o mesmo recurso que E-10 usou para registrar o que foi
    // publicado sem trocar o publisher (EL-08).
    const pedeParadaApos1: MessageHandler = {
      handle: async (mensagem: ReceivedMessage): Promise<MessageDisposition> => {
        const desfecho = await real.handle(mensagem);
        await pedirParada();

        return desfecho;
      },
    };

    const consumidor = consumidorCom(pedeParadaApos1, 10);
    pedirParada = () => consumidor.stop();

    const resultado = await consumidor.runOnce();

    // A primeira foi até o fim (o `ack` aconteceu **depois** do commit) e as
    // outras voltaram com visibilidade zero, em vez de ficarem invisíveis pelos
    // 30 s do visibility timeout.
    expect(resultado.acked).toBe(1);
    expect(resultado.released).toBe(resultado.received - 1);

    const devolvidas = await comPrazo(
      esperarVisivel(filaUrl, 15_000),
      20_000,
      "devolução das mensagens intocadas",
    );

    // Nada preso, nada perdido: o que virou linha mais o que voltou à fila soma
    // exatamente as três mensagens enviadas.
    const apostas = (await transacoesDe(orm, carteira.id)).filter((l) => l.kind === WagerTransactionKind.Bet);
    expect(apostas.length + devolvidas).toBe(3);

    await expectLedgerReconciles(orm, carteira.id);
  }, 90_000);
});

/** Uma entrega, na forma que o handler recebe do transporte. */
function entrega(corpo: unknown): ReceivedMessage {
  return { body: JSON.stringify(corpo), transportMessageId: novoId() };
}

/** Quantas mensagens voltaram a ficar visíveis na fila, dentro do prazo. */
async function esperarVisivel(url: string, prazoMs: number): Promise<number> {
  return (await drenar(url, prazoMs)).length;
}
