import { InvalidTransactionStateError } from "./errors/invalid-transaction-state-error.ts";
import { MissingReferenceError } from "./errors/missing-reference-error.ts";
import { NoLedgerDirectionError } from "./errors/no-ledger-direction-error.ts";
import type { BusinessFailureCode, FailureCode, InfrastructureFailureCode } from "./failure-code.ts";
import { LedgerDirection } from "./ledger-direction.ts";
import type { Money } from "./money.ts";

/** Operações suportadas (§6.3). `OPENING` é interna — RN-13 a barra na borda. */
export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

/** Ciclo de vida da transação (§6.3). Os três últimos são terminais. */
export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = "PENDING",
  /** Aguardando a transação referenciada chegar (RN-15, RF-26). */
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  /**
   * Erro permanente de infraestrutura — **reservado, sem emissor nesta entrega**
   * (D-047, D-064).
   *
   * Existe porque a §6.3 do enunciado o define e porque D-013 o mantém no grafo
   * de transições, no `CHECK` do schema e na análise de referência terminal de
   * D-050. Mas nada o escreve, e isso é decisão registrada, não descuido: a
   * falha permanente do consumidor faz rollback e não deixa linha onde marcar, e
   * o esgotamento do TTL da referência é `REJECTED` por força da §7.1. Gravá-lo
   * numa segunda transação ocuparia a `idempotencyKey` da operação e faria o
   * reenvio legítimo responder replay de uma falha — perda definitiva no lugar de
   * um incidente recuperável.
   */
  Failed = "FAILED",
}

/**
 * Grafo de transições de D-013 — **fonte única** do ciclo de vida.
 *
 * Duas propriedades foram decididas e estão codificadas aqui:
 *
 * - **sem self-loop e sem volta para `PENDING`**: o reagendamento de uma
 *   referência ausente é `UPDATE` nas colunas `reference_attempts` e
 *   `next_reference_attempt_at` (E-05), não transição — é o que D-052 confirmou
 *   ao dar essas colunas ao `PendingReferenceStore`. Status é estado de negócio;
 *   contador de tentativa é dado operacional, e misturar os dois esconderia um
 *   contador dentro do grafo. A consequência direta aparece em `resolvePendingReference`:
 *   quem relê uma pendente **não** a re-marca, porque a transição não existe.
 * - **terminal é "não tem saída"**: `isTerminal()` lê deste mesmo mapa em vez de
 *   manter uma segunda lista de status terminais, que poderia divergir dele.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Kinds que exigem `referenceExternalTransactionId` (RN-06). */
const KINDS_REQUIRING_REFERENCE: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** Identidade e payload da transação — imutáveis do nascimento ao terminal. */
export interface CreateWagerTransactionProps {
  /** UUIDv7 interno (D-014). */
  id: string;
  providerId: string;
  /** Id da transação no provedor — a metade externa de `(providerId, externalTransactionId)`. */
  externalTransactionId: string;
  /** Fonte da verdade da idempotência (RF-14). */
  idempotencyKey: string;
  /** SHA-256 canônico dos 10 campos de negócio (D-005). */
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id **no provedor** da transação referenciada, não o id interno (RN-07). */
  referenceExternalTransactionId?: string | undefined;
  /**
   * Correlação de ponta a ponta da submissão que criou esta transação (RNF-06, D-055).
   *
   * Guardada na transação porque **nem todo evento dela nasce numa requisição**:
   * o worker de RF-26 resolve uma `PENDING_REFERENCE` minutos depois, fora de
   * qualquer chamada, e sem este campo o evento daquele desfecho teria de
   * inventar uma correlação — rompendo o rastro justamente no ponto mais difícil
   * de reconstruir depois.
   *
   * **Não participa do `payloadHash`** (D-005): a lista canônica tem 10 campos de
   * negócio, e a §9 do enunciado proíbe metadado de transporte no hash. Dois
   * reenvios do mesmo payload com correlações diferentes continuam sendo o mesmo
   * replay (RN-12).
   */
  correlationId: string;
  createdAt: Date;
}

