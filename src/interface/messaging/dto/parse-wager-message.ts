import type { ProcessWagerTransactionCommand } from "../../../application/process-wager-transaction.ts";
import { InvalidPayloadError } from "../../http/errors/invalid-payload-error.ts";
import { parseSubmittableKind } from "../../http/dto/parse-submit-transaction-request.ts";
import {
  asObject,
  optionalString,
  requiredMoney,
  requiredString,
  requiredUuid,
} from "../../http/dto/parse.ts";

/** Tipo de mensagem que a fila de entrada aceita (§10 do enunciado). */
const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

/** Uma mensagem da fila já traduzida: a identidade dela e o comando a executar. */
export interface ParsedWagerMessage {
  /**
   * Chave da inbox (RF-19, D-044).
   *
   * Vem do **corpo**, não do transporte: é o campo `messageId` que o enunciado
   * escreve no envelope, e o único dos dois que sobrevive a um reenvio do
   * produtor.
   */
  messageId: string;
  command: ProcessWagerTransactionCommand;
}

/**
 * Traduz o envelope da fila no comando de processamento (RF-18, §10).
 *
 * **A borda muda; o comando não.** É a mesma `ProcessWagerTransactionCommand` que
 * o controller HTTP monta, entregue ao mesmo use case — o caminho paralelo com
 * regras próprias é exatamente o que RF-18 proíbe. As duas diferenças de forma
 * são de transporte: a `idempotencyKey` chega em `data` (no HTTP é header), e não
 * existe canal de resposta, então o desfecho vira destino de entrega (D-046,
 * D-048) em vez de status.
 *
 * A validação usa as mesmas primitivas do parser HTTP (D-038): a fila é entrada
 * **tão** não confiável quanto a rede, e afrouxar aqui porque "vem de dentro"
 * seria dar ao produtor um caminho sem checagem para o mesmo banco.
 *
 * O `type` é conferido: uma mensagem de outro tipo na fila de comandos é payload
 * inválido, não algo a ignorar em silêncio. Ignorar apagaria a mensagem sem
 * ninguém saber que ela chegou ao lugar errado.
 *
 * @throws InvalidPayloadError se o envelope, o tipo ou os campos estiverem
 * malformados — o que o consumidor traduz em DLQ (D-046).
 * @throws KindNotSubmittableError se o kind for `OPENING` (RN-13).
 */
export function parseWagerMessage(body: unknown): ParsedWagerMessage {
  const envelope = asObject(body, "corpo da mensagem");
  const messageId = requiredString(envelope, "messageId");
  const type = requiredString(envelope, "type");

  if (type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidPayloadError(
      `type ${type} não é aceito nesta fila. Esperado: ${WAGER_TRANSACTION_REQUESTED}.`,
    );
  }

  const data = asObject(envelope["data"], "data");
  const referenceExternalTransactionId = optionalString(data, "referenceExternalTransactionId");
  const correlationId = optionalString(envelope, "correlationId");

  return {
    messageId,
    command: {
      idempotencyKey: requiredString(data, "idempotencyKey"),
      providerId: requiredString(data, "providerId"),
      externalTransactionId: requiredString(data, "externalTransactionId"),
      playerId: requiredString(data, "playerId"),
      // Mesma primitiva da borda HTTP, pelo mesmo motivo e com um ganho a mais:
      // pela fila, um `walletId` malformado que chegasse ao banco gastaria uma
      // transação abortada antes de ir à DLQ. Recusado aqui, o destino é o mesmo
      // (D-046) sem custar escrita nenhuma.
      walletId: requiredUuid(data, "walletId"),
      roundId: requiredString(data, "roundId"),
      gameId: requiredString(data, "gameId"),
      // Mesma função do parser HTTP: RN-13 barra `OPENING` "nem pela API nem
      // pela fila", e uma segunda cópia da regra seria uma segunda regra.
      kind: parseSubmittableKind(data),
      money: requiredMoney(data, "money"),
      ...(referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId }),
      // D-039 previa este ponto: a correlação atravessa HTTP → outbox → SQS →
      // consumidor sem trocar de dono. Quando o produtor não correlaciona, o
      // `messageId` é o identificador estável mais próximo — inventar um id novo
      // deixaria a mensagem e o processamento dela sem nada em comum no log.
      correlationId: correlationId ?? messageId,
    },
  };
}
