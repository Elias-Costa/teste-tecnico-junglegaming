import type { IntegrationEvent } from "./events/integration-event.ts";
import { backoffDelayMs, type RetryPolicy } from "./retry-policy.ts";

/** Enfileiramento de um evento recém-produzido (RF-06). */
export interface EnqueueOutboxProps<T> {
  /** UUIDv7 da linha da outbox — injetado, como todo id (D-014). */
  id: string;
  event: IntegrationEvent<T>;
}

/** Estado persistido da linha da outbox (RF-06, D-009). */
export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
  /** Instância que reivindicou a linha (D-009). */
  lockedBy?: string | undefined;
  /** Fim do lease. Passado esse instante, outra instância pode reivindicar. */
  lockedUntil?: Date | undefined;
}

/**
 * Evento de integração pendente de publicação (RF-06, RF-23, RI-04, EL-06).
 *
 * É o que torna a publicação atômica com o dinheiro: o evento é gravado aqui na
 * **mesma transação SQL** que altera saldo e ledger (RF-23), e só depois um
 * worker separado o publica (E-10). Publicar direto do use case criaria a janela
 * clássica — commit no banco e falha no SQS, ou o inverso — que é exatamente a
 * falha eliminatória EL-06.
 *
 * A entidade é **dado, não publicação**: não conhece SQS nem cliente nenhum. O
 * `payload` já chega serializado (`event.toJSON()`) porque a linha precisa
 * sobreviver a mudanças de código — reidratar uma classe de evento de seis meses
 * atrás para republicá-la seria acoplar a fila ao código vigente.
 *
 * **Lease (D-009):** `lockedBy`/`lockedUntil` existem aqui como estado e como
 * consulta (`isClaimed`). A reivindicação em si é o `UPDATE ... RETURNING` com
 * `SKIP LOCKED` de E-10 — disputa entre publishers é do banco, não de uma
 * instância em memória, que não teria como sustentar essa garantia.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lockedBy: string | undefined,
    private _lockedUntil: Date | undefined,
  ) {}

  /**
   * Enfileira um evento para publicação.
   *
   * Nasce sem `nextAttemptAt`: a primeira tentativa é imediata, e o backoff só
   * começa a existir depois de uma falha (`scheduleRetry`). Agendar a primeira
   * tentativa para o futuro atrasaria todo evento bem-sucedido para proteger do
   * caso raro.
   */
  static enqueue<T>(props: EnqueueOutboxProps<T>): OutboxMessage {
    return new OutboxMessage(
      props.id,
      props.event.aggregateId,
      props.event.eventType,
      props.event.toJSON(),
      props.event.occurredAt,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  /**
   * Reconstrói uma linha já persistida.
   *
   * **Não revalida** (§6.0). Vale em especial para `attempts` e para o lease: o
   * worker de E-10 os altera por `UPDATE` direto, e recusar aqui um valor que o
   * banco já aceitou travaria a retomada em vez de protegê-la.
   */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lockedBy,
      state.lockedUntil,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lockedBy(): string | undefined {
    return this._lockedBy;
  }

  get lockedUntil(): Date | undefined {
    return this._lockedUntil;
  }

  /** Verdadeiro enquanto o evento não foi publicado. */
  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /**
   * Verdadeiro se a mensagem está pendente e o backoff já venceu.
   *
   * Olha **só** o agendamento, não o lease: são duas perguntas distintas — "já é
   * hora?" e "alguém já pegou?" — e o segundo é resolvido pelo `SKIP LOCKED` do
   * banco em E-10. Fundir as duas aqui daria à entidade uma opinião sobre
   * concorrência que uma instância em memória não tem como sustentar.
   */
  isDue(now: Date): boolean {
    if (!this.isPending()) {
      return false;
    }

    return this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime();
  }

  /**
   * Verdadeiro se há um lease **em vigor** sobre a linha (D-009).
   *
   * Lease vencido conta como livre: é justamente o que permite outra instância
   * assumir quando a primeira morreu entre o commit e a publicação — o cenário
   * obrigatório de RF-24.
   */
  isClaimed(now: Date): boolean {
    return this._lockedUntil !== undefined && this._lockedUntil.getTime() > now.getTime();
  }

  /**
   * Marca a publicação bem-sucedida.
   *
   * Sem guarda contra remarcação: D-009 assume entrega **at-least-once** — um
   * crash entre o publish e esta marcação faz o lease vencer e outra instância
   * republicar. Transformar o segundo caminho em exceção converteria em erro um
   * comportamento que a decisão já aceitou como custo.
   */
  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /**
   * Incrementa as tentativas e agenda a próxima com equal jitter (RF-06, D-022).
   *
   * A curva é `backoffDelayMs`, em `retry-policy.ts`: ela é compartilhada com o
   * consumidor SQS de E-11, que precisa do mesmo atraso para o
   * `ChangeMessageVisibility` de um erro transitório. D-008 pede **uma** curva
   * para os três loops, e mantê-la aqui dentro obrigaria o segundo consumidor a
   * reescrevê-la.
   */
  scheduleRetry(now: Date, policy: RetryPolicy): void {
    // O expoente é a contagem **antes** do incremento, para que a primeira falha
    // agende no degrau base e não já no dobro dele. `backoffDelayMs` devolve
    // milissegundo inteiro, que é o que `nextAttemptAt` precisa: a coluna é
    // `timestamptz` e uma fração de ms não sobreviveria ao round-trip de E-05.
    const delayMs = backoffDelayMs(this._attempts, policy);

    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}
