/**
 * E-16 — recuperação após reinicialização: **RT-13**.
 *
 * `workers-module.test.ts` prova que os três laços sobem e que `close()` os
 * desliga. O que faltava é o passo seguinte, e é o que RT-13 nomeia: **subir de
 * novo**. Um serviço que retoma trabalho pendente é diferente de um serviço que
 * apenas trabalha, e a diferença só aparece quando existe um segundo boot.
 *
 * Os três casos são três formas diferentes de o trabalho sobreviver ao processo,
 * e todas têm a mesma resposta: o estado está no **banco**.
 *
 *  1. **Outbox com lease pendurado** de uma instância que não volta (D-009,
 *     D-043). É o estado que a morte abrupta de RT-21 produz, aqui isolado.
 *  2. **`PENDING_REFERENCE` criada antes do boot** (RF-26, RN-15). O worker que
 *     a resolve não é o processo que a criou, e nem precisa ser.
 *  3. **Inbox atravessando o reinício** (RF-19, EL-04). A mesma mensagem
 *     reentregue depois do restart não move dinheiro de novo — e quem sabe que
 *     ela já foi processada é uma tabela, não uma estrutura em memória que o
 *     `close()` levou junto.
 *
 * O serviço subido é o `WorkersModule` de produção, o mesmo módulo raiz de
 * `src/main.ts`, contra PostgreSQL e LocalStack reais (EL-08). Nada é
 * substituído: o que o teste faz é ligar e desligar o processo em volta do
 * estado que ele precisa encontrar.
 *
 * Filas próprias do arquivo, porque as do LocalStack sobrevivem entre arquivos de
 * teste e contar mensagens numa fila compartilhada leria resíduo como defeito.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  QueueAttributeName,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction.ts";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.ts";
import { Money } from "../../src/domain/money.ts";
import { OutboxMessage } from "../../src/domain/outbox-message.ts";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import { readRetryEnv } from "../../src/infrastructure/config/retry-env.ts";
import { readSqsEnv } from "../../src/infrastructure/config/sqs-env.ts";
import { ensureQueue } from "../../src/infrastructure/messaging/sqs-queue-provisioner.ts";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { MikroOutboxRepository } from "../../src/infrastructure/persistence/repositories/mikro-outbox-repository.ts";
import type { WagerTransactionRow } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import { wagerTransactionRowSchema } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import { SystemClock } from "../../src/infrastructure/system-clock.ts";
import { UuidV7IdGenerator } from "../../src/infrastructure/uuid-v7-id-generator.ts";
import { WorkersModule } from "../../src/interface/workers/workers.module.ts";
import {
  aguardar,
  type CarteiraSemeada,
  comandoDeAposta,
  debitosDe,
  eventosDe,
  expectLedgerReconciles,
  MOEDA,
  novoId,
  saldoDe,
  semearCarteira,
  unico,
} from "../support/concurrency-harness.ts";

/** Prazo para o serviço reiniciado retomar o que ficou pendente. */
const PRAZO_DE_RECUPERACAO_MS = 30_000;

let orm: MikroORM;
let sqs: SQSClient;
let filaNome: string;
let filaUrl: string;
let dlqNome: string;
let dlqUrl: string;
let eventosNome: string;
let eventosUrl: string;

/**
 * Ambiente ajustado para o arquivo, com os originais guardados.
 *
 * Todos são parâmetros de D-008 — filas e cadências. O mecanismo é o de
 * produção; o que muda são os números, que é a propriedade que a parametrização
 * comprou. `CONSUMER_WAIT_TIME_SEC` em especial: `stop()` aguarda o
 * `ReceiveMessage` em voo (RF-22), e com o default de 20 s cada um dos vários
 * encerramentos deste arquivo custaria isso.
 */
const ambienteOriginal = new Map<string, string | undefined>();

function ajustarAmbiente(valores: Record<string, string>): void {
  for (const [chave, valor] of Object.entries(valores)) {
    if (!ambienteOriginal.has(chave)) {
      ambienteOriginal.set(chave, process.env[chave]);
    }

    process.env[chave] = valor;
  }
}

