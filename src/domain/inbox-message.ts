/** Dados de uma mensagem recém-recebida da fila (RF-05, §6.5). */
export interface ReceiveInboxProps {
  /**
   * Id que o **produtor** carimbou no corpo da mensagem (D-044).
   *
   * É o campo `messageId` do envelope que o enunciado (§10) publica, e não o
   * `MessageId` que o SQS atribui no envio: os dois cobrem a redelivery, mas só
   * o do corpo é estável quando o **produtor** reenvia a mesma operação lógica.
   * O id de transporte serve a diagnóstico e não entra em chave nenhuma.
   */
  messageId: string;
  /** Quem consumiu. A dedupe é por consumidor, não global (RF-19). */
  consumerName: string;
  /** Hash canônico do payload recebido (D-005). */
  payloadHash: string;
  receivedAt: Date;
}

/** Estado persistido: o que `receive` grava mais o instante de conclusão. */
export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

/**
 * Registro de deduplicação de mensagens consumidas (RF-05, RF-19, EL-05).
 *
 * A identidade é o par `(consumerName, messageId)` — não há id próprio, e é de
 * propósito: quem garante a unicidade é o `UNIQUE (consumer_name, message_id)`
 * de E-05, no banco (RI-09). Um id sintético daria a impressão de que a entidade
 * se identifica sozinha e deixaria a garantia real fora de vista.
 *
 * A dedupe é **por consumidor**: a mesma mensagem entregue a dois consumidores
 * diferentes é trabalho legítimo dos dois, e colapsar isso numa chave global
 * faria o segundo consumidor perder a mensagem em silêncio.
 *
 * **Não guarda payload nem resultado** — só o hash. O resultado do replay vem da
 * transação financeira (RN-12), que é quem tem a resposta original com o saldo
 * observado à época.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  /** Registra uma mensagem recebida, ainda não processada. */
  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  /**
   * Reconstrói um registro já persistido.
   *
   * **Não revalida** (§6.0): reconstrói o estado como está no banco.
   */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /**
   * Verdadeiro se a mensagem já foi processada até o commit.
   *
   * É esta a pergunta que abre o consumo em E-11 e evita o efeito duplicado de
   * uma reentrega (RF-19). O `ack` só acontece depois do commit (RF-20), então
   * um registro marcado significa que a transação financeira **fechou**.
   */
  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /**
   * Marca a conclusão do processamento.
   *
   * Sem guarda contra remarcação de propósito: quem decide pular a mensagem é o
   * `isProcessed()` no início do consumo (E-11), não uma exceção aqui. Fazer
   * disto uma transição guardada transformaria uma reentrega — que é normal em
   * entrega at-least-once — em erro, e o consumidor teria de tratar como falha
   * algo que o desenho já considera esperado.
   */
  markProcessed(at: Date): void {
    this._processedAt = at;
  }
}
