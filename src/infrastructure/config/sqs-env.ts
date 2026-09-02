/**
 * Configuração de acesso ao SQS, no mesmo padrão do módulo de banco (D-011):
 * lê do ambiente, e tanto o Docker Compose quanto o Testcontainers apenas
 * populam essas variáveis. Nenhum consumidor sabe qual dos dois provisionou.
 */

/** Endereço e credenciais de um SQS alcançável — LocalStack em desenvolvimento. */
export interface SqsEnv {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Fila de **saída** dos eventos de integração (D-040).
   *
   * O enunciado (§10) nomeia só as filas de entrada, `wager-transactions.fifo` e
   * a DLQ dela; o destino da publicação da outbox era lacuna e foi fechado em
   * D-040. Fila própria, e não a de entrada: comando que chega e evento que sai
   * são contratos distintos, e reaproveitar a fila de entrada faria o consumidor
   * de E-11 ler os próprios eventos.
   *
   * O sufixo `.fifo` não é cosmético — é o que faz `ensureQueue` criar a fila
   * como FIFO (D-041), e o que obriga cada publicação a levar `MessageGroupId`.
   */
  eventsQueueName: string;
}

/**
 * Lê a configuração do SQS do ambiente, com o Compose local como padrão.
 *
 * As credenciais padrão são fictícias de propósito: o LocalStack não valida
 * assinatura. Nenhum segredo real entra aqui nem no `.env.example`.
 */
export function readSqsEnv(): SqsEnv {
  return {
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    region: process.env.AWS_REGION ?? "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    eventsQueueName: process.env.SQS_EVENTS_QUEUE ?? "wagering-events.fifo",
  };
}
