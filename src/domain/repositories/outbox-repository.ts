import type { OutboxMessage } from "../outbox-message.ts";

/**
 * Persistência dos eventos pendentes de publicação (RF-06, RF-23, EL-06, D-027).
 *
 * O `insert` acontece na **mesma transação SQL** que altera saldo e ledger — é
 * o que torna a publicação atômica com o dinheiro e o que impede EL-06. Esta
 * porta não publica nada e não conhece SQS: quem publica é o worker de E-10,
 * lendo daqui depois do commit.
 */
export interface OutboxRepository {
  /** Enfileira o evento junto com a transação financeira (RF-23). */
  insert(message: OutboxMessage): Promise<void>;

  /** Lê uma linha por id. */
  findById(id: string): Promise<OutboxMessage | undefined>;

  /** Persiste tentativas, agendamento, publicação e lease (D-009). */
  update(message: OutboxMessage): Promise<void>;
}
