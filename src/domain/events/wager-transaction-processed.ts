import type { MoneyProps } from "../money.ts";
import type { WagerTransaction, WagerTransactionKind } from "../wager-transaction.ts";
import { IntegrationEvent, type EventContext } from "./integration-event.ts";

/**
 * Payload de `WagerTransactionProcessed` (RF-25).
 *
 * Repete os campos de identidade em vez de herdar de uma base comum aos três
 * eventos de transação: cada payload é um contrato versionado por conta própria
 * (`version` no tipo), e uma base compartilhada faria uma alteração em um evento
 * mudar os outros dois em silêncio — o oposto do que a versão existe para evitar.
 */
export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Id **interno** da referência, quando houve (`REFUND`/`ROLLBACK`, RN-07). */
  referenceTransactionId?: string;
}

/**
 * Publicado para **qualquer** transação aplicada, inclusive `LOSS` (RF-25).
 *
 * "Inclusive `LOSS`" é o ponto que o enunciado destaca: `LOSS` não move saldo e
 * não gera lançamento (RN-03), mas é uma transação aplicada e o provedor precisa
 * saber que ela foi aceita. Sem este evento, a única operação sem efeito no saldo
 * seria indistinguível, para quem está de fora, de uma que se perdeu.
 */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  /** Monta o evento a partir da transação já marcada como `PROCESSED`. */
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const data: WagerTransactionProcessedData = {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      // Chave omitida quando não há referência, para que a forma em memória seja
      // a mesma que `JSON.stringify` grava no payload da outbox.
      ...(transaction.referenceTransactionId === undefined
        ? {}
        : { referenceTransactionId: transaction.referenceTransactionId }),
    };

    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    });
  }
}
