/**
 * E-16 — o serviço morto no meio do trabalho e reiniciado: **RT-21**.
 *
 * O último dos oito cenários da §13.3 do enunciado: "reinício do serviço com
 * comprovação da consistência final". Não é um teste de uma peça — é o teste de
 * que as peças, juntas, sobrevivem a um processo desaparecendo no pior instante
 * possível.
 *
 * O que a morte abrupta de uma instância deixa para trás, e que a próxima precisa
 * absorver sozinha:
 *
 *  - uma mensagem **commitada e não confirmada**, que o SQS vai reentregar (RT-18
 *    isola esse caso; aqui ele acontece no meio de tudo o mais);
 *  - mensagens ainda **não consumidas**, esperando na fila;
 *  - linhas de outbox **por publicar**, algumas com o `locked_by` de uma
 *    instância que nunca vai voltar para soltá-las (D-009, D-043).
 *
 * Nenhum desses estados está em memória. É essa a razão de o teste existir: a
 * instância que reinicia **não compartilha nada** com a que morreu — nem identity
 * map, nem lease, nem "já processei". Tudo o que ela tem é o banco e a fila, que
 * é exatamente o que RI-03, RI-08 e EL-05 exigem que baste.
 *
 * A carga entra pela **fila**, e não por HTTP, de propósito: matar o processo no
 * meio do consumo é o que produz os três estados acima de uma vez. Por HTTP, o
 * cliente saberia quais requisições falharam, e o cenário viraria "reenviar o que
 * não respondeu" — que é um teste mais fácil e menos parecido com o que acontece.
 *
 * A morte é `SIGKILL`, que nenhum gancho intercepta — nem no Linux, nem no
 * Windows, onde qualquer sinal vira terminação forçada. É o oposto do
 * encerramento ordenado de RF-22, que `workers-module.test.ts` prova; aqui o
 * ponto é justamente **não** haver encerramento.
 *
 * Dois processos de sistema operacional (`tests/support/service-instance.ts`,
 * que sobe o mesmo `WorkersModule` de `src/main.ts`), PostgreSQL e LocalStack
 * reais, sem mock em ponto nenhum (EL-08).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  MessageSystemAttributeName,
  QueueAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  debitosDe,
  expectLedgerReconciles,
  MOEDA,
  novoId,
  saldoDe,
  semearCarteira,
  transacoesDe,
  unico,
} from "../support/concurrency-harness.ts";

/**
 * Vinte apostas em `1000.00` de saldo: todas cabem.
 *
 * A escassez é assunto de RT-15 e RT-17. Aqui, misturar rejeição por saldo com
 * recuperação de crash tornaria a contagem final dependente da **ordem** em que o
 * reinício processou as mensagens — e o que se quer provar é o contrário disso:
 * que o desfecho não depende de quem processou o quê, nem de quando morreu.
 */
const APOSTAS = 20;
const SALDO_INICIAL = "1000.00";
const VALOR_DA_APOSTA = "10.00";
const SALDO_FINAL = "800.00";

/**
 * Lease curto (D-008), para que o `locked_by` que a morte deixa pendurado seja
 * reivindicável dentro do teste em vez de nos 30 s do default.
 */
const LEASE_CURTO_MS = 2_000;

/** Visibility timeout curto: a mensagem em voo na hora da morte volta em segundos. */
const VISIBILIDADE_SEG = 3;

/** Prazo para uma instância anunciar que está servindo. */
const PRAZO_DE_BOOT_MS = 60_000;

/** Prazo para a instância que reinicia terminar o trabalho que a outra deixou. */
const PRAZO_DE_RECUPERACAO_MS = 120_000;

let orm: MikroORM;
let sqs: SQSClient;
let filaNome: string;
let filaUrl: string;
let dlqNome: string;
let dlqUrl: string;
let eventosNome: string;
let eventosUrl: string;

/** Uma instância do serviço viva: o processo e a URL onde ela atende. */
interface Servico {
  processo: Bun.Subprocess<"pipe", "inherit", "inherit">;
  baseUrl: string;
}

