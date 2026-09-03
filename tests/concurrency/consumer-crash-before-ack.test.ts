/**
 * E-16 — o worker morto **depois do commit e antes do ack**: **RT-18**.
 *
 * É a outra ponta do que `outbox-publishers.test.ts` provou na saída. Lá, o
 * processo morria entre o commit do claim e a publicação (RF-24); aqui ele morre
 * entre o commit da **transação financeira** e o `DeleteMessage`, que é a janela
 * em que o SQS ainda considera a mensagem entregue e vai reentregá-la.
 *
 * O que está em jogo é a promessa de RF-20 lida ao contrário: `ack` depois do
 * commit significa que **existe** uma janela em que o dinheiro já se moveu e a
 * mensagem ainda vai voltar. A correção do sistema depende inteiramente de a
 * inbox (RF-19) reconhecer essa volta — e de a inbox estar no **banco**, não na
 * memória do processo que commitou, porque esse processo não existe mais quando a
 * mensagem é reentregue. É EL-03 e EL-04 no mesmo cenário.
 *
 * `tests/integration/sqs-wager-consumer.test.ts` já leva o mesmo corpo ao handler
 * duas vezes, e aquilo é reentrega genuína — mas **no mesmo processo**. Uma
 * solução que guardasse "já processei" num `Set` de módulo passaria lá e falharia
 * aqui, que é exatamente a distinção que EL-04 cobra.
 *
 * Dois processos de sistema operacional (`tests/support/wager-consumer-instance.ts`),
 * PostgreSQL e LocalStack reais, sem mock em ponto nenhum (EL-08). A única coisa
 * simulada é a **morte**, que é o cenário. Sincronização por anúncio do filho e
 * por estado observado na fila, nunca por `sleep`.
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
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction.ts";
import { readRetryEnv } from "../../src/infrastructure/config/retry-env.ts";
import { readSqsEnv } from "../../src/infrastructure/config/sqs-env.ts";
import { ensureQueue } from "../../src/infrastructure/messaging/sqs-queue-provisioner.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import {
  aguardar,
  type CarteiraSemeada,
  comPrazo,
  debitosDe,
  eventosDe,
  expectLedgerReconciles,
  lerLinha,
  MOEDA,
  novoId,
  saldoDe,
  semearCarteira,
  transacoesDe,
  unico,
} from "../support/concurrency-harness.ts";

/** Saldo semeado e valor da aposta: um débito só, e ele é o objeto da prova. */
const SALDO_INICIAL = "100.00";
const VALOR_DA_APOSTA = "25.00";
const SALDO_APOS_UM_DEBITO = "75.00";

/**
 * Visibility timeout curto, para que a reentrega caiba no teste.
 *
 * É a propriedade que D-008 comprou ao parametrizar os loops: a mensagem volta em
 * segundos **pelo mesmo mecanismo** da produção — o SQS expirando a visibilidade
 * de uma entrega sem `ack` —, sem relógio falso e sem substituto.
 */
const VISIBILIDADE_SEG = 3;

/** Prazo para um filho anunciar que está de pé. */
const PRAZO_DE_BOOT_MS = 60_000;

/** Prazo para a fila voltar a ficar vazia depois que a segunda instância assume. */
const PRAZO_DE_DRENO_MS = 60_000;

let orm: MikroORM;
let sqs: SQSClient;
let filaNome: string;
let filaUrl: string;
let dlqNome: string;
let dlqUrl: string;

/** Um consumidor vivo, em processo próprio. */
interface Consumidor {
  processo: Bun.Subprocess<"pipe", "pipe", "inherit">;
  instanceId: string;
}

/**
 * Todo processo filho que este arquivo criou.
 *
 * Um consumidor que sobreviva ao arquivo continua lendo a fila e movendo dinheiro
 * no **mesmo** PostgreSQL que o arquivo de teste seguinte vai usar. O sintoma
 * seria falha inexplicável numa suíte que ninguém tocou, e por isso a limpeza é
 * incondicional em vez de depender de o caso ter chegado ao fim.
 */
const filhos: Bun.Subprocess[] = [];

async function sql(
  query: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.getConnection().execute<Record<string, unknown>[]>(query, params);
}

/** O envelope da §10, com identidade própria. */
function envelope(carteira: CarteiraSemeada): Record<string, unknown> {
  const externalTransactionId = unico("ext");

  return {
    messageId: unico("msg"),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-rt18",
      externalTransactionId,
      idempotencyKey: `provider-rt18:${externalTransactionId}`,
      playerId: carteira.playerId,
      walletId: carteira.id,
      roundId: unico("round"),
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: VALOR_DA_APOSTA, currency: MOEDA },
    },
  };
}

