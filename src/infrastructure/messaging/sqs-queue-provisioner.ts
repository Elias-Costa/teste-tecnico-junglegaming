import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  QueueAttributeName,
  QueueNameExists,
  type SQSClient,
} from "@aws-sdk/client-sqs";

/** Sufixo que a AWS exige no nome de toda fila FIFO. */
const FIFO_SUFFIX = ".fifo";

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
 * @returns a URL da fila, pronta para `SendMessage`/`ReceiveMessage`.
 */
export async function ensureQueue(client: SQSClient, queueName: string): Promise<string> {
  try {
    const created = await client.send(
      new CreateQueueCommand({ QueueName: queueName, Attributes: attributesFor(queueName) }),
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