/**
 * Todo processo filho que este arquivo criou.
 *
 * Existe por um defeito observado, não por precaução: uma instância do serviço
 * que sobreviva ao arquivo continua consumindo a fila e reivindicando a outbox
 * do **mesmo** PostgreSQL, e os arquivos de teste seguintes passam a disputar
 * dinheiro com um processo que ninguém sabe que existe. O sintoma é falha
 * inexplicável em suíte que não foi tocada.
 */
const filhos: Bun.Subprocess[] = [];

async function sql(
  query: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.getConnection().execute<Record<string, unknown>[]>(query, params);
}

/** Um inteiro lido de uma consulta de contagem. */
async function contar(query: string, params: readonly unknown[] = []): Promise<number> {
  const [linha] = await sql(query, params);

  return typeof linha?.["total"] === "number" ? linha["total"] : -1;
}

/** O envelope da §10, com identidade própria por aposta. */
function envelope(carteira: CarteiraSemeada, indice: number): Record<string, unknown> {
  const externalTransactionId = `ext-rt21-${String(indice)}-${novoId()}`;

  return {
    messageId: `msg-rt21-${String(indice)}-${novoId()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-rt21",
      externalTransactionId,
      idempotencyKey: `provider-rt21:${externalTransactionId}`,
      playerId: carteira.playerId,
      walletId: carteira.id,
      roundId: unico("round"),
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: VALOR_DA_APOSTA, currency: MOEDA },
    },
  };
}

/**
 * Enfileira as apostas, todas no **mesmo** grupo FIFO.
 *
 * O grupo é a wallet, que é o agrupamento com significado: comandos do mesmo
 * agregado têm ordem, comandos de agregados distintos não precisam ter (RI-06).
 * Como efeito colateral desejável, a mensagem em voo na hora da morte bloqueia o
 * grupo até a visibilidade expirar — ou seja, o reinício precisa de fato esperar
 * e retomar, em vez de contornar a mensagem pendente.
 */
async function enfileirarApostas(carteira: CarteiraSemeada): Promise<void> {
  for (let indice = 0; indice < APOSTAS; indice += 1) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: filaUrl,
        MessageBody: JSON.stringify(envelope(carteira, indice)),
        MessageGroupId: carteira.id,
        MessageDeduplicationId: novoId(),
      }),
    );
  }
}

/** Quantas mensagens uma fila guarda, visíveis **e** em voo. */
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
 * Sobe uma instância do serviço em processo próprio.
 *
 * O ambiente é herdado inteiro — é assim que a conexão de D-011 atravessa —, com
 * as filas desta execução e os parâmetros curtos de D-008 por cima. `stderr`
 * herdado deixa uma falha de boot visível na saída do teste.
 */
async function subirServico(): Promise<Servico> {
  // Arquivo de anúncio próprio desta instância; ver `service-instance.ts` para o
  // motivo de o handshake não passar pelo stdout.
  const anuncioEm = join(tmpdir(), `rt21-anuncio-${novoId()}.json`);

  const processo = Bun.spawn({
    // `process.execPath` é o próprio Bun que roda a suíte — não depende de `bun`
    // estar no PATH do shell que invocou o teste.
    cmd: [process.execPath, `${import.meta.dir}/../support/service-instance.ts`],
    stdin: "pipe",
    // Herdados os dois: o stdout do serviço é o log estruturado de RNF-06, e
    // vê-lo na saída do teste é o que torna uma falha de boot diagnosticável.
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      SERVICE_ANNOUNCE_FILE: anuncioEm,
      SQS_TRANSACTIONS_QUEUE: filaNome,
      SQS_TRANSACTIONS_DLQ: dlqNome,
      SQS_EVENTS_QUEUE: eventosNome,
      CONSUMER_VISIBILITY_TIMEOUT_SEC: String(VISIBILIDADE_SEG),
      CONSUMER_WAIT_TIME_SEC: "1",
      // Uma mensagem por ciclo: dá ao teste uma janela larga para matar a
      // instância **no meio** do trabalho, em vez de depois dele.
      CONSUMER_BATCH_SIZE: "1",
      OUTBOX_LEASE_MS: String(LEASE_CURTO_MS),
      OUTBOX_POLL_INTERVAL_MS: "50",
    },
  });

  filhos.push(processo);

  await aguardar(
    async () => {
      // Morte no boot vira mensagem aqui, e não espera de 60 s por um arquivo
      // que nunca vai aparecer.
      if (processo.exitCode !== null) {
        throw new Error(
          `a instância do serviço morreu no boot com código ${String(processo.exitCode)}.`,
        );
      }

      // `Bun.file` **dentro** da condição, e não içado para fora: o `BunFile`
      // guarda o resultado do `stat`, então um handle reaproveitado responde
      // `false` para sempre — o arquivo aparece e o pai nunca vê.
      return Bun.file(anuncioEm).exists();
    },
    PRAZO_DE_BOOT_MS,
    "o anúncio de uma instância do serviço",
  );

  const payload: unknown = JSON.parse(await Bun.file(anuncioEm).text());

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("baseUrl" in payload) ||
    typeof payload.baseUrl !== "string"
  ) {
    throw new Error(`anúncio inesperado do serviço: ${JSON.stringify(payload)}`);
  }

  return { processo, baseUrl: payload.baseUrl };
}

/** Recebe e apaga mensagens de uma fila — `DeleteMessage` é obrigatório em FIFO. */
async function drenarFila(url: string, esperado: number): Promise<Message[]> {
  const recebidas: Message[] = [];

  for (let tentativa = 0; tentativa < 40 && recebidas.length < esperado; tentativa += 1) {
    const resposta = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: [MessageSystemAttributeName.All],
      }),
    );

    for (const mensagem of resposta.Messages ?? []) {
      recebidas.push(mensagem);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: mensagem.ReceiptHandle }));
    }
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

  // Filas próprias desta execução: as filas do LocalStack sobrevivem entre
  // arquivos de teste, e contar mensagens numa fila compartilhada leria resíduo
  // como defeito. A de **eventos** precisa existir antes de o serviço subir:
  // `SqsEventPublisher.fromEnv()` não provisiona nada — quem provisiona é o
  // consumidor, e só as filas de entrada (D-041).
  filaNome = `rt21-${novoId()}.fifo`;
  dlqNome = `rt21-dlq-${novoId()}.fifo`;
  eventosNome = `rt21-ev-${novoId()}.fifo`;
  dlqUrl = await ensureQueue(sqs, dlqNome);
  eventosUrl = await ensureQueue(sqs, eventosNome);
  filaUrl = await ensureQueue(sqs, filaNome, {
    deadLetter: { queueName: dlqNome, maxReceiveCount: readRetryEnv().consumerMaxReceiveCount },
  });
}, 180_000);

afterAll(async () => {
  // **Antes de qualquer outra coisa**: nenhum filho pode sobreviver a este
  // arquivo. Um caso que falha no meio deixa a instância viva, e ela continuaria
  // consumindo a fila e reivindicando a outbox enquanto o arquivo de teste
  // seguinte tenta usar o mesmo banco.
  for (const filho of filhos) {
    filho.kill(9);
    await filho.exited;
  }

  for (const url of [filaUrl, dlqUrl, eventosUrl]) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  }

  sqs.destroy();
  await orm.close(true);
}, 60_000);

describe("RT-21 — reinício do serviço com consistência final (RI-03, RI-08, EL-03, EL-05, EL-06)", () => {
  it(
    "a instância morta no meio do trabalho é substituída, e nada duplica nem se perde",
    async () => {
      const carteira = await semearCarteira(orm, SALDO_INICIAL);

      await enfileirarApostas(carteira);

      // (1) A primeira instância sobe e começa a consumir.
      const primeira = await subirServico();

      // (2) Esperar, **observando o banco**, o trabalho começar de verdade: sem
      // isso, matar o processo cedo demais provaria só que uma instância limpa
      // processa uma fila cheia, que não é o cenário.
      await aguardar(
        async () => (await debitosDe(orm, carteira.id)).length > 0,
        PRAZO_DE_BOOT_MS,
        "a primeira instância aplicar o primeiro débito",
      );

      // (3) Morte abrupta. `SIGKILL` não é interceptável em lugar nenhum, então
      // o `onApplicationShutdown` de RF-22 **não** roda — que é o ponto.
      primeira.processo.kill(9);
      await primeira.processo.exited;

      const debitosAntes = (await debitosDe(orm, carteira.id)).length;

      // Sem esta afirmação o teste passaria sem nunca ter havido recuperação: se
      // a primeira instância tivesse terminado tudo antes de morrer, a segunda
      // não teria nada a retomar e a suíte estaria verde sem provar nada.
      expect(debitosAntes).toBeGreaterThan(0);
      expect(debitosAntes).toBeLessThan(APOSTAS);

      // (4) A segunda instância: processo novo, sem nenhuma memória da primeira.
      const segunda = await subirServico();

      expect(segunda.processo.pid).not.toBe(primeira.processo.pid);

      // (5) O reinício retoma tudo: fila de entrada esvaziada e outbox drenada —
      // inclusive as linhas cujo lease a primeira instância levou consigo.
      await aguardar(
        async () => (await naFila(filaUrl)) === 0,
        PRAZO_DE_RECUPERACAO_MS,
        "a segunda instância esvaziar a fila de entrada",
      );
      await aguardar(
        async () =>
          (await contar(
            `select count(*)::int as total from outbox_messages where published_at is null`,
          )) === 0,
        PRAZO_DE_RECUPERACAO_MS,
        "a segunda instância drenar a outbox",
      );

      // Encerramento **ordenado** desta, ao contrário da primeira (RF-22).
      await segunda.processo.stdin.end();
      await segunda.processo.exited;

      // (6) A consistência final.
      const debitos = await debitosDe(orm, carteira.id);

      // Nem uma aposta perdida, nem uma aplicada duas vezes (EL-03).
      expect(debitos).toHaveLength(APOSTAS);
      expect(debitos.every((entry) => entry.amount === VALOR_DA_APOSTA)).toBe(true);
      expect((await saldoDe(orm, carteira.id)).toJSON()).toEqual({
        amount: SALDO_FINAL,
        currency: MOEDA,
      });

      // A segunda instância de fato completou o que a primeira deixou.
      expect(debitos.length).toBeGreaterThan(debitosAntes);

      // Toda submissão virou transação terminal auditável, mais a `OPENING`.
      const transacoes = await transacoesDe(orm, carteira.id);
      const apostas = transacoes.filter((linha) => linha.kind === WagerTransactionKind.Bet);

      expect(apostas).toHaveLength(APOSTAS);
      expect(
        apostas.filter((linha) => linha.status === WagerTransactionStatus.Processed),
      ).toHaveLength(APOSTAS);

      // Cada mensagem foi processada uma vez só, e a inbox é quem sabe disso —
      // ela está no banco, que é o único lugar que sobreviveu ao crash (EL-04).
      expect(
        await contar(`select count(*)::int as total from inbox_messages`),
      ).toBe(APOSTAS);

      // Nada foi descartado no caminho: crash não é erro permanente.
      expect(await naFila(dlqUrl)).toBe(0);

      // Nenhum lease pendurado, incluindo o que a primeira instância levou (D-043).
      expect(
        await contar(
          `select count(*)::int as total from outbox_messages where locked_by is not null`,
        ),
      ).toBe(0);

      // (7) Os eventos saíram, e cada linha da outbox saiu **uma** vez. A
      // republicação após o lease vencido é absorvida pelo
      // `MessageDeduplicationId` de D-040, que é o id da linha — então uma
      // publicação a mais apareceria como um id repetido, não como uma mensagem
      // a mais.
      const linhasDeOutbox = await contar(
        `select count(*)::int as total from outbox_messages`,
      );
      const publicadas = await drenarFila(eventosUrl, linhasDeOutbox);

      expect(publicadas).toHaveLength(linhasDeOutbox);
      // A fila fica vazia depois do dreno: sem esta linha, uma publicação a mais
      // passaria despercebida, porque `drenarFila` para ao atingir o esperado.
      expect(await naFila(eventosUrl)).toBe(0);
      expect(
        new Set(
          publicadas.map(
            (mensagem) =>
              mensagem.Attributes?.[MessageSystemAttributeName.MessageDeduplicationId] ?? "",
          ),
        ).size,
      ).toBe(linhasDeOutbox);

      // A invariante final da §6.4, que é o que o enunciado cobra ao dizer
      // "comprovação da consistência final": o saldo persistido é exatamente o
      // que o ledger reconstrói, somando os 20 débitos sobre a abertura.
      await expectLedgerReconciles(orm, carteira.id);
    },
    360_000,
  );
});
