import type { EventContext, IntegrationEvent } from "../domain/events/integration-event.ts";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference.ts";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed.ts";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected.ts";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed.ts";
import { OutboxMessage } from "../domain/outbox-message.ts";
import type { OutboxRepository } from "../domain/repositories/outbox-repository.ts";
import type { WagerTransaction } from "../domain/wager-transaction.ts";
import type { Wallet } from "../domain/wallet.ts";
import type { IdGenerator } from "./ports/id-generator.ts";
import type { TransactionOutcome } from "./transaction-outcome.ts";

/**
 * Rastro que um evento de integração herda de quem provocou o desfecho (RNF-06).
 *
 * Existe porque **os desfechos têm duas origens**: a submissão, que traz a
 * correlação do provedor no comando, e o worker de RF-26, que resolve uma
 * `PENDING_REFERENCE` fora de qualquer requisição e relê a correlação guardada na
 * própria transação (D-055). Tipar o rastro em vez de passar o comando é o que
 * permite os dois caminhos alimentarem o mesmo `contextFor`.
 */
export interface EventTrace {
  correlationId: string;
  causationId?: string | undefined;
}

/**
 * Traduz o desfecho de uma transação nos eventos de integração dele (RF-25, D-066).
 *
 * Classe, e não função como `decideReversal`, por um motivo só: ela **carrega uma
 * dependência** — o `IdGenerator`, que alimenta o `eventId` e o id da linha de
 * outbox. Recebê-la no construtor evita repetir o gerador em cada chamada.
 *
 * Recebe o `OutboxRepository` por parâmetro, e não por injeção, porque o
 * repositório que vale é o **ligado à transação em curso** (D-028): guardá-lo no
 * construtor daria um recorder capaz de escrever fora da transação do dinheiro,
 * que é exatamente o que RF-23 proíbe.
 *
 * É o **único** caminho de publicação do use case de processamento (RI-04,
 * EL-06). Nenhum cliente de fila é alcançável daqui — a fronteira está no lint de
 * `src/application`, que veta `@aws-sdk/*`.
 */
export class OutboxEventRecorder {
  constructor(private readonly ids: IdGenerator) {}

  /**
   * Enfileira os eventos do desfecho na outbox (RF-25, RF-23).
   *
   * Os três desfechos de `TransactionOutcome` têm um evento cada, e a tabela de
   * RF-25 é lida inteira aqui — `WagerTransactionProcessed` para qualquer
   * transação aplicada **inclusive `LOSS`**, `WagerTransactionRejected` para
   * rejeição de negócio e `WagerTransactionPendingReference` para a referência
   * que ainda não chegou.
   *
   * `WalletBalanceChanged` sai **somente** quando o saldo mudou, e por isso é
   * construído a partir do lançamento que o movimento devolveu (D-018): não há
   * assinatura aqui capaz de anunciar mudança de saldo sem ter o lançamento que
   * a comprova. É também o que faz `LOSS` publicar um evento e não dois, sem
   * nenhum teste de kind neste método.
   */
  async record(
    outbox: OutboxRepository,
    trace: EventTrace,
    transaction: WagerTransaction,
    wallet: Wallet,
    result: TransactionOutcome,
    now: Date,
  ): Promise<void> {
    if (result.outcome === "rejected") {
      await this.enqueue(
        outbox,
        WagerTransactionRejected.from(
          transaction,
          result.failureCode,
          this.contextFor(trace, now),
        ),
      );

      return;
    }

    if (result.outcome === "pending-reference") {
      await this.enqueue(
        outbox,
        WagerTransactionPendingReference.from(transaction, this.contextFor(trace, now)),
      );

      return;
    }

    await this.enqueue(
      outbox,
      WagerTransactionProcessed.from(transaction, this.contextFor(trace, now)),
    );

    if (result.entry === undefined) {
      // `LOSS` (RN-03): a transação foi aplicada, mas o saldo não mudou. Publicar
      // `WalletBalanceChanged` aqui seria anunciar uma mudança que não houve.
      return;
    }

    await this.enqueue(
      outbox,
      WalletBalanceChanged.from(wallet, result.entry, this.contextFor(trace, now)),
    );
  }

  /** Grava uma linha da outbox. **Único** caminho de publicação (RI-04, EL-06). */
  private async enqueue(
    outbox: OutboxRepository,
    event: IntegrationEvent<unknown>,
  ): Promise<void> {
    await outbox.insert(OutboxMessage.enqueue({ id: this.ids.next(), event }));
  }

  /** Contexto de rastreio de um evento — `eventId` novo, correlação de quem chamou. */
  private contextFor(trace: EventTrace, now: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: trace.correlationId,
      ...(trace.causationId === undefined ? {} : { causationId: trace.causationId }),
      occurredAt: now,
    };
  }
}
