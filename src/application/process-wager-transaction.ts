import { InvalidLedgerEntryError } from "../domain/errors/invalid-ledger-entry-error.ts";
import { BusinessFailureCode, type FailureCode } from "../domain/failure-code.ts";
import { InboxMessage } from "../domain/inbox-message.ts";
import { LedgerDirection } from "../domain/ledger-direction.ts";
import { Money, type MoneyProps } from "../domain/money.ts";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction.ts";
import type { Wallet } from "../domain/wallet.ts";
import { IdempotencyConflictError } from "./errors/idempotency-conflict-error.ts";
import { KindNotSubmittableError } from "./errors/kind-not-submittable-error.ts";
import { UnresolvablePendingReferenceError } from "./errors/unresolvable-pending-reference-error.ts";
import { WalletNotFoundError } from "./errors/wallet-not-found-error.ts";
import { OutboxEventRecorder } from "./outbox-event-recorder.ts";
import { payloadHashOf } from "./payload-hash.ts";
import type { Clock } from "./ports/clock.ts";
import type { IdGenerator } from "./ports/id-generator.ts";
import type { TransactionalRepositories, UnitOfWork } from "./ports/unit-of-work.ts";
import { decideReversal, isReversalKind, type ReversalKind } from "./reversal-policy.ts";
import type { TransactionOutcome } from "./transaction-outcome.ts";

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
 *
 * **O que este arquivo deixou de fazer, por D-066:** decidir a reversão — que é
 * `decideReversal`, em `reversal-policy.ts` — e traduzir desfecho em evento —
 * que é `OutboxEventRecorder`. O que sobra aqui é orquestração: travar, conferir
 * idempotência, decidir, persistir na ordem das chaves estrangeiras e registrar a
 * entrega. A movimentação de saldo **não** saiu, de propósito: ela é o assunto
 * desta transação.
 */
