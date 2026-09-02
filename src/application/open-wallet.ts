import type { EventContext, IntegrationEvent } from "../domain/events/integration-event.ts";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed.ts";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed.ts";
import { Money, type MoneyProps } from "../domain/money.ts";
import { OutboxMessage } from "../domain/outbox-message.ts";
import { WagerTransaction, WagerTransactionKind } from "../domain/wager-transaction.ts";
import { Wallet } from "../domain/wallet.ts";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.ts";
import { payloadHashOf } from "./payload-hash.ts";
import type { Clock } from "./ports/clock.ts";
import type { IdGenerator } from "./ports/id-generator.ts";
import type { TransactionalRepositories, UnitOfWork } from "./ports/unit-of-work.ts";

/**
 * `providerId` das transações que **nascem dentro do sistema** (D-033).
 *
 * A abertura de wallet não vem de provedor nenhum, mas `provider_id` é NOT NULL
 * no schema de E-05 e não vai deixar de ser: relaxar a coluna para acomodar o
 * único produtor interno enfraqueceria a garantia para os cinco kinds que vêm de
 * fora. O sentinela é a alternativa que mantém o schema intacto.
 *
 * **É um identificador reservado.** Nada impede um provedor real de se chamar
 * assim; a colisão seria recusada pela unicidade de
 * `(provider_id, external_transaction_id)`, não aceita em silêncio.
 */
export const INTERNAL_PROVIDER_ID = "internal";

/** `roundId` e `gameId` sentinela: abertura de wallet não tem rodada nem jogo (D-033). */
export const INTERNAL_ROUND_ID = "internal";
export const INTERNAL_GAME_ID = "internal";

/**
 * Idempotency key da `OPENING` interna (D-033).
 *
 * Derivada do `walletId` porque não existe key de cliente aqui — `POST /wallets`
 * não exige `Idempotency-Key` (RF-08 não pede, e exigi-lo criaria dois
 * significados para o `409` do mesmo endpoint). O efeito colateral é bem-vindo:
 * a reabertura da mesma wallet passa a ser impossível por **duas** constraints
 * independentes, não só pela de `(playerId, currency)`.
 */
export function openingIdempotencyKey(walletId: string): string {
  return `opening:${walletId}`;
}

/** Comando de abertura de wallet — o corpo de `POST /wallets` já tipado (RF-08). */
export interface OpenWalletCommand {
  playerId: string;
  /** DTO, não `Money`: a validação de D-015/D-016 acontece aqui, na fronteira. */
  initialBalance: MoneyProps;
  /** Correlação de ponta a ponta (RNF-06, D-039). Fornecida por quem chama. */
  correlationId: string;
}

/** Resultado da abertura — o corpo que RF-08 devolve. */
export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  /** Sempre `1`: a abertura é uma única mudança de estado (RF-02). */
  version: number;
}

