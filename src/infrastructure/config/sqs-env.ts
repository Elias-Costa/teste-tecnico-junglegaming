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
  /**
   * Fila de **entrada** dos comandos de aposta (§10 do enunciado, RF-18).
   *
   * Este nome não foi decisão do candidato: o enunciado o escreve literalmente,
   * junto com o da DLQ. É a fila que o consumidor de E-11 lê, e é FIFO pelo
   * mesmo motivo que a de saída — o sufixo é o que faz `ensureQueue` criá-la
   * como tal (D-041).
   */
  transactionsQueueName: string;
  /**
   * Dead-letter queue da fila de entrada (RF-21, D-008, D-046).
   *
   * Recebe por dois caminhos, e os dois são esperados: o envio **explícito** do
   * consumidor quando o erro é permanente (D-046), e a redrive policy do SQS
   * quando um erro transitório esgota as 5 entregas de D-008. FIFO por
   * imposição da AWS: o par origem/DLQ precisa ter o mesmo tipo.
   */
  transactionsDlqName: string;
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
    transactionsQueueName: process.env.SQS_TRANSACTIONS_QUEUE ?? "wager-transactions.fifo",
    transactionsDlqName: process.env.SQS_TRANSACTIONS_DLQ ?? "wager-transactions-dlq.fifo",
  };
}
