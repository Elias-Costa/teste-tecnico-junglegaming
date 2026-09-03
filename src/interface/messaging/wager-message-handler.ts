import type { InboxLookup } from "../../application/inbox-lookup.ts";
import type { Logger } from "../../application/ports/logger.ts";
import {
  recordDuplicate,
  recordSubmission,
  startProcessingTimer,
} from "../../infrastructure/observability/metrics.ts";
import { IdempotencyConflictError } from "../../application/errors/idempotency-conflict-error.ts";
import { WalletNotFoundError } from "../../application/errors/wallet-not-found-error.ts";
import type { ProcessWagerTransaction } from "../../application/process-wager-transaction.ts";
import type {
  MessageDisposition,
  MessageHandler,
  ReceivedMessage,
} from "../../infrastructure/messaging/message-handler.ts";
import { isTransientDatabaseError, violatedConstraintOf } from "../../infrastructure/persistence/transient-error.ts";
import { KindNotSubmittableError } from "../../application/errors/kind-not-submittable-error.ts";
import { WAGER_TRANSACTIONS_CONSUMER } from "./consumer-name.ts";
import { parseWagerMessage } from "./dto/parse-wager-message.ts";

/**
 * Chave primária da inbox (D-025), pelo nome que a migration de E-05 lhe deu.
 *
 * Violá-la significa uma coisa só: outra instância registrou **esta mesma
 * entrega** e commitou primeiro. Não é bug, é a corrida acontecendo no lugar
 * certo — no banco (RI-09), como manda EL-05.
 */
const INBOX_PRIMARY_KEY = "pk_inbox_messages";

/**
 * A borda de mensageria: envelope da fila → use case → desfecho de entrega.
 *
 * **Reutiliza o use case da entrada HTTP** (RF-18). Não há aqui nenhuma regra de
 * negócio, nenhum acesso a repositório de dinheiro e nenhum `EntityManager`: o
 * que esta classe faz é traduzir entrada, delegar e classificar o que voltou.
 *
 * Vive em `src/interface/` e não em `src/infrastructure/` porque é uma **borda**,
 * irmã do controller HTTP — e a regra de lint que veta `@aws-sdk/*` aqui é o que
 * garante que ela continue sem saber o que é SQS. Quem fala com a fila é
 * `SqsWagerConsumer`, do outro lado da porta `MessageHandler`.
 *
 * ### A classificação, e por que ela não é "negócio vs. infraestrutura"
 *
 * O critério de D-048 é **deixou rastro ou não deixou**. Uma rejeição por saldo
 * insuficiente commita linha `REJECTED` e publica `WagerTransactionRejected`: o
 * provedor fica sabendo, e o `ack` fecha o assunto. Já `WALLET_NOT_FOUND`,
 * `IDEMPOTENCY_CONFLICT` e `KIND_NOT_SUBMITTABLE` fazem rollback e não deixam
 * linha, evento nem resposta — pela fila não existe o `422` do HTTP. Dar `ack`
 * neles apagaria a mensagem sem deixar traço em lugar nenhum, então vão à DLQ.
 */
