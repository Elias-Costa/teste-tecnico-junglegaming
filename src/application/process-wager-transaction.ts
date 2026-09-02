import type { EventContext, IntegrationEvent } from "../domain/events/integration-event.ts";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed.ts";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected.ts";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed.ts";
import { BusinessFailureCode, type FailureCode } from "../domain/failure-code.ts";
import { InboxMessage } from "../domain/inbox-message.ts";
import { Money, type MoneyProps } from "../domain/money.ts";
import { OutboxMessage } from "../domain/outbox-message.ts";
import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from "../domain/wager-transaction.ts";
import type { Wallet } from "../domain/wallet.ts";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.ts";
import { IdempotencyConflictError } from "./errors/idempotency-conflict-error.ts";
import { UnsupportedKindError } from "./errors/unsupported-kind-error.ts";
import { WalletNotFoundError } from "./errors/wallet-not-found-error.ts";
import { payloadHashOf } from "./payload-hash.ts";
import type { Clock } from "./ports/clock.ts";
import type { IdGenerator } from "./ports/id-generator.ts";
import type { TransactionalRepositories, UnitOfWork } from "./ports/unit-of-work.ts";

/**
 * Identidade da mensagem, quando a entrada é a fila (RF-19, RF-23).
 *
 * Ausente na entrada HTTP. É a presença deste contexto — e não uma segunda
 * implementação do use case — que faz a inbox participar da mesma transação.
 */
export interface InboxContext {
  consumerName: string;
  /** `MessageId` do SQS, não um id nosso. */
  messageId: string;
}

/** Comando de processamento — a mesma forma para HTTP e para SQS (RF-18). */
export interface ProcessWagerTransactionCommand {
  /** Fonte da verdade da idempotência (RF-14). */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  /** DTO, não `Money`: a validação de D-015/D-016 é feita aqui, na fronteira. */
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  /** Correlação de ponta a ponta (RNF-06). Fornecida por quem chama, nunca inventada aqui. */
  correlationId: string;
  causationId?: string | undefined;
  inbox?: InboxContext | undefined;
}

/** Resultado do processamento — o corpo que RF-13 devolve. */
export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado no desfecho (RN-12, D-030) — no replay, o **original**. */
  balance: MoneyProps;
  idempotentReplay: boolean;
  /**
   * Código do desfecho, quando houve rejeição ou falha.
   *
   * Tipado como `FailureCode`, e não `BusinessFailureCode`, porque um replay
   * pode reler uma transação em `FAILED` (D-013), cujo código é de
   * infraestrutura. Quem decide o status HTTP olha o `status` (D-006).
   */
  failureCode?: FailureCode;
}

/**
 * Desfecho de negócio de uma transação, com o que cada caminho produz.
 *
 * União discriminada em vez de ler `transaction.failureCode` depois: aquele
 * getter é a união com os códigos de infraestrutura, e `WagerTransactionRejected`
 * exige um `BusinessFailureCode` por decisão de RF-25. Carregar o código no
 * desfecho entrega ao evento exatamente o tipo que ele pede, sem narrowing.
 */
type BetOutcome =
  | { readonly outcome: "processed"; readonly entry: WalletLedgerEntry }
  | { readonly outcome: "rejected"; readonly failureCode: BusinessFailureCode };

