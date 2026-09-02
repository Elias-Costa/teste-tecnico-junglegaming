import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueAttributeName,
  QueueNameExists,
  type SQSClient,
} from "@aws-sdk/client-sqs";

/** Sufixo que a AWS exige no nome de toda fila FIFO. */
const FIFO_SUFFIX = ".fifo";

/** Dead-letter queue de uma fila, com o limite de entregas de D-008. */
export interface DeadLetterOptions {
  /** Nome da DLQ. Provisionada por esta mesma função, antes da fila de origem. */
  queueName: string;
  /** `maxReceiveCount` da redrive policy (D-008: 5 por padrão). */
  maxReceiveCount: number;
}

/** O que `ensureQueue` aceita além do nome. */
export interface EnsureQueueOptions {
  /**
   * Quando presente, a fila nasce com redrive policy apontando para esta DLQ.
   *
   * A DLQ é criada **antes** da origem — a redrive policy carrega o ARN dela, e
   * um ARN de fila inexistente é recusado pelo SQS.
   */
  deadLetter?: DeadLetterOptions | undefined;
}

/**
 * Garante que a fila existe e devolve a URL dela (D-041).
 *
 * O LocalStack sobe **vazio** e o `docker-compose.yml` não tem init hook: sem
 * este passo, o worker falharia com "fila inexistente" tanto no loop de
 * desenvolvimento quanto na suíte. Um módulo idempotente chamado pelos dois
 * caminhos mantém a intercambiabilidade de D-011 — nem o worker nem o teste
 * sabem quem provisionou — e deixa nome e atributos da fila com **uma** fonte
 * de verdade, em vez de um script de Compose e um preload de teste que precisam
 * concordar entre si.
 *
 * `CreateQueue` é idempotente quando os atributos batem: chamar de novo devolve
 * a URL existente. Só quando a fila existe com atributos **diferentes** a AWS
 * responde `QueueNameExists`, e aí a leitura da URL é a resposta certa — recriar
 * seria destruir fila alheia por causa de uma divergência de configuração.
 *
 * **Limitação conhecida, e é o preço de não recriar fila alheia:** se a fila já
 * existe com atributos diferentes — sem a redrive policy de D-046, por exemplo —
 * esta função devolve a URL existente **sem** corrigir os atributos. Uma fila
 * provisionada por engano antes desta versão precisa ser removida à mão. Foi
 * preferido a `SetQueueAttributes` silencioso, que sobrescreveria configuração
 * que alguém pode ter posto ali de propósito.
 *
 * @returns a URL da fila, pronta para `SendMessage`/`ReceiveMessage`.
 */
export async function ensureQueue(
  client: SQSClient,
  queueName: string,
  options: EnsureQueueOptions = {},
): Promise<string> {
  const attributes = {
    ...attributesFor(queueName),
    ...(options.deadLetter === undefined
      ? {}
      : await redriveAttributeFor(client, options.deadLetter)),
  };

  try {
    const created = await client.send(
      new CreateQueueCommand({ QueueName: queueName, Attributes: attributes }),
    );

    if (created.QueueUrl === undefined) {
      throw new Error(`SQS aceitou criar "${queueName}" mas não devolveu QueueUrl.`);
    }

    return created.QueueUrl;
  } catch (error) {
    if (!(error instanceof QueueNameExists)) {
      throw error;
    }

    return resolveQueueUrl(client, queueName);
  }
}

/**
 * Lê a URL de uma fila já existente.
 *
 * Separado de `ensureQueue` porque também serve a quem só quer publicar numa
 * fila provisionada por outro processo — o caso de uma instância que sobe depois
 * da primeira.
 */
export async function resolveQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const found = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));

  if (found.QueueUrl === undefined) {
    throw new Error(`SQS não devolveu QueueUrl para a fila "${queueName}".`);
  }

  return found.QueueUrl;
}

/**
 * Lê o ARN de uma fila já provisionada.
 *
 * Necessário porque a redrive policy referencia a DLQ por **ARN**, e o que o
 * resto do sistema carrega é nome e URL. É a única consulta de atributo que o
 * provisionamento faz.
 */
export async function resolveQueueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [QueueAttributeName.QueueArn],
    }),
  );

  const arn = attributes.Attributes?.[QueueAttributeName.QueueArn];

  if (arn === undefined) {
    throw new Error(`SQS não devolveu QueueArn para "${queueUrl}".`);
  }

  return arn;
}

/**
 * Provisiona a DLQ e monta o atributo `RedrivePolicy` da fila de origem (D-046).
 *
 * A DLQ é criada pelo **mesmo** `ensureQueue`, sem opções: uma DLQ não tem DLQ, e
 * a recursão para no primeiro nível. Ela herda o tipo pelo sufixo do nome, que é
 * o que satisfaz a exigência da AWS de que origem e DLQ sejam ambas FIFO ou ambas
 * standard.
 *
 * A policy vai como **string JSON** porque é assim que o SQS a recebe:
 * `Attributes` é `Partial<Record<QueueAttributeName, string>>`, e `maxReceiveCount`
 * viaja como texto mesmo sendo um número.
 */
async function redriveAttributeFor(
  client: SQSClient,
  deadLetter: DeadLetterOptions,
): Promise<Partial<Record<QueueAttributeName, string>>> {
  const dlqUrl = await ensureQueue(client, deadLetter.queueName);
  const dlqArn = await resolveQueueArn(client, dlqUrl);

  return {
    [QueueAttributeName.RedrivePolicy]: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: deadLetter.maxReceiveCount,
    }),
  };
}

/**
 * Atributos derivados do **nome**: `.fifo` no fim significa fila FIFO.
 *
 * A derivação pelo nome evita um segundo interruptor de configuração que pudesse
 * discordar do sufixo — e o sufixo não é opcional: a AWS recusa criar fila FIFO
 * sem ele.
 *
 * `ContentBasedDeduplication` fica **desligado** de propósito. D-040 publica um
 * `MessageDeduplicationId` explícito (o id da linha da outbox), que é estável
 * entre republicações do at-least-once de D-009 — hash do corpo daria o mesmo
 * resultado só por coincidência, e deixaria de dar se um campo volátil entrasse
 * no envelope algum dia.
 */
function attributesFor(queueName: string): Partial<Record<QueueAttributeName, string>> {
  return queueName.endsWith(FIFO_SUFFIX) ? { [QueueAttributeName.FifoQueue]: "true" } : {};
}
