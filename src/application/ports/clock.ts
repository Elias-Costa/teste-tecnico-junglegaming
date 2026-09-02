/**
 * Fonte do instante corrente para a camada de aplicação (D-014, E-03).
 *
 * O domínio já recebe todo instante por parâmetro — `createdAt`, `at`,
 * `receivedAt` — e quem os preenche é o use case. Esta porta é o outro lado
 * dessa decisão: o use case também não lê o relógio direto, o que permite fixar
 * o tempo num teste **sem** substituir banco nem fila (EL-08 continua intacta).
 */
export interface Clock {
  /** Instante corrente. Uma chamada por transação — ver `ProcessWagerTransaction`. */
  now(): Date;
}