/**
 * Estado persistido: a identidade acima mais o que as transições escrevem.
 *
 * `correlationId` é o único campo que afrouxa na volta, e o `Omit` diz por quê:
 * toda transação **criada** carrega correlação, mas uma linha gravada antes da
 * `m0003` não tem a coluna preenchida, e `rehydrate` não revalida nada (§6.0).
 */
export interface WagerTransactionState
  extends Omit<CreateWagerTransactionProps, "correlationId"> {
  correlationId?: string | undefined;
  status: WagerTransactionStatus;
  /** Id **interno** da referência, resolvido no processamento (RN-07). */
  referenceTransactionId?: string | undefined;
  /**
   * Saldo da wallet no instante em que a transação foi resolvida (RN-12, D-030).
   *
   * Ausente enquanto o desfecho não chegou. É o que o replay devolve — não o
   * saldo atual —, e por isso é gravado junto da transição que o observou.
   */
  observedBalance?: Money | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
}

/**
 * Transação de aposta — a unidade de trabalho do processamento (RF-03).
 *
 * Concentra o ciclo de vida (D-013) e as consultas que o use case faz antes de
 * tocar saldo ou ledger. **Não** conhece wallet, repositório nem fila: quem
 * orquestra é o use case de E-07, dentro de uma transação SQL única (RF-23).
 */
