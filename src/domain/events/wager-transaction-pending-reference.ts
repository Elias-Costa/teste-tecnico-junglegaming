import { MissingReferenceError } from "../errors/missing-reference-error.ts";
import type { MoneyProps } from "../money.ts";
import type { WagerTransaction, WagerTransactionKind } from "../wager-transaction.ts";
import { IntegrationEvent, type EventContext } from "./integration-event.ts";

/** Payload de `WagerTransactionPendingReference` (RF-25, RN-15). */
export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Referência **no provedor** que ainda não chegou (RN-07). */
  referenceExternalTransactionId: string;
}

/**
 * Publicado quando a referência ainda não chegou (RF-25, RN-15).
 *
 * Não é rejeição nem falha: `REFUND`/`ROLLBACK` podem chegar antes da `BET` que
 * referenciam, e a transação fica em `PENDING_REFERENCE` até o worker de RF-26
 * resolvê-la ou o TTL de D-008 esgotar. O evento existe para que o provedor
 * saiba que a operação foi **aceita e está aguardando** — sem ele, o silêncio
 * entre a submissão e o desfecho seria indistinguível de mensagem perdida.
 */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  /**
   * Monta o evento a partir da transação aguardando referência.
   *
   * @throws MissingReferenceError se a transação não tem referência. Reusa o erro
   * de D-020 em vez de criar um tipo novo porque é o mesmo fato — `REFUND`/
   * `ROLLBACK` sem referência —, aqui na forma de erro de programação: `create`
   * já barra esse caso, então chegar até aqui significa que alguém montou o
   * evento a partir de um kind que nunca deveria estar em `PENDING_REFERENCE`.
   */
  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    const reference = transaction.referenceExternalTransactionId;

    if (reference === undefined) {
      throw new MissingReferenceError(transaction.kind);
    }

    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        referenceExternalTransactionId: reference,
      },
    });
  }
}
