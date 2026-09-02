import { InvalidLedgerEntryError } from "../domain/errors/invalid-ledger-entry-error.ts";
import type { EventContext, IntegrationEvent } from "../domain/events/integration-event.ts";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference.ts";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed.ts";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected.ts";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed.ts";
import { BusinessFailureCode, type FailureCode } from "../domain/failure-code.ts";
import { InboxMessage } from "../domain/inbox-message.ts";
import { LedgerDirection } from "../domain/ledger-direction.ts";
import { Money, type MoneyProps } from "../domain/money.ts";
import { OutboxMessage } from "../domain/outbox-message.ts";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction.ts";
import type { Wallet } from "../domain/wallet.ts";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.ts";
import { IdempotencyConflictError } from "./errors/idempotency-conflict-error.ts";
import { KindNotSubmittableError } from "./errors/kind-not-submittable-error.ts";
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
  /** `messageId` do **corpo** da mensagem (D-044), não o id de transporte do SQS. */
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
 *
 * O `entry` opcional de `processed` **é** RN-03 no tipo: `LOSS` é uma transação
 * aplicada que não move saldo e não gera lançamento. Como `WalletBalanceChanged`
 * se constrói a partir do lançamento (D-018), a ausência dele é o que faz o
 * evento não ser publicado — sem `if` sobre kind em lugar nenhum (RF-25).
 */
type TransactionOutcome =
  | { readonly outcome: "processed"; readonly entry: WalletLedgerEntry | undefined }
  | { readonly outcome: "rejected"; readonly failureCode: BusinessFailureCode }
  | { readonly outcome: "pending-reference" };

/** Os dois kinds que revertem outra transação (RN-04, RN-05). */
type ReversalKind = WagerTransactionKind.Refund | WagerTransactionKind.Rollback;

/**
 * O que cada reversão pode referenciar (RN-08).
 *
 * Tabela e não `if`: a regra é uma matriz de duas linhas no enunciado (§7), e
 * escrevê-la como matriz mantém a correspondência visível para quem confere o
 * código contra o documento. `LOSS`, `OPENING` e `ROLLBACK` não aparecem em
 * nenhuma das listas, e é isso que faz reverter um estorno ser
 * `INVALID_REFERENCE_KIND` em vez de recursão.
 */
