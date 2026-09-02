import type { InboxMessage } from "../inbox-message.ts";

/**
 * Persistência da deduplicação de mensagens consumidas (RF-05, RF-19, EL-05, D-027).
 *
 * Não há `findById`: a identidade é o par `(consumerName, messageId)` (D-025),
 * e `findByKey` **é** a busca por chave primária. A dedupe é por consumidor —
 * a mesma mensagem entregue a dois consumidores é trabalho legítimo dos dois.
 */
export interface InboxRepository {
  /**
   * Registra uma mensagem recebida.
   *
   * A unicidade é do banco (RI-09): duas instâncias recebendo a mesma entrega
   * disputam este `insert`, e a perdedora recebe violação de chave primária.
   */
  insert(message: InboxMessage): Promise<void>;

  /** Busca pela identidade da mensagem. É a pergunta que abre o consumo em E-11. */
  findByKey(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;

  /** Persiste o `processedAt` de uma mensagem concluída. */
  update(message: InboxMessage): Promise<void>;
}