export class ProcessWagerTransaction {
  /**
   * Emissor dos eventos do desfecho (D-066, RF-25).
   *
   * Construído aqui, e não injetado: ele não tem estado nem configuração — só o
   * `IdGenerator` que este use case já recebe —, então exigi-lo no construtor
   * espalharia uma dependência a mais por cada composição do grafo, sem dar a
   * ninguém a chance de trocá-la por outra coisa.
   */
  private readonly events: OutboxEventRecorder;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    this.events = new OutboxEventRecorder(ids);
  }

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
   * Reprocessa uma transação que ficou esperando a referência (RF-26, RN-15).
   *
   * **Segunda entrada do mesmo use case, e não um use case novo** (D-054): a
   * decisão de uma reversão é uma só — RN-04 a RN-10, na ordem de D-051 —, e
   * `decideReversal` é o único lugar que a implementa. Um segundo objeto com as
   * mesmas regras seria a forma mais fácil de o worker e a submissão divergirem
   * justamente no ponto em que a divergência move dinheiro.
   *
   * Três desfechos possíveis, todos numa transação SQL única (RF-23):
   *
   *  - a referência chegou e é válida → `PROCESSED`, com saldo, lançamento e
   *    eventos, exatamente como se a reversão tivesse chegado depois dela;
   *  - a referência chegou e é inválida → `REJECTED` com o código de D-051;
   *  - a referência continua ausente → nada é escrito, e o status devolvido diz
   *    ao worker que ele precisa reagendar (D-052). Passado o `deadline`, essa
   *    espera vira `REJECTED` com `REFERENCE_NOT_FOUND` (RF-26).
   *
   * @param deadline instante-limite de nascimento: uma transação criada **antes**
   * dele esgotou o TTL de D-008. Chega por parâmetro, e não lido do ambiente, pelo
   * mesmo motivo de D-022 — política é da infraestrutura, e o use case não a lê.
   * @returns o status da transação ao fim da tentativa, ou `undefined` se a linha
   * não existe. `PENDING_REFERENCE` significa "ainda esperando, reagende".
   * @throws UnresolvablePendingReferenceError se a linha não for uma reversão.
   */
  async resolvePendingReference(
    transactionId: string,
    deadline: Date,
  ): Promise<WagerTransactionStatus | undefined> {
    return this.unitOfWork.run(async (repos) => {
      const now = this.clock.now();

      // Leitura sem lock, e só para descobrir **qual wallet travar**: o lock de
      // D-002 é por wallet, e não há como pedi-lo antes de saber o id dela.
      const candidate = await repos.transactions.findById(transactionId);

      if (candidate === undefined) {
        return undefined;
      }

      const wallet = await repos.wallets.findByIdForUpdate(candidate.walletId);

      if (wallet === undefined) {
        // Inalcançável: `fk_wager_transactions_wallet` (E-05) impede uma transação
        // apontar para wallet inexistente. Fica como guarda, e não como `?? `,
        // porque seguir sem wallet seria decidir uma reversão sem saldo nenhum.
        throw new WalletNotFoundError(candidate.walletId);
      }

      // Relê **sob o lock**. É esta segunda leitura que impede dois workers de
      // resolverem a mesma transação: o segundo espera o `FOR UPDATE` do primeiro,
      // e quando entra já enxerga o commit dele. Mesma lição de E-10 — quem
      // garante correção é o lock dentro da transação, não a varredura, que
      // deliberadamente não trava nada.
      const transaction = await repos.transactions.findById(transactionId);

      if (
        transaction === undefined ||
        transaction.status !== WagerTransactionStatus.PendingReference
      ) {
        // Outro worker chegou primeiro, ou a linha sumiu. Nada a fazer e —
        // importante — nada a reagendar: o status devolvido já diz isso.
        return transaction?.status;
      }

      const kind = transaction.kind;

      if (!isReversalKind(kind)) {
        throw new UnresolvablePendingReferenceError(transaction.id, kind);
      }

      const decided = await this.applyReversal(
        repos,
        wallet,
        transaction,
        transaction.money,
        kind,
        now,
      );

      if (decided.outcome === "pending-reference") {
        // Dentro do prazo: a referência ainda pode chegar (RN-15). **Nada é
        // escrito aqui** — o reagendamento é estado operacional e sai por `UPDATE`
        // direto no worker (D-052), fora do agregado e fora desta transação.
        if (transaction.createdAt > deadline) {
          return WagerTransactionStatus.PendingReference;
        }

        // TTL de D-008 esgotado. A espera vira rejeição terminal e auditável, com
        // o código que manda o provedor parar de esperar (RF-26, D-007).
        const expired = this.rejectWith(
          transaction,
          wallet,
          BusinessFailureCode.ReferenceNotFound,
        );

        await this.settle(repos, transaction, wallet, expired, now);

        return transaction.status;
      }

      await this.settle(repos, transaction, wallet, decided, now);

      return transaction.status;
    });
  }

  /**
   * Persiste o desfecho de uma transação **que já existe** (RF-23, RF-25).
   *
   * Espelho do trecho final de `process()`, com `update` no lugar do `insert` e
   * sem inbox: a resolução de RF-26 não vem de entrega nenhuma. A ordem é a mesma
   * — transação, saldo, lançamento, eventos —, e por isso o lançamento nunca
   * referencia uma linha que ainda não foi escrita.
   *
   * A correlação vem da própria transação (D-055). Linha anterior à `m0003` não
   * tem correlação guardada e cai no id gerado, que é o fallback de D-039: sem
   * ele, o desfecho sairia sem rastro nenhum. O `causationId` é a transação —
   * quem causou este evento foi ela, ao ser resolvida.
   */
  private async settle(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    result: TransactionOutcome,
    now: Date,
  ): Promise<void> {
    await repos.transactions.update(transaction);

    if (result.outcome === "processed" && result.entry !== undefined) {
      await repos.wallets.update(wallet);
      await repos.ledger.insert(result.entry);
    }

    await this.events.record(
      repos.outbox,
      {
        correlationId: transaction.correlationId ?? this.ids.next(),
        causationId: transaction.id,
      },
      transaction,
      wallet,
      result,
      now,
    );
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
      // `observedBalance` só é `undefined` em transação sem desfecho, que
      // significa `PENDING_REFERENCE`. Por D-053, a resposta `202` de RN-15
      // devolve o saldo **corrente** da wallet travada: não há desfecho a
      // preservar, e congelar um saldo aqui daria à espera a aparência de um
      // resultado que ela não é.
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
      // Guardada na linha (D-055): quando esta transação for um `REFUND`/`ROLLBACK`
      // que fica esperando, o evento do desfecho vai ser publicado pelo worker de
      // RF-26 — fora desta requisição, e sem outra fonte de correlação.
      correlationId: command.correlationId,
      createdAt: now,
    });

    const result = await this.decide(repos, wallet, transaction, money, now);

    // A transição para `PENDING_REFERENCE` acontece **aqui**, e não dentro de
    // `decideReversal`, porque o mesmo desfecho tem dois chamadores com origens
    // diferentes: uma transação nova precisa sair de `PENDING`, e a que o worker
    // de RF-26 relê já **está** em `PENDING_REFERENCE`. D-013 não tem self-loop,
    // então re-marcá-la lançaria. Quem sabe de onde a transação vem é quem
    // transiciona; `decideReversal` só decide.
    if (result.outcome === "pending-reference") {
      transaction.markPendingReference();
    }

    // Um único `insert`, já no estado final desta passagem: a decisão inteira
    // acontece dentro desta transação SQL, então não existe instante em que
    // alguém possa observar a linha em `PENDING`. Inserir e depois atualizar
    // custaria um comando a mais para representar um estado que ninguém consegue
    // ler. `PENDING_REFERENCE` é o único desfecho não terminal, e quem o resolve
    // depois é `resolvePendingReference`, chamado pelo worker de RF-26.
    await repos.transactions.insert(transaction);

    // `entry === undefined` é `LOSS` (RN-03): transação aplicada, saldo intacto,
    // nenhum lançamento. Nem a wallet é reescrita — `version` só incrementa
    // quando o saldo muda (RF-02), e um `update` aqui gravaria a mesma linha.
    if (result.outcome === "processed" && result.entry !== undefined) {
      await repos.wallets.update(wallet);
      await repos.ledger.insert(result.entry);
    }

    await this.recordInbox(repos, command, payloadHash, now);
    await this.events.record(repos.outbox, command, transaction, wallet, result, now);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      // `undefined` só em `PENDING_REFERENCE`: `markPendingReference` não observa
      // saldo (D-030), porque aguardar referência não é desfecho. Nesse caso vale
      // o saldo corrente da wallet travada (D-053). Nos outros dois,
      // `markProcessed`/`reject` já gravaram.
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
        return this.applyReversal(repos, wallet, transaction, money, kind, now);

      case WagerTransactionKind.Opening:
        // Inalcançável pelas duas bordas, que já barram `OPENING` no parser
        // (RN-13). Fica como guarda para quem chamar este use case por dentro do
        // sistema: a `OPENING` legítima nasce em `OpenWallet`, e só lá.
        throw new KindNotSubmittableError(kind);
    }
  }

  /**
   * Aplica ao agregado o veredito da política de reversão (RN-04..RN-10, D-066).
   *
   * A decisão inteira mora em `decideReversal`; o que acontece aqui é a
   * tradução dela em efeito — esperar, rejeitar com o código que a política
   * escolheu, ou mover o saldo na direção que ela calculou. A separação é o
   * ponto de D-066: quem decide não muta, e quem muta não decide.
   *
   * O único código que **não** vem da política é
   * `INSUFFICIENT_FUNDS_ON_REVERSAL` (RN-16): ele depende do saldo da wallet
   * travada, e não da referência, então continua sendo decidido aqui — junto do
   * saldo que o justifica.
   */
  private async applyReversal(
    repos: TransactionalRepositories,
    wallet: Wallet,
    transaction: WagerTransaction,
    money: Money,
    kind: ReversalKind,
    now: Date,
  ): Promise<TransactionOutcome> {
    const verdict = await decideReversal(repos.transactions, transaction, money, kind);

    if (verdict.verdict === "wait") {
      return { outcome: "pending-reference" };
    }

    if (verdict.verdict === "reject") {
      return this.rejectWith(transaction, wallet, verdict.failureCode);
    }

    return this.applyMovement(verdict.direction, wallet, transaction, money, now, {
      undefinedReferenceId: false,
      referenceId: verdict.referenceId,
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
