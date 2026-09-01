import type { BusinessFailureCode } from "../failure-code.ts";
import type { MoneyProps } from "../money.ts";
import type { WagerTransaction, WagerTransactionKind } from "../wager-transaction.ts";
import { IntegrationEvent, type EventContext } from "./integration-event.ts";

/** Payload de `WagerTransactionRejected` (RF-25, RN-17). */
export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Um dos 11 códigos de negócio de D-007 — a ação esperada está documentada. */
  failureCode: BusinessFailureCode;
}

/**
 * Publicado quando a transação é rejeitada por **regra de negócio** (RF-25).
 *
 * Rejeição é resultado, não erro: a transação existe, é terminal e carrega o
 * código que diz ao provedor o que fazer (RN-17). Falha de infraestrutura não
 * passa por aqui — `FAILED` é outro caminho (D-013), e misturar os dois faria o
 * provedor tratar indisponibilidade nossa como recusa de negócio dele.
 */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  /**
   * Monta o evento a partir da transação rejeitada e do código da rejeição.
   *
   * O código vem **por parâmetro** em vez de ser lido de `transaction.failureCode`
   * porque aquele getter é `FailureCode | undefined` — a união com os códigos de
   * infraestrutura. Recebê-lo tipado como `BusinessFailureCode` faz o compilador
   * impor "rejeitada por regra de negócio" (RF-25), sem checagem em runtime nem
   * narrowing inseguro. Quem chama acabou de executar `reject(code)` e já o tem.
   */
  static from(
    transaction: WagerTransaction,
    failureCode: BusinessFailureCode,
    ctx: EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({
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
        failureCode,
      },
    });
  }
}