/**
 * Processa uma operação de aposta (RF-18, RF-23, RN-01).
 *
 * **Use case único**, compartilhado pela entrada HTTP e pelo consumidor SQS: um
 * segundo caminho de processamento com regras próprias é o que RF-18 proíbe, e
 * seria também a forma mais fácil de as duas entradas divergirem em idempotência.
 *
 * Tudo acontece dentro de **uma transação SQL** (RF-23): transação, saldo,
 * ledger, inbox e outbox são confirmados juntos ou descartados juntos. A
 * publicação é **exclusivamente** por outbox — este arquivo não conhece cliente
 * de fila, e a fronteira está no lint de `src/application` (RI-04, EL-06).
 *
 * A transação é curta e **não contém I/O externo**, que é o que torna o lock
 * pessimista de D-002 seguro aqui: nenhuma conexão fica segurada durante chamada
 * de rede.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Executa o comando e devolve o desfecho.
   *
   * @throws InvalidMoneyError se valor ou moeda não estiverem na forma canônica (D-015, D-016 → 400).
   * @throws UnsupportedKindError para kinds fora de `BET` — limite de E-07, aberto em E-12.
   * @throws WalletNotFoundError se a wallet não existe (D-031 → 422).
   * @throws IdempotencyConflictError se a key já existe com outro payload (RN-14 → 409).
   */
  async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    // Validação de forma **fora** da transação: payload inválido é `400` e não
    // precisa de conexão, muito menos do lock da wallet.
    const money = Money.from(command.money);
    assertSupportedKind(command.kind);

    // Campos listados um a um, e não `{ ...command }`: a lista fechada de D-005
    // é contrato, e espalhar o comando faria qualquer campo novo — inclusive
    // metadado de transporte, que a §9 proíbe — passar a alimentar o hash sem
    // que ninguém precisasse decidir isso.
    const payloadHash = payloadHashOf({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      // Do `Money` já validado, não da entrada crua: é a forma canônica de
      // D-015 que garante um hash por valor (D-005).
      money: money.toJSON(),
      ...(command.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: command.referenceExternalTransactionId }),
    });

    return this.unitOfWork.run(async (repos) => {
      // Um único instante para a transação inteira: `createdAt`, `processedAt`,
      // o lançamento, a inbox e os eventos descrevem o mesmo fato e não podem
      // divergir em milissegundos por terem lido o relógio em momentos diferentes.
      const now = this.clock.now();

      // O lock vem **antes** da consulta de idempotência, e isso é a decisão
      // central deste método: o mesmo `FOR UPDATE` que protege o saldo (D-002)
      // serializa a pergunta "esta key já foi processada?". Sem isso, duas
      // submissões idênticas simultâneas responderiam "ainda não" as duas e
      // disputariam o `insert` — o `UNIQUE` de E-05 continuaria segurando a
      // invariante (RI-09), mas ao custo de um erro de integridade no caminho
      // normal de RT-14, em vez de um replay limpo.
      const wallet = await repos.wallets.findByIdForUpdate(command.walletId);

      if (wallet === undefined) {
        // D-031: a FK impede persistir esta rejeição. Nada é gravado, nenhum
        // evento é publicado, e a transação inteira aborta sem ter escrito nada.
        throw new WalletNotFoundError(command.walletId);
      }

      const existing = await repos.transactions.findByIdempotencyKey(command.idempotencyKey);

      if (existing !== undefined) {
        return this.replay(repos, command, existing, wallet, payloadHash, now);
      }

      return this.process(repos, command, wallet, money, payloadHash, now);
    });
  }

  /**
   * Devolve o resultado original de uma key já registrada (RN-12, RN-14).
   *
   * Payload divergente é conflito, não replay. Igual, devolve o desfecho como
   * ele foi — inclusive o saldo daquele instante, que é o ponto de RN-12: uma
   * aposta processada quando o saldo era `75.00` continua respondendo `75.00`
   * depois de outras operações moverem a wallet.
   */
  private async replay(
    repos: TransactionalRepositories,
    command: ProcessWagerTransactionCommand,
    existing: WagerTransaction,
    wallet: Wallet,
    payloadHash: string,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(command.idempotencyKey, existing.id);
    }

    // A entrega é registrada mesmo sem trabalho novo: ela chegou, foi levada até
    // o fim e o `ack` de RF-20 vai acontecer depois deste commit.
    await this.recordInbox(repos, command, payloadHash, now);

    return {
      transactionId: existing.id,
      status: existing.status,
      // `observedBalance` só é `undefined` em transação sem desfecho, que hoje
      // significa `PENDING_REFERENCE` — estado que `BET` não alcança e cuja
      // resposta de RN-15 é definida em E-13. Até lá, o saldo corrente da wallet
      // travada é a única leitura honesta disponível.
      balance: (existing.observedBalance ?? wallet.balance).toJSON(),
      idempotentReplay: true,
      ...(existing.failureCode === undefined ? {} : { failureCode: existing.failureCode }),
    };
  }

  /**
   * Aplica uma operação nova, escrevendo tudo na mesma transação (RF-23).
   *
   * A ordem dos `insert` é a ordem das chaves estrangeiras e **é a ordem escrita
   * aqui**: sem Unit of Work (D-028) não há commit order calculado, então a
   * transação precisa existir antes do lançamento que a referencia.
   */
  private async process(
    repos: TransactionalRepositories,
    command: ProcessWagerTransactionCommand,
    wallet: Wallet,
    money: Money,
    payloadHash: string,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      ...(command.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: command.referenceExternalTransactionId }),
      createdAt: now,
    });

    const result = this.decideBet(wallet, transaction, money, now);

    // Um único `insert`, já no estado terminal: a decisão inteira acontece
    // dentro desta transação SQL, então não existe instante em que alguém possa
    // observar a linha em `PENDING`. Inserir e depois atualizar custaria um
    // comando a mais para representar um estado que ninguém consegue ler.
    await repos.transactions.insert(transaction);

    if (result.outcome === "processed") {
      await repos.wallets.update(wallet);
      await repos.ledger.insert(result.entry);
    }

    await this.recordInbox(repos, command, payloadHash, now);
    await this.enqueueEvents(repos, command, transaction, wallet, result, now);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      // Nunca `undefined` aqui: os dois desfechos possíveis passaram por
      // `markProcessed` ou `reject`, e ambos exigem o saldo observado (D-030).
      balance: (transaction.observedBalance ?? wallet.balance).toJSON(),
      idempotentReplay: false,
      ...(result.outcome === "rejected" ? { failureCode: result.failureCode } : {}),
    };
  }

  /**
   * Decide o desfecho de um `BET` e aplica o efeito no agregado (RN-01, RF-02).
   *
   * As duas rejeições possíveis são consultadas, não capturadas por exceção
   * (D-019): só o use case sabe o kind e, portanto, qual código de D-007
   * corresponde. A ordem — moeda antes de valor — é a das próprias regras, e
   * inverter faria uma aposta em moeda errada ser recusada por saldo.
   */
  private decideBet(
    wallet: Wallet,
    transaction: WagerTransaction,
    money: Money,
    now: Date,
  ): BetOutcome {
    if (wallet.currency !== money.currency) {
      transaction.reject(BusinessFailureCode.CurrencyMismatch, wallet.balance);

      return { outcome: "rejected", failureCode: BusinessFailureCode.CurrencyMismatch };
    }

    if (!wallet.hasSufficientBalanceFor(money)) {
      transaction.reject(BusinessFailureCode.InsufficientFunds, wallet.balance);

      return { outcome: "rejected", failureCode: BusinessFailureCode.InsufficientFunds };
    }

    const entry = wallet.debit({
      entryId: this.ids.next(),
      transactionId: transaction.id,
      money,
      at: now,
    });

    // O saldo observado é o de **depois** do débito — é o que a §9 do enunciado
    // mostra na resposta e o que o replay repete (RN-12, D-030).
    transaction.markProcessed(undefined, wallet.balance, now);

    return { outcome: "processed", entry };
  }

  /**
   * Registra a entrega na inbox, quando a entrada foi a fila (RF-19, RF-23).
   *
   * Gravada já processada: dentro desta transação, "recebida" e "concluída" são
   * o mesmo commit, e o `ack` de RF-20 só acontece depois dele.
   *
   * **A pré-checagem que torna a reentrega barata é de E-11.** Aqui, uma
   * reentrega do mesmo `messageId` colide com a chave primária de D-025 e aborta
   * a transação inteira — o efeito no dinheiro continua único (é o que EL-03
   * cobra), mas quem transforma isso em "pular e dar ack" é o consumidor.
   */
  private async recordInbox(
    repos: TransactionalRepositories,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    now: Date,
  ): Promise<void> {
    if (command.inbox === undefined) {
      return;
    }

    const message = InboxMessage.receive({
      messageId: command.inbox.messageId,
      consumerName: command.inbox.consumerName,
      payloadHash,
      receivedAt: now,
    });
    message.markProcessed(now);

    await repos.inbox.insert(message);
  }

  /**
   * Enfileira os eventos do desfecho na outbox (RF-25, RF-23).
   *
   * `WalletBalanceChanged` sai **somente** quando o saldo mudou, e por isso é
   * construído a partir do lançamento que o movimento devolveu (D-018): não há
   * assinatura aqui capaz de anunciar mudança de saldo sem ter o lançamento que
   * a comprova.
   */
  private async enqueueEvents(
    repos: TransactionalRepositories,
    command: ProcessWagerTransactionCommand,
    transaction: WagerTransaction,
    wallet: Wallet,
    result: BetOutcome,
    now: Date,
  ): Promise<void> {
    if (result.outcome === "rejected") {
      await this.enqueue(
        repos,
        WagerTransactionRejected.from(
          transaction,
          result.failureCode,
          this.contextFor(command, now),
        ),
      );

      return;
    }

    await this.enqueue(
      repos,
      WagerTransactionProcessed.from(transaction, this.contextFor(command, now)),
    );
    await this.enqueue(
      repos,
      WalletBalanceChanged.from(wallet, result.entry, this.contextFor(command, now)),
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
  private contextFor(command: ProcessWagerTransactionCommand, now: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
      occurredAt: now,
    };
  }
}

/**
 * Barra os kinds que este use case ainda não processa.
 *
 * `BET` é o escopo de E-07. Os demais chegam em E-12, e `OPENING` é barrado na
 * borda por RN-13. Falhar antes de abrir a transação evita segurar lock por uma
 * operação que não vai ser aplicada.
 *
 * @throws UnsupportedKindError para qualquer kind diferente de `BET`.
 */
function assertSupportedKind(kind: WagerTransactionKind): void {
  if (kind !== WagerTransactionKind.Bet) {
    throw new UnsupportedKindError(kind);
  }
}
