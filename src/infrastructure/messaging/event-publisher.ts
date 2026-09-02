import type { OutboxMessage } from "../../domain/outbox-message.ts";

/**
 * Envio de uma linha da outbox para o barramento de eventos (RF-24, RF-25).
 *
 * Existe pelo mesmo motivo que `UnitOfWork` em D-028: separar **o que** o worker
 * faz de **com quem** ele fala. `OutboxPublisher` orquestra claim, publish e
 * marcação; quem conhece SQS, FIFO e `MessageGroupId` é o adaptador que
 * implementa esta porta.
 *
 * A porta recebe a `OutboxMessage` inteira, e não só o payload, porque D-040
 * deriva `MessageGroupId` do `aggregateId` e o dedup id do **id da linha** — dois
 * campos do envelope de entrega, não do conteúdo do evento.
 */
export interface EventPublisher {
  /**
   * Publica a mensagem. Rejeita quando o barramento não aceitou.
   *
   * A rejeição é o sinal que faz `OutboxPublisher` agendar o retry de D-022; um
   * adaptador que engolisse a falha faria a linha ser marcada como publicada sem
   * ter saído — a forma silenciosa de perder evento.
   */
  publish(message: OutboxMessage): Promise<void>;
}