function restaurarAmbiente(): void {
  for (const [chave, valor] of ambienteOriginal) {
    if (valor === undefined) {
      // `Reflect.deleteProperty` em vez de `delete`: a chave é dinâmica, e o
      // `delete` sobre chave computada é banido pelo lint do projeto.
      Reflect.deleteProperty(process.env, chave);
    } else {
      process.env[chave] = valor;
    }
  }

  ambienteOriginal.clear();
}

/**
 * Sobe o serviço, roda o corpo e o encerra — o "reinício" de RT-13.
 *
 * `init()` dispara `onApplicationBootstrap`, que é onde os três laços começam;
 * `close()` dispara `onApplicationShutdown`, que é onde param (RF-22). Cada
 * chamada é um processo lógico distinto: o container do NestJS é novo, o
 * `EntityManager` é novo, e nada do boot anterior atravessa — que é exatamente a
 * condição sob a qual RT-13 quer ver o trabalho pendente ser retomado.
 */
async function comServicoNoAr<T>(corpo: () => Promise<T>): Promise<T> {
  const modulo = await Test.createTestingModule({ imports: [WorkersModule] }).compile();
  const app = modulo.createNestApplication();

  // Sem `listen()`: o que este arquivo observa são os laços, não as rotas.
  await app.init();

  try {
    return await corpo();
  } finally {
    await app.close();
  }
}

async function sql(
  query: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.getConnection().execute<Record<string, unknown>[]>(query, params);
}

/** Um evento de integração de verdade, montado pelo domínio (puro, sem tocar banco). */
function eventoDeSaldo(): WalletBalanceChanged {
  const { wallet, openingEntry } = Wallet.open({
    id: novoId(),
    playerId: unico("player"),
    initialBalance: Money.from({ amount: "10.00", currency: MOEDA }),
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
async function semearMensagemDeOutbox(): Promise<OutboxMessage> {
  const mensagem = OutboxMessage.enqueue({ id: novoId(), event: eventoDeSaldo() });

  await orm.em.transactional(async (em) => {
    await new MikroOutboxRepository(em).insert(mensagem);
  });

  return mensagem;
}

/** A linha da outbox, nas colunas que só o worker mexe. */
async function linhaDeOutbox(id: string): Promise<Record<string, unknown> | undefined> {
  const [linha] = await sql(
    `select published_at, locked_by, locked_until from outbox_messages where id = ?`,
    [id],
  );

  return linha;
}

/** A linha da transação, lida num `em` novo — o que o banco guardou. */
async function linhaDeTransacao(id: string): Promise<WagerTransactionRow | undefined> {
  return (
    (await orm.em
      .fork()
      .findOne(wagerTransactionRowSchema, { id }, { disableIdentityMap: true })) ?? undefined
  );
}

/** O envelope da §10, com a identidade que o cenário precisar fixar. */
function envelope(
  carteira: CarteiraSemeada,
  overrides: { messageId?: string; amount?: string } = {},
): Record<string, unknown> {
  const externalTransactionId = unico("ext");

  return {
    messageId: overrides.messageId ?? unico("msg"),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-rt13",
      externalTransactionId,
      idempotencyKey: `provider-rt13:${externalTransactionId}`,
      playerId: carteira.playerId,
      walletId: carteira.id,
      roundId: unico("round"),
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: overrides.amount ?? "25.00", currency: MOEDA },
    },
  };
}

/** Publica um corpo na fila de entrada. FIFO exige os dois campos. */
async function enviar(corpo: unknown, grupo: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: filaUrl,
      MessageBody: JSON.stringify(corpo),
      MessageGroupId: grupo,
      // Id de transporte **novo** a cada envio: é o que faz o reenvio chegar ao
      // consumidor em vez de ser absorvido pela deduplicação do próprio SQS —
      // o caso que D-044 comprou ao deduplicar pelo `messageId` do corpo.
      MessageDeduplicationId: novoId(),
    }),
  );
}

/** Quantas mensagens a fila guarda, visíveis **e** em voo. */
async function naFila(url: string): Promise<number> {
  const resposta = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        QueueAttributeName.ApproximateNumberOfMessages,
        QueueAttributeName.ApproximateNumberOfMessagesNotVisible,
      ],
    }),
  );

  const visiveis = resposta.Attributes?.[QueueAttributeName.ApproximateNumberOfMessages] ?? "0";
  const emVoo =
    resposta.Attributes?.[QueueAttributeName.ApproximateNumberOfMessagesNotVisible] ?? "0";

  return Number(visiveis) + Number(emVoo);
}