/**
 * Abre uma wallet com saldo inicial (RF-08, RF-23).
 *
 * Saldo maior que zero produz, **na mesma transação SQL**, cinco coisas: a
 * wallet, a transação interna `OPENING`, o lançamento `CREDIT` que a justifica e
 * as duas linhas de outbox de D-034. Ou tudo é confirmado junto, ou nada é.
 *
 * Use case separado de `ProcessWagerTransaction` de propósito: RF-18 exige um
 * caminho único para as operações **submetidas** por provedor, e abertura de
 * wallet não é uma delas — RN-13 diz justamente que `OPENING` não pode ser
 * submetida. Fundir os dois faria o caminho de submissão carregar um kind que
 * ele precisa recusar.
 *
 * Como em E-07, a publicação é **exclusivamente** por outbox: este arquivo não
 * conhece cliente de fila, e a fronteira está no lint de `src/application`
 * (RI-04, EL-06).
 */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Abre a wallet e devolve o estado inicial.
   *
   * @throws InvalidMoneyError se valor ou moeda não estiverem na forma canônica (D-015, D-016 → 400).
   * @throws NegativeBalanceError se o saldo inicial for negativo (→ 400).
   * @throws WalletAlreadyExistsError se o jogador já tem wallet nessa moeda (D-035 → 409).
   */
  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    // Validação de forma **fora** da transação, como em E-07: payload inválido é
    // `400` e não precisa de conexão com o banco.
    const initialBalance = Money.from(command.initialBalance);

    return this.unitOfWork.run(async (repos) => {
      // Um único instante para a transação inteira: wallet, transação,
      // lançamento e eventos descrevem o mesmo fato.
      const now = this.clock.now();

      // Os três ids são consumidos **sempre**, inclusive quando o saldo inicial é
      // zero e os dois últimos não chegam a ser usados: `Wallet.open` os exige na
      // entrada, e gerá-los condicionalmente tornaria a ordem de consumo
      // dependente do valor — a mesma ordem que RT-09 usa como ponto de injeção
      // de falha em E-07.
      const walletId = this.ids.next();
      const openingTransactionId = this.ids.next();
      const openingEntryId = this.ids.next();

      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance,
        openingTransactionId,
        openingEntryId,
        at: now,
      });

      // A wallet vem primeiro: a transação a referencia por FK, e sem Unit of
      // Work (D-028) quem ordena os `insert` é este código.
      await repos.wallets.insert(wallet);

      // RF-08 só gera `OPENING` acima de zero. `openingEntry` ausente é
      // exatamente esse caso — e o `CHECK (amount > 0)` do schema confirma que
      // uma `OPENING` de valor zero nunca poderia ser gravada.
      if (openingEntry !== undefined) {
        const transaction = this.openingTransactionFor(wallet, openingEntry, initialBalance, now);

        await repos.transactions.insert(transaction);
        await repos.ledger.insert(openingEntry);
        await this.enqueueEvents(repos, command, transaction, wallet, openingEntry, now);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  /**
   * Monta a transação `OPENING` interna, já em estado terminal (D-033).
   *
   * Os seis campos que a abertura não tem — provedor, id externo, key, hash,
   * rodada e jogo — recebem os sentinelas de D-033. O `externalTransactionId` é o
   * próprio `walletId`: um id único por construção, que satisfaz
   * `uq_wager_transactions_provider_external` sem inventar sequência nova.
   *
   * Nasce e morre dentro desta transação SQL, então ninguém consegue observá-la
   * em `PENDING` — é o mesmo argumento do `insert` único de E-07.
   *
   * O id vem do **lançamento**, não de uma variável paralela: assim não existe
   * caminho em que a transação e o lançamento que a referencia apontem para ids
   * diferentes. A FK recusaria a divergência, mas só em runtime e só depois de a
   * wallet já ter sido escrita.
   */
  private openingTransactionFor(
    wallet: Wallet,
    openingEntry: WalletLedgerEntry,
    initialBalance: Money,
    now: Date,
  ): WagerTransaction {
    const payloadHash = payloadHashOf({
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: wallet.id,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: INTERNAL_ROUND_ID,
      gameId: INTERNAL_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: initialBalance.toJSON(),
    });

    const transaction = WagerTransaction.create({
      id: openingEntry.transactionId,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: wallet.id,
      idempotencyKey: openingIdempotencyKey(wallet.id),
      payloadHash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: INTERNAL_ROUND_ID,
      gameId: INTERNAL_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: initialBalance,
      createdAt: now,
    });

    // O saldo observado é o saldo com que a wallet nasceu (RN-12, D-030).
    transaction.markProcessed(undefined, wallet.balance, now);

    return transaction;
  }

  /**
   * Enfileira os dois eventos da abertura (D-034, RF-25).
   *
   * `WagerTransactionProcessed` porque a `OPENING` é transação aplicada, e
   * `WalletBalanceChanged` porque o saldo mudou — as duas linhas de RF-25 se
   * aplicam pela letra. É o que mantém sem exceção as invariantes "toda transação
   * `PROCESSED` tem evento" e "toda mudança de saldo tem `WalletBalanceChanged`":
   * um consumidor que reconstrói saldo por eventos não precisa saber que a
   * primeira movimentação de cada wallet é especial.
   */
  private async enqueueEvents(
    repos: TransactionalRepositories,
    command: OpenWalletCommand,
    transaction: WagerTransaction,
    wallet: Wallet,
    openingEntry: WalletLedgerEntry,
    now: Date,
  ): Promise<void> {
    await this.enqueue(
      repos,
      WagerTransactionProcessed.from(transaction, this.contextFor(command, now)),
    );
    await this.enqueue(
      repos,
      WalletBalanceChanged.from(wallet, openingEntry, this.contextFor(command, now)),
    );
  }

  /** Grava uma linha da outbox. **Único** caminho de publicação (RI-04, EL-06). */
  private async enqueue(
    repos: TransactionalRepositories,
    event: IntegrationEvent<unknown>,
  ): Promise<void> {
    await repos.outbox.insert(OutboxMessage.enqueue({ id: this.ids.next(), event }));
  }

  /** Contexto de rastreio de um evento — `eventId` novo, correlação de quem chamou. */
  private contextFor(command: OpenWalletCommand, now: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      occurredAt: now,
    };
  }
}