const REVERSIBLE_REFERENCE_KINDS: Readonly<
  Record<ReversalKind, readonly WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

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
   * @throws InvalidLedgerEntryError se o valor da operação não for positivo (D-021 → 400).
   * @throws KindNotSubmittableError se o kind for `OPENING` (RN-13 → 422).
   * @throws WalletNotFoundError se a wallet não existe (D-031 → 422).
   * @throws IdempotencyConflictError se a key já existe com outro payload (RN-14 → 409).
   * @throws MissingReferenceError se `REFUND`/`ROLLBACK` vierem sem referência (D-020 → 400).
   */
  async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    // Validação de forma **fora** da transação: payload inválido é `400` e não
    // precisa de conexão, muito menos do lock da wallet.
    const money = Money.from(command.money);
    assertSubmittableKind(command.kind);
    assertPositiveAmount(money);

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

    const result = await this.decide(repos, wallet, transaction, money, now);

    // Um único `insert`, já no estado final desta passagem: a decisão inteira
    // acontece dentro desta transação SQL, então não existe instante em que
    // alguém possa observar a linha em `PENDING`. Inserir e depois atualizar
    // custaria um comando a mais para representar um estado que ninguém consegue
    // ler. `PENDING_REFERENCE` é o único desfecho não terminal, e é E-13 quem o
    // resolve depois (RF-26).
    await repos.transactions.insert(transaction);

    // `entry === undefined` é `LOSS` (RN-03): transação aplicada, saldo intacto,
    // nenhum lançamento. Nem a wallet é reescrita — `version` só incrementa
    // quando o saldo muda (RF-02), e um `update` aqui gravaria a mesma linha.
    if (result.outcome === "processed" && result.entry !== undefined) {
      await repos.wallets.update(wallet);
      await repos.ledger.insert(result.entry);
    }

    await this.recordInbox(repos, command, payloadHash, now);
    await this.enqueueEvents(repos, command, transaction, wallet, result, now);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      // `undefined` só em `PENDING_REFERENCE`: `markPendingReference` não observa
      // saldo (D-030), porque aguardar referência não é desfecho. Nesse caso vale
      // o saldo corrente da wallet travada, e é E-13 quem decide a forma final da
      // resposta de RN-15. Nos outros dois, `markProcessed`/`reject` já gravaram.
      balance: (transaction.observedBalance ?? wallet.balance).toJSON(),
      idempotentReplay: false,
      ...(result.outcome === "rejected" ? { failureCode: result.failureCode } : {}),
    };
  }

  /**
   * Decide o desfecho da operação e aplica o efeito no agregado (RN-01..RN-05).
   *
   * As rejeições são **consultadas, não capturadas por exceção** (D-019): só o
   * use case sabe o kind e, portanto, qual dos 13 códigos de D-007 corresponde.
   * As guardas do agregado continuam existindo como último recurso, e um erro
   * delas escapando é bug nosso — por isso não estão mapeadas para `422` (D-006).
   *
   * O check de moeda vem antes do switch porque é a única regra que não depende
   * de kind nem de referência: é a moeda da operação contra a moeda da wallet
   * (RF-02), e é o primeiro degrau da ordem de D-051.
   */
  private async decide(
    repos: TransactionalRepositories,
    wallet: Wallet,
    transaction: WagerTransaction,
    money: Money,
    now: Date,
  ): Promise<TransactionOutcome> {
    if (wallet.currency !== money.currency) {
      return this.rejectWith(transaction, wallet, BusinessFailureCode.CurrencyMismatch);
    }

    // Copiado para um `const` em vez de `switch (transaction.kind)`: o narrowing
    // sobre uma variável local é o que entrega `ReversalKind` ao ramo dos dois
    // estornos sem asserção de tipo.
    const kind = transaction.kind;

    switch (kind) {
      case WagerTransactionKind.Bet:
        return this.applyMovement(LedgerDirection.Debit, wallet, transaction, money, now, {
          undefinedReferenceId: true,
          insufficientFundsCode: BusinessFailureCode.InsufficientFunds,
        });

      case WagerTransactionKind.Win:
        // RN-02. A referência opcional do `WIN` **não** é resolvida (D-049): ela
        // é metadado de rastreio do provedor, e o valor do prêmio vem no próprio
        // payload — o crédito não deriva da `BET`.
        return this.applyMovement(LedgerDirection.Credit, wallet, transaction, money, now, {
          undefinedReferenceId: true,
          insufficientFundsCode: BusinessFailureCode.InsufficientFunds,
        });

      case WagerTransactionKind.Loss:
        // RN-03: registra o resultado sem mover saldo. Transação aplicada, sem
        // lançamento — e, por RF-25, **com** evento `WagerTransactionProcessed`.
        transaction.markProcessed(undefined, wallet.balance, now);

        return { outcome: "processed", entry: undefined };

      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        return this.decideReversal(repos, wallet, transaction, money, kind, now);

      case WagerTransactionKind.Opening:
        // Inalcançável pelas duas bordas, que já barram `OPENING` no parser
        // (RN-13). Fica como guarda para quem chamar este use case por dentro do
        // sistema: a `OPENING` legítima nasce em `OpenWallet`, e só lá.
        throw new KindNotSubmittableError(kind);
    }
  }

  /**
   * Decide `REFUND` e `ROLLBACK` resolvendo a transação referenciada (RN-04..RN-10).
   *
   * **A ordem dos `if` é a ordem de D-051**, e não é arbitrária: primeiro tudo
   * que o provedor corrige no payload (`REFERENCE_MISMATCH`,
   * `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`), depois o que o manda desistir
   * (`ALREADY_REVERSED`) e por último o que o manda escalar
   * (`INSUFFICIENT_FUNDS_ON_REVERSAL`). Quando duas regras são violadas ao mesmo
   * tempo, o provedor recebe o código sobre o qual ele consegue agir.
   */
  private async decideReversal(
    repos: TransactionalRepositories,
    wallet: Wallet,
    transaction: WagerTransaction,
    money: Money,
    kind: ReversalKind,
    now: Date,
  ): Promise<TransactionOutcome> {
    // Garantido por `WagerTransaction.create`, que recusa `REFUND`/`ROLLBACK` sem
    // referência com `MissingReferenceError` (D-020, RN-06 → 400).
    const referenceExternalId = transaction.referenceExternalTransactionId ?? "";

    const reference = await repos.transactions.findByProviderExternalId(
      transaction.providerId,
      referenceExternalId,
    );

    // RN-15: a referência pode simplesmente ainda não ter chegado. Não é
    // rejeição — a transação espera e o worker de RF-26 a resolve.
    if (reference === undefined) {
      transaction.markPendingReference();

      return { outcome: "pending-reference" };
    }

    // D-050: quem ainda pode virar `PROCESSED` espera; quem não pode mais é
    // rejeitado agora. Uma referência em `PENDING_REFERENCE` está ela própria
    // aguardando (cadeia fora de ordem); uma em `REJECTED`/`FAILED` é terminal
    // por D-013 e nunca vai ser reversível.
    if (reference.status === WagerTransactionStatus.PendingReference) {
      transaction.markPendingReference();

      return { outcome: "pending-reference" };
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return this.rejectWith(transaction, wallet, BusinessFailureCode.ReferenceMismatch);
    }

    // RN-07: mesmo provider, player, wallet, moeda e rodada. O provider já é
    // critério da busca, então os quatro restantes são os que sobram para checar.
    if (
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.money.currency !== money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return this.rejectWith(transaction, wallet, BusinessFailureCode.ReferenceMismatch);
    }

    // RN-08. **Este passo protege o cálculo de direção lá embaixo:**
    // `ledgerDirectionFor` lança `NoLedgerDirectionError` se a referência for
    // `LOSS` ou `ROLLBACK`, e é esta lista que garante que ela nunca é chamada
    // com uma dessas.
    if (!REVERSIBLE_REFERENCE_KINDS[kind].includes(reference.kind)) {
      return this.rejectWith(transaction, wallet, BusinessFailureCode.InvalidReferenceKind);
    }

    // RN-10: reversão parcial está fora de escopo. Seguro depois do check de
    // moeda acima — `equals` lança entre moedas diferentes (D-017).
    if (!reference.money.equals(money)) {
      return this.rejectWith(transaction, wallet, BusinessFailureCode.AmountMismatch);
    }

    // RN-09, caminho de negócio. A garantia é o índice parcial de D-024, que
    // continua valendo se duas instâncias perguntarem ao mesmo tempo.
    if (await repos.transactions.hasProcessedReversal(reference.id, kind)) {
      return this.rejectWith(transaction, wallet, BusinessFailureCode.AlreadyReversed);
    }

    // RN-05: a direção é o inverso da referência para `ROLLBACK`; `REFUND` sempre
    // credita (RN-04). Estornar um `WIN` ou um `REFUND`, portanto, **debita**.
    const direction = transaction.ledgerDirectionFor(reference);

    return this.applyMovement(direction, wallet, transaction, money, now, {
      undefinedReferenceId: false,
      referenceId: reference.id,
      // RN-16: reverter sem saldo é anomalia operacional, não rotina — e por
      // isso tem código próprio, distinto do de uma aposta sem saldo.
      insufficientFundsCode: BusinessFailureCode.InsufficientFundsOnReversal,
    });
  }

  /**
   * Move o saldo na direção dada e marca a transação como aplicada (RF-02, RF-04).
   *
   * Ponto único de movimentação do use case: os quatro kinds que mexem em saldo
   * chegam aqui, e é o `insufficientFundsCode` do chamador que decide entre
   * `INSUFFICIENT_FUNDS` e `INSUFFICIENT_FUNDS_ON_REVERSAL` (RN-16). Concentrar
   * evita que um kind novo esqueça a consulta de saldo de D-019 — o débito
   * lançaria, e uma guarda de último recurso não produz `failureCode` legível.
   */
  private applyMovement(
    direction: LedgerDirection,
    wallet: Wallet,
    transaction: WagerTransaction,
    money: Money,
    now: Date,
    options: {
      undefinedReferenceId: boolean;
      referenceId?: string;
      insufficientFundsCode: BusinessFailureCode;
    },
  ): TransactionOutcome {
    const debiting = direction === LedgerDirection.Debit;

    if (debiting && !wallet.hasSufficientBalanceFor(money)) {
      return this.rejectWith(transaction, wallet, options.insufficientFundsCode);
    }

    const movement = { entryId: this.ids.next(), transactionId: transaction.id, money, at: now };
    const entry = debiting ? wallet.debit(movement) : wallet.credit(movement);

    // O saldo observado é o de **depois** do movimento — é o que a §9 do
    // enunciado mostra na resposta e o que o replay repete (RN-12, D-030).
    transaction.markProcessed(
      options.undefinedReferenceId ? undefined : options.referenceId,
      wallet.balance,
      now,
    );

    return { outcome: "processed", entry };
  }

  /** Rejeita por regra de negócio, gravando o saldo do instante (RN-11, RN-12, D-030). */
  private rejectWith(
    transaction: WagerTransaction,
    wallet: Wallet,
    failureCode: BusinessFailureCode,
  ): TransactionOutcome {
    transaction.reject(failureCode, wallet.balance);

    return { outcome: "rejected", failureCode };
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
  private async enqueueEvents(
    repos: TransactionalRepositories,
    command: ProcessWagerTransactionCommand,
    transaction: WagerTransaction,
    wallet: Wallet,
    result: TransactionOutcome,
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

    if (result.outcome === "pending-reference") {
      await this.enqueue(
        repos,
        WagerTransactionPendingReference.from(transaction, this.contextFor(command, now)),
      );

      return;
    }

    await this.enqueue(
      repos,
      WagerTransactionProcessed.from(transaction, this.contextFor(command, now)),
    );

    if (result.entry === undefined) {
      // `LOSS` (RN-03): a transação foi aplicada, mas o saldo não mudou. Publicar
      // `WalletBalanceChanged` aqui seria anunciar uma mudança que não houve.
      return;
    }

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
 * Barra `OPENING` submetido de fora (RN-13).
 *
 * Os cinco kinds submetíveis são processados; `OPENING` é interno e nasce em
 * `OpenWallet` (RF-08, D-033). As duas bordas já barram no parser, então esta é
 * a guarda de quem chamar o use case por dentro do sistema — e falhar antes de
 * abrir a transação evita segurar lock por uma operação que não vai ser aplicada.
 *
 * @throws KindNotSubmittableError para `OPENING`.
 */
function assertSubmittableKind(kind: WagerTransactionKind): void {
  if (kind === WagerTransactionKind.Opening) {
    throw new KindNotSubmittableError(kind);
  }
}

/**
 * Recusa operação de valor não estritamente positivo (D-021).
 *
 * `Money.from` aceita `"0.00"` — a escala de D-015 não opina sobre o valor —, e
 * `Wallet.debit`/`credit` recusam movimento nulo. Mas `LOSS` **não** move saldo
 * (RN-03), então um `LOSS` de zero passaria as duas barreiras e só morreria no
 * `ck_wager_transactions_amount_positive` da tabela, como `500` — para o que é
 * payload inválido. A regra é da transação, não do lançamento, e por isso vale
 * para os cinco kinds e vive antes da transação SQL.
 *
 * @throws InvalidLedgerEntryError quando o valor não é estritamente positivo.
 */
function assertPositiveAmount(money: Money): void {
  if (!money.isPositive()) {
    throw new InvalidLedgerEntryError(
      `operação exige valor estritamente positivo, recebido ${money.toString()} (D-021).`,
    );
  }
}