/** Linhas da inbox de um `messageId` — a prova de RF-19 no banco. */
async function inboxDe(messageId: string): Promise<Record<string, unknown>[]> {
  return sql(`select consumer_name, message_id, processed_at from inbox_messages where message_id = ?`, [
    messageId,
  ]);
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

  filaNome = `rt13-${novoId()}.fifo`;
  dlqNome = `rt13-dlq-${novoId()}.fifo`;
  eventosNome = `rt13-ev-${novoId()}.fifo`;
  dlqUrl = await ensureQueue(sqs, dlqNome);
  // A fila de eventos precisa existir antes de o serviço subir: o
  // `SqsEventPublisher.fromEnv()` não provisiona nada — quem provisiona é o
  // consumidor, e só as filas de entrada (D-041).
  eventosUrl = await ensureQueue(sqs, eventosNome);
  filaUrl = await ensureQueue(sqs, filaNome, {
    deadLetter: { queueName: dlqNome, maxReceiveCount: readRetryEnv().consumerMaxReceiveCount },
  });

  ajustarAmbiente({
    SQS_TRANSACTIONS_QUEUE: filaNome,
    SQS_TRANSACTIONS_DLQ: dlqNome,
    SQS_EVENTS_QUEUE: eventosNome,
    CONSUMER_WAIT_TIME_SEC: "1",
    CONSUMER_VISIBILITY_TIMEOUT_SEC: "3",
    OUTBOX_POLL_INTERVAL_MS: "50",
    PENDING_REFERENCE_POLL_INTERVAL_MS: "100",
  });
}, 180_000);

afterAll(async () => {
  restaurarAmbiente();

  for (const url of [filaUrl, dlqUrl, eventosUrl]) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  }

  sqs.destroy();
  await orm.close(true);
}, 60_000);

describe("RT-13 — outbox pendente atravessa o reinício (RF-24, D-009, D-043)", () => {
  it(
    "linha com lease de uma instância que não volta é publicada pelo serviço reiniciado",
    async () => {
      // Com o serviço **desligado**: a linha ficou reivindicada por uma instância
      // que morreu e nunca soltou o lease. É o estado exato que um `SIGKILL`
      // deixa, e sem alguém para reivindicá-la de novo o evento nunca sairia.
      const mensagem = await semearMensagemDeOutbox();

      await sql(
        `update outbox_messages
            set locked_by = 'instancia-que-nao-volta', locked_until = now() - interval '1 second'
          where id = ?`,
        [mensagem.id],
      );

      await comServicoNoAr(async () => {
        await aguardar(
          async () => (await linhaDeOutbox(mensagem.id))?.["published_at"] !== null,
          PRAZO_DE_RECUPERACAO_MS,
          "o serviço reiniciado publicar a linha com lease vencido",
        );
      });

      const linha = await linhaDeOutbox(mensagem.id);

      expect(linha?.["published_at"]).not.toBeNull();
      // O `UPDATE` de publicação limpa o par do lease (D-043) — sem isso, a linha
      // ficaria marcada como presa por uma instância inexistente para sempre.
      expect(linha?.["locked_by"]).toBeNull();
      expect(linha?.["locked_until"]).toBeNull();
    },
    120_000,
  );
});

