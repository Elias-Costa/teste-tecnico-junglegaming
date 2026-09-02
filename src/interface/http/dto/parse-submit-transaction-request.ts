import type { ProcessWagerTransactionCommand } from "../../../application/process-wager-transaction.ts";
import { WagerTransactionKind } from "../../../domain/wager-transaction.ts";
import { InvalidPayloadError } from "../errors/invalid-payload-error.ts";
import { KindNotSubmittableError } from "../../../application/errors/kind-not-submittable-error.ts";
import { asObject, optionalString, requiredHeader, requiredMoney, requiredString } from "./parse.ts";

/** Header que carrega a fonte da verdade da idempotência (RF-13, RF-14). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * Índice do texto de entrada para o membro do enum.
 *
 * Um `Map<string, ...>` em vez de comparar `string` com membro de enum: a
 * comparação direta é justamente o que o lint recusa, porque um dos lados é texto
 * não confiável. O índice faz a conversão acontecer num ponto só, e o `get`
 * devolvendo `undefined` **é** a resposta para "kind desconhecido".
 */
const KIND_BY_VALUE: ReadonlyMap<string, WagerTransactionKind> = new Map<
  string,
  WagerTransactionKind
>(Object.values(WagerTransactionKind).map((kind) => [kind, kind]));

/**
 * Traduz `POST /wagering/transactions` no comando de processamento (RF-13).
 *
 * A `Idempotency-Key` entra pelo header e **não** entra no `payloadHash`: a §9 é
 * explícita em excluir header e metadado de transporte do hash, e é isso que
 * permite a mesma operação chegar por HTTP e por SQS produzindo o mesmo hash
 * (D-005, RF-18).
 *
 * @throws InvalidPayloadError se o corpo ou o header estiverem malformados (400).
 * @throws KindNotSubmittableError se o kind for `OPENING` (RN-13 → 422).
 */
export function parseSubmitTransactionRequest(
  body: unknown,
  headers: Record<string, unknown>,
  correlationId: string,
): ProcessWagerTransactionCommand {
  const source = asObject(body, "corpo da requisição");
  const referenceExternalTransactionId = optionalString(source, "referenceExternalTransactionId");

  return {
    idempotencyKey: requiredHeader(headers, IDEMPOTENCY_KEY_HEADER),
    providerId: requiredString(source, "providerId"),
    externalTransactionId: requiredString(source, "externalTransactionId"),
    playerId: requiredString(source, "playerId"),
    walletId: requiredString(source, "walletId"),
    roundId: requiredString(source, "roundId"),
    gameId: requiredString(source, "gameId"),
    kind: parseSubmittableKind(source),
    money: requiredMoney(source, "money"),
    // Chave omitida quando ausente, e não preenchida com `undefined`: é o que
    // `exactOptionalPropertyTypes` cobra e o que mantém a omissão de D-005.
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    correlationId,
  };
}

/**
 * Lê o `kind` e barra o que é interno (RN-13).
 *
 * A ordem das duas checagens é o que produz dois códigos HTTP diferentes, e é
 * deliberada: um kind desconhecido (`"FOO"`) é payload inválido — `400`, o
 * provedor errou o contrato. `OPENING` é um kind que **existe** e que a regra de
 * negócio recusa — `422` com `KIND_NOT_SUBMITTABLE`, que é o código que diz ao
 * provedor para corrigir o payload em vez de reenviar. Inverter a ordem
 * colapsaria as duas situações no mesmo `400`.
 *
 * **Exportada porque a fila usa a mesma regra.** RN-13 diz que `OPENING` não pode
 * ser submetido "nem pela API nem pela fila", e o parser de mensagem de E-11
 * chama esta função em vez de repetir as duas checagens — duas cópias seriam duas
 * regras para o mesmo requisito, capazes de divergir numa adição futura ao enum.
 * O que muda entre as duas bordas é só o destino do erro: `400`/`422` no HTTP,
 * DLQ na fila (D-046, D-048).
 *
 * @throws InvalidPayloadError se o kind não existir no enum.
 * @throws KindNotSubmittableError para `OPENING`.
 */
export function parseSubmittableKind(source: Record<string, unknown>): WagerTransactionKind {
  const value = requiredString(source, "kind");
  const kind = KIND_BY_VALUE.get(value);

  if (kind === undefined) {
    throw new InvalidPayloadError(
      `kind ${value} não existe. Valores aceitos: ${[...KIND_BY_VALUE.keys()].join(", ")}.`,
    );
  }

  if (kind === WagerTransactionKind.Opening) {
    throw new KindNotSubmittableError(kind);
  }

  return kind;
}