export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  /** Correlação da submissão que a criou (D-055). Ausente em linha anterior à `m0003`. */
  public readonly correlationId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _observedBalance: Money | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;

  /**
   * Recebe o estado inteiro num objeto, não em parâmetros posicionais.
   *
   * A entidade tem nove campos de identificação em `string`; posicionalmente,
   * trocar `providerId` por `playerId` compila e vira bug silencioso de
   * roteamento financeiro. Nomear os campos fecha essa porta no compilador.
   */
  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.correlationId = state.correlationId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._observedBalance = state.observedBalance;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
  }

  /**
   * Nasce em `PENDING` e valida a exigência de referência por kind (§6.3).
   *
   * A ausência de referência em `REFUND`/`ROLLBACK` é **payload inválido**
   * (D-020), não rejeição de negócio: nenhuma transação chega a existir e D-006
   * mapeia para `400`. Não valida RN-13 aqui — `OPENING` submetido externamente
   * é regra de borda (E-08), e esta mesma factory cria o `OPENING` interno.
   *
   * @throws MissingReferenceError se o kind exigir referência e ela não vier.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      KINDS_REQUIRING_REFERENCE.includes(props.kind) &&
      props.referenceExternalTransactionId === undefined
    ) {
      throw new MissingReferenceError(props.kind);
    }

    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending });
  }

  /**
   * Reconstrói uma transação já persistida.
   *
   * **Não revalida transições** (§6.0): uma transação em `PROCESSED` lida do
   * banco não é reconstruída passando por `PENDING`.
   */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  /** Saldo observado no desfecho — a resposta que o replay repete (RN-12, D-030). */
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /**
   * Marca a transação como aplicada.
   *
   * @param referenceTransactionId id interno da referência resolvida, quando houver (RN-07).
   * @param observedBalance saldo da wallet **depois** da aplicação — a resposta
   * que RN-12 manda repetir no replay (D-030). Recebido em vez de derivado
   * porque a transação não conhece a wallet: quem acabou de mover o saldo é o
   * use case, e é ele que tem o valor exato do instante.
   * @throws InvalidTransactionStateError se o status atual não permitir (D-013).
   */
  markProcessed(
    referenceTransactionId: string | undefined,
    observedBalance: Money,
    at: Date,
  ): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._processedAt = at;
  }

  /**
   * Marca que a referência ainda não chegou (RN-15, RF-26).
   *
   * Válida **apenas a partir de `PENDING`** (D-013): chamá-la sobre uma transação
   * já em `PENDING_REFERENCE` lança, porque o reagendamento do worker de E-13 é
   * `UPDATE` nas colunas de tentativa, não uma transição repetida.
   *
   * **Não observa saldo** (D-030, D-053): aguardar referência não é desfecho, e a
   * transação ainda vai passar por `markProcessed` ou `reject`. A resposta `202`
   * de RN-15 devolve o saldo **corrente** da wallet travada, e não um congelado
   * aqui — não há desfecho ainda a preservar.
   *
   * @throws InvalidTransactionStateError se o status atual não permitir.
   */
  markPendingReference(): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
  }

  /**
   * Rejeita por regra de negócio (RN-17).
   *
   * Aceita **apenas** códigos de negócio: D-013 reserva `FAILED` para
   * infraestrutura, e o tipo do parâmetro é o que impede os dois de se
   * misturarem sem depender de disciplina de quem escreve o use case.
   *
   * @param observedBalance saldo da wallet no instante da rejeição (RN-12, D-030).
   * A rejeição não move saldo (RN-11), mas responde um — e responder o saldo
   * atual num replay posterior é justamente o que RN-12 proíbe.
   * @throws InvalidTransactionStateError se o status atual não permitir.
   */
  reject(code: BusinessFailureCode, observedBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._observedBalance = observedBalance;
    this._failureCode = code;
  }

  /**
   * Marca falha permanente de infraestrutura ou esgotamento para DLQ (D-013).
   *
   * Erro **transitório não passa por aqui**: ele não toca o status e devolve a
   * mensagem para retry. Marcar `FAILED` em indisponibilidade momentânea do
   * Postgres queimaria transações recuperáveis, que é o oposto do cenário de
   * recuperação que a §3 do enunciado exige que funcione.
   *
   * **Não observa saldo** (D-030): falha de infraestrutura não é resposta de
   * negócio e não tem saldo a preservar — o processamento sequer chegou a olhar
   * a wallet em boa parte dos casos.
   *
   * @throws InvalidTransactionStateError se o status atual não permitir.
   */
  fail(code: InfrastructureFailureCode): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
  }

  /** Verdadeiro se o status atual não tem nenhuma transição de saída (D-013). */
  isTerminal(): boolean {
    return ALLOWED_TRANSITIONS[this._status].length === 0;
  }

  /** Falso só para `LOSS`, que registra o resultado sem mover saldo (RN-03). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** Verdadeiro para `REFUND` e `ROLLBACK` (RN-06). */
  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.includes(this.kind);
  }

  /**
   * Verdadeiro se o payload recebido é o mesmo já registrado sob esta key.
   *
   * É o teste de RN-14: mesma idempotency key com hash diferente é **conflito**,
   * não replay. A comparação é de hash canônico (D-005), não do payload cru.
   */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento que esta transação produz (RF-04).
   *
   * `ROLLBACK` é o único caso que não se decide pelo kind sozinho: RN-05 define o
   * efeito como o **inverso da referência**, então estornar uma `BET` credita e
   * estornar um `WIN` debita.
   *
   * @param reference transação referenciada, **obrigatória** para `ROLLBACK`.
   * @throws NoLedgerDirectionError para `LOSS` (que não gera lançamento, RN-03)
   * ou para `ROLLBACK` sem a referência resolvida.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new NoLedgerDirectionError(
            `ROLLBACK ${this.id} precisa da referência resolvida: a direção é o inverso dela (RN-05).`,
          );
        }

        return invert(reference.ledgerDirectionFor());
      }

      case WagerTransactionKind.Loss:
        throw new NoLedgerDirectionError(
          `LOSS ${this.id} não gera lançamento no ledger (RN-03). Consulte affectsBalance() antes.`,
        );
    }
  }

  /**
   * Aplica uma transição do grafo de D-013 ou lança.
   *
   * Ponto único de mudança de `_status`: nenhuma transição escreve o campo
   * direto, então não existe caminho que escape da validação.
   */
  private transitionTo(next: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this._status, next);
    }

    this._status = next;
  }
}

/** Inverte a direção de um lançamento — o estorno de RN-05. */
function invert(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}