/** Publica um corpo na fila de entrada. FIFO exige os dois campos. */
async function enviar(corpo: unknown): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: filaUrl,
      MessageBody: JSON.stringify(corpo),
      MessageGroupId: "grupo-rt18",
      MessageDeduplicationId: novoId(),
    }),
  );
}

/**
 * Quantas mensagens a fila guarda, visíveis **e** em voo.
 *
 * Somar as duas é o que torna a pergunta útil: uma mensagem entregue e não
 * apagada some das visíveis sem ter saído da fila, e é justamente esse o estado
 * que a morte do primeiro consumidor deixa.
 */
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

/**
 * Sobe um consumidor em processo próprio.
 *
 * O ambiente é herdado inteiro — é assim que a conexão de D-011 atravessa —, com
 * a fila desta execução e o visibility timeout curto por cima. `stderr` herdado
 * deixa uma falha de boot visível na saída do teste.
 */
function subirConsumidor(extra: Record<string, string> = {}): Consumidor {
  const instanceId = unico("consumidor");

  const processo = Bun.spawn({
    // `process.execPath` é o próprio Bun que roda a suíte — não depende de `bun`
    // estar no PATH do shell que invocou o teste.
    cmd: [process.execPath, `${import.meta.dir}/../support/wager-consumer-instance.ts`],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      SQS_TRANSACTIONS_QUEUE: filaNome,
      SQS_TRANSACTIONS_DLQ: dlqNome,
      CONSUMER_INSTANCE_ID: instanceId,
      CONSUMER_VISIBILITY_TIMEOUT_SEC: String(VISIBILIDADE_SEG),
      CONSUMER_WAIT_TIME_SEC: "1",
      CONSUMER_BATCH_SIZE: "1",
      ...extra,
    },
  });

  filhos.push(processo);

  return { processo, instanceId };
}

/** Lê uma linha de anúncio do filho e devolve o objeto JSON. */
async function lerAnuncio(
  consumidor: Consumidor,
  oQue: string,
): Promise<Record<string, unknown>> {
  const linha = await comPrazo(lerLinha(consumidor.processo.stdout), PRAZO_DE_BOOT_MS, oQue);
  const payload: unknown = JSON.parse(linha);

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`anúncio inesperado do consumidor: ${linha}`);
  }

  return { ...payload };
}

/** Encerra o consumidor pelo protocolo e devolve o relato de saída. */
async function encerrar(consumidor: Consumidor): Promise<Record<string, unknown>> {
  await consumidor.processo.stdin.end();

  const relato = await lerAnuncio(consumidor, "o relato de saída do consumidor");

  await consumidor.processo.exited;

  return relato;
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

  const env = readSqsEnv();
  sqs = new SQSClient({
    region: env.region,
    endpoint: env.endpoint,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });

  // Filas próprias desta execução: a fila do LocalStack sobrevive entre arquivos
  // de teste, e contar mensagens numa fila compartilhada leria resíduo como
  // defeito. Criadas pelo mesmo `ensureQueue` do consumidor (D-041), com a
  // redrive policy de D-008 — o filho a reencontra em vez de recriá-la.
  filaNome = `rt18-${novoId()}.fifo`;
  dlqNome = `rt18-dlq-${novoId()}.fifo`;
  dlqUrl = await ensureQueue(sqs, dlqNome);
  filaUrl = await ensureQueue(sqs, filaNome, {
    deadLetter: { queueName: dlqNome, maxReceiveCount: readRetryEnv().consumerMaxReceiveCount },
  });
}, 180_000);

afterAll(async () => {
  // **Antes de qualquer outra coisa**: nenhum filho pode sobreviver ao arquivo.
  for (const filho of filhos) {
    filho.kill(9);
    await filho.exited;
  }

  await sqs.send(new DeleteQueueCommand({ QueueUrl: filaUrl }));
  await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
  sqs.destroy();
  await orm.close(true);
}, 60_000);