describe("RT-13 — reversão pendente atravessa o reinício (RF-26, RN-15, D-054)", () => {
  it(
    "PENDING_REFERENCE criada antes do boot é resolvida pelo serviço reiniciado",
    async () => {
      const carteira = await semearCarteira(orm, "100.00");
      const useCase = new ProcessWagerTransaction(
        new MikroUnitOfWork(orm.em),
        new SystemClock(),
        new UuidV7IdGenerator(),
      );

      const rodada = unico("round");
      const extAposta = unico("ext-aposta");

      // Com o serviço **desligado**: o `ROLLBACK` chega antes da `BET` que ele
      // estorna e fica esperando (RN-15); depois a `BET` chega e é aplicada.
      // Quando o processo termina, sobra uma pendente resolvível e ninguém para
      // resolvê-la.
      const estorno = await useCase.execute(
        comandoDeAposta(carteira, "25.00", {
          kind: WagerTransactionKind.Rollback,
          roundId: rodada,
          referenceExternalTransactionId: extAposta,
        }),
      );

      expect(estorno.status).toBe(WagerTransactionStatus.PendingReference);

      const aposta = await useCase.execute(
        comandoDeAposta(carteira, "25.00", { roundId: rodada, externalTransactionId: extAposta }),
      );

      expect(aposta.status).toBe(WagerTransactionStatus.Processed);
      expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe("75.00");

      // O reinício: quem resolve a pendente é um `PendingReferenceWorker` que não
      // existia quando ela foi criada. Todo o contexto de que ele precisa —
      // referência, valor, moeda, correlação — veio da linha (D-052, D-055).
      await comServicoNoAr(async () => {
        await aguardar(
          async () =>
            (await linhaDeTransacao(estorno.transactionId))?.status ===
            WagerTransactionStatus.Processed,
          PRAZO_DE_RECUPERACAO_MS,
          "o serviço reiniciado resolver a reversão pendente",
        );
      });

      const linha = await linhaDeTransacao(estorno.transactionId);

      expect(linha?.status).toBe(WagerTransactionStatus.Processed);
      // RN-07: o id **interno** da referência, resolvido a partir do id externo.
      expect(linha?.referenceTransactionId).toBe(aposta.transactionId);
      // RN-05: estornar uma `BET` credita — o saldo volta ao que era.
      expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe("100.00");

      // RF-25: o desfecho publica o mesmo evento que publicaria se a reversão
      // tivesse chegado depois da `BET`.
      expect(await eventosDe(orm, estorno.transactionId)).toEqual([
        "WagerTransactionPendingReference",
        "WagerTransactionProcessed",
      ]);

      await expectLedgerReconciles(orm, carteira.id);
    },
    120_000,
  );
});

describe("RT-13 — a inbox atravessa o reinício (RF-19, EL-03, EL-04)", () => {
  it(
    "a mesma mensagem reentregue depois do restart não move dinheiro de novo",
    async () => {
      const carteira = await semearCarteira(orm, "100.00");
      const corpo = envelope(carteira);
      const messageId = String(corpo["messageId"]);
      const grupo = carteira.id;

      // Primeiro boot: a mensagem é consumida e processada.
      await comServicoNoAr(async () => {
        await enviar(corpo, grupo);
        await aguardar(
          async () => (await debitosDe(orm, carteira.id)).length === 1,
          PRAZO_DE_RECUPERACAO_MS,
          "o primeiro boot aplicar o débito",
        );
        await aguardar(
          async () => (await naFila(filaUrl)) === 0,
          PRAZO_DE_RECUPERACAO_MS,
          "o primeiro boot esvaziar a fila",
        );
      });

      expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe("75.00");
      expect(await inboxDe(messageId)).toHaveLength(1);

      // Com o serviço desligado, o produtor reenvia a **mesma** mensagem — o
      // caso normal de um at-least-once cujo `ack` se perdeu. O id de transporte
      // é novo; o `messageId` do corpo, que é a chave da inbox (D-044), é o mesmo.
      await enviar(corpo, grupo);

      // Segundo boot: processo novo, sem nenhuma memória do primeiro. A única
      // coisa que pode responder "isso já foi processado" é a tabela.
      await comServicoNoAr(async () => {
        await aguardar(
          async () => (await naFila(filaUrl)) === 0,
          PRAZO_DE_RECUPERACAO_MS,
          "o segundo boot absorver a reentrega",
        );
      });

      // O efeito não duplicou: é EL-03, e é EL-04 pelo mecanismo que o evitou.
      expect(await debitosDe(orm, carteira.id)).toHaveLength(1);
      expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe("75.00");
      expect(await inboxDe(messageId)).toHaveLength(1);
      expect(await eventosDe(orm, carteira.id)).toEqual(["WalletBalanceChanged"]);

      // Nada foi para a DLQ: reentrega é caminho normal, não falha.
      expect(await naFila(dlqUrl)).toBe(0);

      await expectLedgerReconciles(orm, carteira.id);
    },
    180_000,
  );
});
