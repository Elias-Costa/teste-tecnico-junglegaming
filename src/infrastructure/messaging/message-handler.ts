/**
 * Desfecho de **entrega** de uma mensagem consumida (RF-20, RF-21, D-046, D-048).
 *
 * Três valores, e são exatamente as três situações que RF-21 manda distinguir.
 * O nome fala de entrega, não de negócio, porque é isso que o transporte executa:
 * quem sabe se a aposta foi aceita é o evento publicado na outbox, não o `ack`.
 */
export type MessageDisposition =
  /**
   * Assunto encerrado: apaga a mensagem da fila.
   *
   * Vale para o sucesso, para a rejeição de negócio que **deixou linha e evento**
   * (D-048) e para a reentrega que a inbox reconheceu (RF-19). Nos três casos o
   * desfecho já está registrado em algum lugar que alguém consegue consultar.
   */
  | "ack"
  /**
   * Indisponibilidade momentânea: devolve a mensagem com backoff.
   *
   * Não toca o status de transação nenhuma (D-013) — na prática nem existe linha
   * para tocar, porque a transação inteira sofreu rollback (D-047). A mensagem
   * volta e o SQS a move para a DLQ se as entregas de D-008 se esgotarem.
   */
  | "retry"
  /**
   * Erro que reenviar não conserta: manda para a DLQ na primeira entrega.
   *
   * Payload malformado, kind ainda não suportado e os três erros de negócio que
   * **não deixam rastro** (D-048). Ir direto evita bloquear o `MessageGroupId`
   * por cinco entregas inúteis, que numa fila FIFO atrasa agregados sem relação.
   */
  | "dead-letter";

/** Uma mensagem recebida da fila, no que o handler precisa saber dela. */
export interface ReceivedMessage {
  /** Corpo cru. O handler é quem decide se é JSON válido — e o que fazer se não for. */
  body: string;
  /**
   * `MessageId` atribuído pelo SQS.
   *
   * **Não** é a chave da inbox (D-044) e não entra em decisão nenhuma: existe
   * para aparecer no diagnóstico de uma mensagem que o handler não conseguiu nem
   * abrir, quando o `messageId` do corpo é justamente o que falta.
   */
  transportMessageId: string;
}

/**
 * Quem transforma uma mensagem recebida num desfecho de entrega (RF-18, RF-21).
 *
 * Mesmo papel que `EventPublisher` cumpre na direção oposta: separa **o que** o
 * consumidor faz de **com quem** ele fala. O laço do SQS orquestra recebimento,
 * `DeleteMessage` e visibilidade; quem conhece o envelope do enunciado, o use
 * case e a taxonomia de erro é a borda que implementa esta porta.
 *
 * A porta devolve desfecho em vez de lançar: um erro que escapasse até o laço
 * teria de ser reclassificado lá, e a classificação passaria a existir em dois
 * lugares.
 */
export interface MessageHandler {
  /** Processa a mensagem e devolve o que o transporte deve fazer com ela. */
  handle(message: ReceivedMessage): Promise<MessageDisposition>;
}