export class WagerMessageHandler implements MessageHandler {
  /**
   * @param logger obrigatório e **antes** do `consumerName`, que tem default
   * (D-061). Um logger opcional viraria, na primeira composição distraída, um
   * consumidor que manda mensagem para a DLQ sem deixar rastro — e a mensagem que
   * foi para a DLQ é exatamente a que alguém vai investigar.
   */
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly inbox: InboxLookup,
    private readonly logger: Logger,
    private readonly consumerName: string = WAGER_TRANSACTIONS_CONSUMER,
  ) {}

  /**
   * Processa uma entrega e diz ao transporte o que fazer com ela (RF-19..RF-21).
   *
   * A ordem dos passos é a decisão deste método: o parse acontece **antes** da
   * consulta à inbox porque é o parse que produz a chave (D-044), e a consulta
   * acontece antes do use case porque uma reentrega já processada não deve custar
   * uma transação nova (RF-19).
   */
  async handle(message: ReceivedMessage): Promise<MessageDisposition> {
    let parsed;

    try {
      parsed = parseWagerMessage(parseJson(message.body));
    } catch {
      // Payload que não abre não tem como ser reprocessado nem identificado pela
      // inbox — nem o `messageId` de D-044 está disponível. Reenviar não conserta.
      // O `transportMessageId` é o **único** identificador que sobrou, e é
      // exatamente para este caso que `ReceivedMessage` o carrega.
      this.logger.warn("wager.message.unparseable", { messageId: message.transportMessageId });

      return "dead-letter";
    }

    const { command } = parsed;

    try {
      if (await this.inbox.wasProcessed(this.consumerName, parsed.messageId)) {
        // A linha de inbox só existe se a transação financeira dela commitou
        // (RF-23): "já processada" e "o dinheiro já se moveu" são a mesma
        // afirmação, e é ela que autoriza o `ack` sem refazer trabalho (RF-19).
        //
        // Conta como duplicata (D-010): é o dedup de inbox, o irmão pela fila do
        // replay idempotente de RF-14 — e a reentrega **não** vira transação, por
        // isso não passa por `recordSubmission`.
        recordDuplicate("sqs");

        this.logger.info("wager.message.duplicate", {
          correlationId: command.correlationId,
          messageId: parsed.messageId,
          walletId: command.walletId,
          providerId: command.providerId,
        });

        return "ack";
      }

      // Cronômetro de `wager_processing_seconds{source="sqs"}`. O mesmo use case
      // do HTTP (RF-18), medido pela borda que o chamou — é o label `source` que
      // separa uma API lenta de um consumidor lento.
      const stopTimer = startProcessingTimer("sqs");

      try {
        const result = await this.processWagerTransaction.execute({
          ...command,
          inbox: { consumerName: this.consumerName, messageId: parsed.messageId },
        });

        recordSubmission({
          source: "sqs",
          status: result.status,
          kind: command.kind,
          idempotentReplay: result.idempotentReplay,
        });

        this.logger.info("wager.message.processed", {
          correlationId: command.correlationId,
          messageId: parsed.messageId,
          transactionId: result.transactionId,
          walletId: command.walletId,
          providerId: command.providerId,
          kind: command.kind,
          status: result.status,
          failureCode: result.failureCode,
        });
      } finally {
        stopTimer();
      }

      // Chegou aqui, commitou. O `ack` de RF-20 acontece depois deste retorno,
      // no transporte — nunca antes, porque o transporte só age sobre o desfecho.
      return "ack";
    } catch (error) {
      const disposition = dispositionFor(error);

      // O log do desfecho de erro é o que RNF-06 pede e o que faltava: sem ele,
      // uma mensagem que foi para a DLQ some do processo sem deixar rastro — e é
      // justamente a que alguém vai investigar.
      this.logger.error(`wager.message.${disposition}`, error, {
        correlationId: command.correlationId,
        messageId: parsed.messageId,
        walletId: command.walletId,
        providerId: command.providerId,
        kind: command.kind,
      });

      return disposition;
    }
  }
}

/**
 * Traduz a exceção que escapou do use case em destino de entrega (RF-21).
 *
 * A ordem importa em um ponto: a violação da inbox é checada **antes** dos erros
 * de negócio, porque ela é um `23505` que nada tem a ver com regra nenhuma — é a
 * corrida perdida, e o desfecho dela é o mesmo de uma reentrega comum.
 */
function dispositionFor(error: unknown): MessageDisposition {
  if (isTransientDatabaseError(error)) {
    // A **mesma** função que decide o `503` da borda HTTP (D-037): RF-21 precisa
    // exatamente da mesma classificação, e duas listas de SQLSTATE divergiriam.
    // Nada de status é tocado (D-013) — na prática nem há linha para tocar, porque
    // a transação inteira sofreu rollback (D-047).
    return "retry";
  }

  if (violatedConstraintOf(error) === INBOX_PRIMARY_KEY) {
    // Outra instância registrou esta entrega e commitou primeiro. O dinheiro se
    // moveu uma vez só — é o que EL-03 cobra — e esta cópia não tem trabalho.
    return "ack";
  }

  if (
    error instanceof WalletNotFoundError ||
    error instanceof IdempotencyConflictError ||
    error instanceof KindNotSubmittableError
  ) {
    // Os três erros de negócio que não deixam rastro (D-048). `IDEMPOTENCY_CONFLICT`
    // é o mais valioso dos três na DLQ: significa que o produtor reusou uma key
    // com payload diferente, que é bug do lado dele.
    return "dead-letter";
  }

  // Tudo o mais: `InvalidMoneyError`, `MissingReferenceError` (D-020),
  // `InvalidLedgerEntryError` (D-021) e qualquer defeito nosso. Reenviar não
  // conserta payload inválido nem bug, e insistir bloquearia o `MessageGroupId`
  // por cinco entregas inúteis (D-046).
  return "dead-letter";
}

/**
 * `JSON.parse` que não devolve `any`.
 *
 * O tipo declarado de `JSON.parse` é `any`, e deixá-lo entrar contaminaria o
 * parser inteiro — que existe justamente para tratar entrada como `unknown` até
 * cada campo ser verificado (D-038).
 */
function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}