describe("RT-18 — worker morto depois do commit e antes do ack (RF-19, RF-20, EL-03, EL-04)", () => {
  it(
    "a mensagem volta, outro processo a absorve e o débito continua sendo um só",
    async () => {
      const carteira = await semearCarteira(orm, SALDO_INICIAL);
      const corpo = envelope(carteira);
      const messageId = String(corpo["messageId"]);

      await enviar(corpo);

      // (1) A instância que morre: processa, commita e cai antes do `ack`.
      const morrendo = subirConsumidor({ CONSUMER_CRASH_AFTER_COMMIT: "1" });

      expect(await lerAnuncio(morrendo, "o anúncio da instância que vai morrer")).toMatchObject({
        ready: true,
        crashing: true,
      });

      const commit = await lerAnuncio(morrendo, "o anúncio de commit sem ack");

      // O handler classificou a entrega como `ack` — ou seja, o desfecho estava
      // registrado e a mensagem seria apagada no passo seguinte, que não houve.
      expect(commit["committed"]).toBe("ack");
      expect(await morrendo.processo.exited).toBe(1);

      // (2) O commit sobreviveu à morte: o dinheiro se moveu.
      expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe(SALDO_APOS_UM_DEBITO);
      expect(await debitosDe(orm, carteira.id)).toHaveLength(1);
      expect(await inboxDe(messageId)).toHaveLength(1);

      const [antes] = await inboxDe(messageId);

      // A inbox está no **banco**, e já marcada como processada. É o único lugar
      // onde a decisão de replay pode viver para que RT-18 tenha resposta: a
      // memória de quem decidiu foi embora com o processo (EL-04).
      expect(antes?.["processed_at"]).not.toBeNull();

      // (3) O `ack` não aconteceu: a mensagem continua na fila, invisível até o
      // visibility timeout vencer. Apagada, a soma seria zero e continuaria zero.
      await aguardar(
        async () => (await naFila(filaUrl)) === 1,
        30_000,
        "a mensagem continuar na fila depois da morte do consumidor",
      );

      // (4) Outra instância assume — processo novo, sem nenhuma memória da
      // primeira — e recebe a reentrega quando a visibilidade expira.
      const assumindo = subirConsumidor();

      expect(await lerAnuncio(assumindo, "o anúncio da instância que assume")).toMatchObject({
        ready: true,
        crashing: false,
      });

      expect(assumindo.processo.pid).not.toBe(morrendo.processo.pid);

      await aguardar(
        async () => (await naFila(filaUrl)) === 0,
        PRAZO_DE_DRENO_MS,
        "a fila esvaziar depois de a segunda instância assumir",
      );

      const relato = await encerrar(assumindo);

      // A segunda instância de fato **viu** a mensagem: sem esta afirmação, a
      // fila vazia também seria compatível com alguém tendo apagado a mensagem
      // sem processá-la, que é um jeito de passar no teste sem prová-lo.
      //
      // "Ao menos uma", e não "exatamente uma", porque o número de entregas é do
      // SQS, não do sistema: uma reentrega a mais é comportamento legítimo de uma
      // fila at-least-once. O que precisa valer independentemente dele é o
      // efeito, e é o que as asserções seguintes cobram.
      expect(relato["received"]).toBeGreaterThanOrEqual(1);
      expect(relato["acked"]).toBe(relato["received"]);

      // (5) O efeito não duplicou. É o coração de RT-18 e de EL-03.
      expect((await saldoDe(orm, carteira.id)).toJSON().amount).toBe(SALDO_APOS_UM_DEBITO);
      expect(await debitosDe(orm, carteira.id)).toHaveLength(1);
      expect(await inboxDe(messageId)).toHaveLength(1);

      // Uma transação de aposta só, mais a `OPENING` da semeadura.
      const transacoes = await transacoesDe(orm, carteira.id);

      expect(transacoes).toHaveLength(2);
      expect(
        transacoes.filter((linha) => linha.status === WagerTransactionStatus.Processed),
      ).toHaveLength(2);

      // Nem evento a mais (EL-06 pela outra face: a reentrega não republica).
      // A semeadura de `semearCarteira` não passa pelo use case de abertura, então
      // o único `WalletBalanceChanged` do agregado é o desta aposta.
      expect(await eventosDe(orm, carteira.id)).toEqual(["WalletBalanceChanged"]);

      const [aposta] = transacoes.filter((linha) => linha.kind === WagerTransactionKind.Bet);

      expect(await eventosDe(orm, aposta?.id ?? "")).toEqual(["WagerTransactionProcessed"]);

      // Nada foi parar na DLQ: a reentrega é caminho normal, não falha.
      expect(await naFila(dlqUrl)).toBe(0);

      // A invariante final da §6.4.
      await expectLedgerReconciles(orm, carteira.id);
    },
    240_000,
  );
});
