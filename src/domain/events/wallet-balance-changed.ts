import type { LedgerDirection } from "../ledger-direction.ts";
import type { MoneyProps } from "../money.ts";
import type { Wallet } from "../wallet.ts";
import type { WalletLedgerEntry } from "../wallet-ledger-entry.ts";
import { IntegrationEvent, type EventContext } from "./integration-event.ts";

/** Payload de `WalletBalanceChanged` (RF-25, §11). */
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** `version` da wallet **depois** do movimento — o leitor sabe o que já viu. */
  walletVersion: number;
}

/**
 * Publicado **somente** quando o saldo muda (RF-25).
 *
 * "Somente" é literal: `LOSS` e qualquer transação `REJECTED` não movem saldo e
 * não geram este evento — geram `WagerTransactionProcessed` ou
 * `WagerTransactionRejected`. Um consumidor que reconstrói saldo a partir daqui
 * ficaria errado se o evento saísse sem lançamento correspondente.
 *
 * O `aggregateId` é a **wallet**, não a transação: é o agregado cujo estado
 * mudou, e é por ele que um consumidor ordena os eventos que lhe interessam.
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  /**
   * Monta o evento a partir da wallet e do lançamento que ela devolveu.
   *
   * Exige o `WalletLedgerEntry` porque D-018 fez `debit`/`credit` devolverem o
   * lançamento: pedir o lançamento aqui garante que este evento só possa ser
   * construído por quem de fato moveu o saldo, e os três valores monetários saem
   * do mesmo lançamento que o ledger gravou — não de uma leitura paralela que
   * poderia divergir.
   */
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
