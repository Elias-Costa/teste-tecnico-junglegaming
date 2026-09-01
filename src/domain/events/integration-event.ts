/** Campos comuns a todo evento de integração (RF-07, §11). */
export interface IntegrationEventProps<T> {
  /** UUIDv7 do evento — injetado, como todo id de entidade (D-014). */
  eventId: string;
  /** Agregado de origem: a transação ou a wallet, conforme o evento. */
  aggregateId: string;
  /** Correlação de ponta a ponta, exigida nos logs por RNF-06. */
  correlationId: string;
  /** Id do evento ou comando que causou este. Ausente na origem da cadeia. */
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

/**
 * Contexto de rastreio, montado pela camada de aplicação a cada publicação.
 *
 * Separado das props porque é o que **não** vem do agregado: as factories `from`
 * de cada evento derivam `aggregateId` e `data` da entidade e recebem daqui o
 * resto. Sem essa separação, cada `from` teria de repetir cinco parâmetros soltos.
 */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

/**
 * Envelope serializado, gravado no `payload` da outbox (RF-07).
 *
 * Declarado como **type alias** e não como `interface` por uma razão técnica:
 * só o alias ganha índice implícito de string, o que o torna atribuível ao
 * `Readonly<Record<string, unknown>>` do `payload` de `OutboxMessage`. Com
 * `interface`, o compilador recusaria e a saída teria de passar por um `as`,
 * que AGENTS.md §4 proíbe.
 */
export type IntegrationEventEnvelope<T> = {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601 (RF-07). String, não `Date`: o payload precisa ser JSON estável. */
  occurredAt: string;
  version: number;
  data: Readonly<T>;
};

/**
 * Envelope base dos eventos de integração (RF-07, RF-25).
 *
 * **Abstrata com uma subclasse concreta por evento**, por exigência do enunciado:
 * `eventType` e `version` ficam no tipo, nunca como string solta no call site.
 * A diferença prática é que um erro de digitação em `"WagerTransactionProcesed"`
 * vira erro de compilação em vez de um evento que ninguém consome e que só
 * aparece quando alguém for procurar por que a integração não recebeu nada.
 *
 * `data` carrega **`MoneyProps`, nunca `Money`** — o payload atravessa processo
 * e versão, e uma instância com `bigint` privado não sobrevive a `JSON.stringify`
 * (RF-07, EL-01).
 */
export abstract class IntegrationEvent<T> {
  /** Nome estável do evento no contrato de integração. Fixado pela subclasse. */
  abstract readonly eventType: string;
  /** Versão do contrato. Muda quando `data` muda de forma. */
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  /**
   * Envelope serializado que a outbox grava (RF-07).
   *
   * `causationId` ausente sai como **chave omitida**, não como `undefined`
   * explícito: o objeto devolvido aqui é literalmente o que vai para a coluna
   * `jsonb`, e `JSON.stringify` já descartaria a chave — deixá-la no objeto em
   * memória faria a forma em memória divergir da forma persistida, que é o tipo
   * de diferença que só aparece quando alguém compara os dois num incidente.
   */
  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };

    return this.causationId === undefined
      ? envelope
      : { ...envelope, causationId: this.causationId };
  }
}
