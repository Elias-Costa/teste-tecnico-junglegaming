import { HttpException, HttpStatus } from "@nestjs/common";
import { IdempotencyConflictError } from "../../application/errors/idempotency-conflict-error.ts";
import { InvalidCursorError } from "../../application/errors/invalid-cursor-error.ts";
import { KindNotSubmittableError } from "../../application/errors/kind-not-submittable-error.ts";
import { ResourceNotFoundError } from "../../application/errors/resource-not-found-error.ts";
import { WalletAlreadyExistsError } from "../../application/errors/wallet-already-exists-error.ts";
import { WalletNotFoundError } from "../../application/errors/wallet-not-found-error.ts";
import { InvalidLedgerEntryError } from "../../domain/errors/invalid-ledger-entry-error.ts";
import { InvalidMoneyError } from "../../domain/errors/invalid-money-error.ts";
import { MissingReferenceError } from "../../domain/errors/missing-reference-error.ts";
import { NegativeBalanceError } from "../../domain/errors/negative-balance-error.ts";
import type { FailureCode } from "../../domain/failure-code.ts";
import { WagerTransactionStatus } from "../../domain/wager-transaction.ts";
import { isTransientDatabaseError } from "../../infrastructure/persistence/transient-error.ts";
import { InvalidPayloadError } from "./errors/invalid-payload-error.ts";

/**
 * **O mapa de status HTTP do sistema inteiro** (RF-15, D-006, D-036, D-037).
 *
 * A §9 do enunciado cobra que a API distinga cinco situações — payload inválido,
 * conflito de idempotência, rejeição de negócio, aceite pendente e falha
 * transitória — *de forma consistente entre todos os endpoints*, porque
 * colapsá-las obriga o provedor a interpretar mensagem de erro para decidir se
 * pode reenviar. Este arquivo é o único lugar do projeto que responde a essa
 * pergunta; nenhum controller decide status por conta própria.
 *
 * São **dois** pontos de entrada, e a divisão é a de D-036:
 *
 * - `httpStatusForResult` — o caminho normal. O use case devolve rejeição e
 *   pendência como **resultado**, não exceção: RN-11 manda persistir a rejeição
 *   como transação terminal auditável, e usar o mecanismo de erro da linguagem
 *   para um desfecho esperado e frequente sairia caro em quem reusa a borda.
 * - `httpProblemFor` — as exceções, consumido pelo filtro único.
 *
 * **As cinco situações são da submissão; as consultas de E-14 acrescentam uma
 * sexta resposta** — `404` para recurso inexistente (D-056). Ela não colapsa
 * nenhuma das cinco, porque responde a uma pergunta que a §9 não faz: a §9 trata
 * de operação submetida, e um `GET` não submete nada. Por isso o `404` sai sem
 * `failureCode` — não houve decisão de negócio, houve ausência de linha.
 */

/** Um erro traduzido para a resposta HTTP: status, mensagem e código quando houver. */
export interface HttpProblem {
  status: number;
  message: string;
  /** Presente em todo `422` (D-006) e no `409` de idempotência. */
  failureCode?: FailureCode;
}

/**
 * Mensagem devolvida quando a causa não deve atravessar a fronteira.
 *
 * `500` e `503` não expõem o texto original: ele pode conter fragmento de SQL,
 * host ou nome de constraint, que é informação de dentro. Os demais códigos
 * respondem a mensagem real, porque ela descreve a entrada do próprio provedor.
 */
const OPAQUE_MESSAGE = "erro ao processar a requisição.";

/**
 * Status do desfecho de negócio (D-036).
 *
 * `PENDING` e `PENDING_REFERENCE` compartilham o `202` porque compartilham o
 * significado que a §9 pede distinguir: aceito, ainda não concluído. `FAILED`
 * responde `500`, e essa é a escolha menos óbvia daqui: por D-013 ele só é
 * escrito em **erro permanente** ou esgotamento para DLQ, então não é rejeição de
 * negócio (`422` mentiria sobre a causa) nem falha transitória (`503` diria
 * "reenvie", e reenviar não conserta erro permanente).
 */
export function httpStatusForResult(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      // `200`, e não `201`: um replay não cria nada (RN-12), e responder `201`
      // para ele mentiria sobre o efeito da requisição.
      return HttpStatus.OK;

    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;

    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;

    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

/**
 * Traduz uma exceção na resposta HTTP correspondente (D-006, D-037).
 *
 * A ordem das checagens não é arbitrária: `HttpException` vem primeiro para que
 * o que o próprio Nest gerou — rota inexistente, JSON malformado recusado pelo
 * parser de corpo — mantenha o status que ele já decidiu, em vez de virar `500`
 * por não estar nesta lista.
 *
 * O que **não** está mapeado também é decisão. `CurrencyMismatchError` e
 * `InsufficientFundsError` são guardas de último recurso (D-019), não caminho de
 * negócio: se um deles escapa, um caminho esqueceu a consulta que decide o
 * `failureCode`, e isso é bug nosso — `500`, não `422`. `InvalidTransactionStateError`
 * é erro de programação por definição (RF-03). Mapeá-los daria a impressão de
 * funcionamento correto a um defeito.
 */
export function httpProblemFor(error: unknown): HttpProblem {
  // Erros que o próprio framework produziu já trazem o status certo.
  if (error instanceof HttpException) {
    return { status: error.getStatus(), message: error.message };
  }

  // (a) Payload inválido — forma, valor monetário, referência ausente (D-020),
  // movimentação nula (D-021) e saldo inicial negativo (RF-08).
  if (
    error instanceof InvalidPayloadError ||
    error instanceof InvalidMoneyError ||
    error instanceof MissingReferenceError ||
    error instanceof InvalidLedgerEntryError ||
    error instanceof NegativeBalanceError ||
    error instanceof InvalidCursorError
  ) {
    return { status: HttpStatus.BAD_REQUEST, message: error.message };
  }

  // Consulta de recurso inexistente (D-056). **Sem `failureCode`**: nenhuma
  // regra de negócio foi avaliada, então nenhum dos 13 códigos de D-007
  // descreve o que aconteceu. Distinto de `WalletNotFoundError`, logo abaixo,
  // que é a mesma ausência vista pelo caminho de submissão (D-031).
  if (error instanceof ResourceNotFoundError) {
    return { status: HttpStatus.NOT_FOUND, message: error.message };
  }

  // (b) Conflito. Os dois usos de `409` compartilham o eixo semântico "este
  // recurso já existe com outro conteúdo" (D-006), mas só um tem código: a
  // taxonomia de D-007 está fechada e nenhum dos 13 descreve "wallet já existe".
  if (error instanceof IdempotencyConflictError) {
    return {
      status: HttpStatus.CONFLICT,
      message: error.message,
      failureCode: error.failureCode,
    };
  }

  if (error instanceof WalletAlreadyExistsError) {
    return { status: HttpStatus.CONFLICT, message: error.message };
  }

  // (c) Rejeição de negócio que **não vira linha** (D-031, RN-13). A rejeição
  // persistida não passa por aqui: ela é resultado, e vai por `httpStatusForResult`.
  if (error instanceof WalletNotFoundError || error instanceof KindNotSubmittableError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: error.message,
      failureCode: error.failureCode,
    };
  }

  // (e) Falha transitória de infraestrutura, pela lista explícita de D-037.
  if (isTransientDatabaseError(error)) {
    return { status: HttpStatus.SERVICE_UNAVAILABLE, message: OPAQUE_MESSAGE };
  }

  // Nem uma das cinco situações de RF-15: é a ausência delas (D-037).
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: OPAQUE_MESSAGE };
}
