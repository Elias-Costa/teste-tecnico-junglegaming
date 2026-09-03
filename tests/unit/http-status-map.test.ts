/**
 * E-08 — o mapa de status HTTP (RF-15, D-006, D-036, D-037).
 *
 * O critério de conclusão da etapa é literal: "teste que exercita as cinco
 * situações de RF-15 e confere **cinco códigos distintos**". É o que o primeiro
 * bloco faz, e a asserção sobre o tamanho do conjunto é o ponto — colapsar duas
 * situações no mesmo código é falha de requisito, e a §9 explica por quê: o
 * provedor passaria a ter que interpretar mensagem de erro para saber se pode
 * reenviar.
 *
 * O `202` só é alcançável por aqui até E-13: `BET` nunca chega a
 * `PENDING_REFERENCE`. Testá-lo na função pura é o que permite provar o mapa
 * inteiro antes de existir caminho de negócio que o produza — uma das razões de
 * D-036 ter tirado o resultado de dentro do filtro.
 */
import { describe, expect, it } from "bun:test";
import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import { IdempotencyConflictError } from "../../src/application/errors/idempotency-conflict-error.ts";
import { InvalidCursorError } from "../../src/application/errors/invalid-cursor-error.ts";
import { ResourceNotFoundError } from "../../src/application/errors/resource-not-found-error.ts";
import { WalletAlreadyExistsError } from "../../src/application/errors/wallet-already-exists-error.ts";
import { WalletNotFoundError } from "../../src/application/errors/wallet-not-found-error.ts";
import { InvalidLedgerEntryError } from "../../src/domain/errors/invalid-ledger-entry-error.ts";
import { InvalidMoneyError } from "../../src/domain/errors/invalid-money-error.ts";
import { MissingReferenceError } from "../../src/domain/errors/missing-reference-error.ts";
import { NegativeBalanceError } from "../../src/domain/errors/negative-balance-error.ts";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import { Money } from "../../src/domain/money.ts";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction.ts";
import { isTransientDatabaseError } from "../../src/infrastructure/persistence/transient-error.ts";
import { InvalidPayloadError } from "../../src/interface/http/errors/invalid-payload-error.ts";
import { KindNotSubmittableError } from "../../src/application/errors/kind-not-submittable-error.ts";
import { httpProblemFor, httpStatusForResult } from "../../src/interface/http/http-status-map.ts";

/** Erro com SQLSTATE, na forma exata em que o driver o entrega (D-037). */
function erroComCodigo(code: string): Error {
  return Object.assign(new Error(`falha do driver (${code})`), { code });
}

describe("as cinco situações de RF-15 têm cinco códigos distintos", () => {
  const payloadInvalido = httpProblemFor(new InvalidPayloadError("playerId é obrigatório."));
  const conflito = httpProblemFor(new IdempotencyConflictError("provider-a:tx-1", "tx-interna"));
  const rejeicao = httpStatusForResult(WagerTransactionStatus.Rejected);
  const pendente = httpStatusForResult(WagerTransactionStatus.PendingReference);
  const transitoria = httpProblemFor(erroComCodigo("08006"));

  it("(a) payload inválido é 400", () => {
    expect(payloadInvalido.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("(b) conflito de idempotência é 409 e carrega o código", () => {
    expect(conflito.status).toBe(HttpStatus.CONFLICT);
    expect(conflito.failureCode).toBe(BusinessFailureCode.IdempotencyConflict);
  });

  it("(c) rejeição por regra de negócio é 422", () => {
    expect(rejeicao).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it("(d) aceite com processamento pendente é 202", () => {
    expect(pendente).toBe(HttpStatus.ACCEPTED);
  });

  it("(e) falha transitória de infraestrutura é 503 e não carrega código", () => {
    expect(transitoria.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(transitoria.failureCode).toBeUndefined();
  });

  it("os cinco códigos são distintos entre si", () => {
    const codigos = [
      payloadInvalido.status,
      conflito.status,
      rejeicao,
      pendente,
      transitoria.status,
    ];

    expect(new Set(codigos).size).toBe(5);
  });
});

describe("httpStatusForResult (D-036)", () => {
  it("aplicada é 200, não 201 — replay não cria nada (RN-12)", () => {
    expect(httpStatusForResult(WagerTransactionStatus.Processed)).toBe(HttpStatus.OK);
  });

  it("PENDING e PENDING_REFERENCE compartilham o 202", () => {
    expect(httpStatusForResult(WagerTransactionStatus.Pending)).toBe(HttpStatus.ACCEPTED);
    expect(httpStatusForResult(WagerTransactionStatus.PendingReference)).toBe(
      HttpStatus.ACCEPTED,
    );
  });

  it("FAILED é 500: não é rejeição de negócio nem falha transitória (D-013)", () => {
    expect(httpStatusForResult(WagerTransactionStatus.Failed)).toBe(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("httpProblemFor: os 400 (D-006)", () => {
  it("valor monetário malformado é 400 (D-015, D-016)", () => {
    expect(httpProblemFor(new InvalidMoneyError('valor inválido: "25.5"')).status).toBe(
      HttpStatus.BAD_REQUEST,
    );
  });

  it("referência ausente em REFUND é 400, não rejeição (D-020)", () => {
    expect(httpProblemFor(new MissingReferenceError(WagerTransactionKind.Refund)).status).toBe(
      HttpStatus.BAD_REQUEST,
    );
  });

  it("movimentação de valor zero é 400 (D-021)", () => {
    expect(httpProblemFor(new InvalidLedgerEntryError("valor precisa ser positivo")).status).toBe(
      HttpStatus.BAD_REQUEST,
    );
  });

  it("saldo inicial negativo é 400 (RF-08)", () => {
    // `Money.from` recusa sinal (D-015), então o negativo vem de `negate()` — o
    // mesmo caminho que o lançamento invertido de RN-05 usa. Na prática, um
    // `initialBalance` negativo vindo por HTTP morre antes, em `InvalidMoneyError`;
    // mapear este erro também é defesa em profundidade, e os dois dão 400.
    const negativo = Money.from({ amount: "1.00", currency: "BRL" }).negate();

    expect(httpProblemFor(new NegativeBalanceError(negativo)).status).toBe(
      HttpStatus.BAD_REQUEST,
    );
  });
});

describe("httpProblemFor: os dois 409 (D-006, D-035)", () => {
  it("wallet duplicada é 409 e **não** carrega failureCode — a taxonomia está fechada", () => {
    const problema = httpProblemFor(new WalletAlreadyExistsError("player-1", "BRL"));

    expect(problema.status).toBe(HttpStatus.CONFLICT);
    expect(problema.failureCode).toBeUndefined();
  });
});

describe("httpProblemFor: os 422 que não viram linha (D-031, RN-13)", () => {
  it("wallet inexistente é 422 com WALLET_NOT_FOUND", () => {
    const problema = httpProblemFor(new WalletNotFoundError("wallet-inexistente"));

    expect(problema.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problema.failureCode).toBe(BusinessFailureCode.WalletNotFound);
  });

  it("OPENING submetido é 422 com KIND_NOT_SUBMITTABLE", () => {
    const problema = httpProblemFor(new KindNotSubmittableError(WagerTransactionKind.Opening));

    expect(problema.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problema.failureCode).toBe(BusinessFailureCode.KindNotSubmittable);
  });
});

describe("httpProblemFor: o que não é nenhuma das cinco situações (D-037)", () => {
  it("erro desconhecido é 500 e não vaza a mensagem original", () => {
    const problema = httpProblemFor(new Error("select * from wallets where senha = 'hunter2'"));

    expect(problema.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(problema.message).not.toContain("hunter2");
  });

  it("exceção do próprio Nest mantém o status que ele decidiu", () => {
    expect(httpProblemFor(new NotFoundException()).status).toBe(HttpStatus.NOT_FOUND);
    expect(httpProblemFor(new HttpException("json malformado", HttpStatus.BAD_REQUEST)).status).toBe(
      HttpStatus.BAD_REQUEST,
    );
  });
});

describe("isTransientDatabaseError: a lista explícita de D-037", () => {
  it("reconhece a classe 08 inteira e a 53", () => {
    expect(isTransientDatabaseError(erroComCodigo("08000"))).toBe(true);
    expect(isTransientDatabaseError(erroComCodigo("08006"))).toBe(true);
    expect(isTransientDatabaseError(erroComCodigo("53300"))).toBe(true);
  });

  it("reconhece deadlock, lock indisponível, cancelamento e shutdown", () => {
    for (const code of ["40001", "40P01", "55P03", "57014", "57P01"]) {
      expect(isTransientDatabaseError(erroComCodigo(code))).toBe(true);
    }
  });

  it("reconhece falha de rede sem SQLSTATE — o banco não respondeu", () => {
    expect(isTransientDatabaseError(erroComCodigo("ECONNREFUSED"))).toBe(true);
  });

  it("**não** reconhece violação de constraint nem erro de sintaxe: são bugs nossos", () => {
    expect(isTransientDatabaseError(erroComCodigo("23505"))).toBe(false);
    expect(isTransientDatabaseError(erroComCodigo("23503"))).toBe(false);
    expect(isTransientDatabaseError(erroComCodigo("42601"))).toBe(false);
  });

  it("tolera erro sem código e valor que nem é erro", () => {
    expect(isTransientDatabaseError(new Error("sem código"))).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
    expect(isTransientDatabaseError("string solta")).toBe(false);
  });
});

describe("E-14 — a sexta resposta: `404` de leitura (D-056)", () => {
  const naoEncontrado = httpProblemFor(
    new ResourceNotFoundError("wallet", "0192f291-27dd-7d3f-8071-5f8685deef37"),
  );

  it("consulta de recurso inexistente é 404", () => {
    expect(naoEncontrado.status).toBe(HttpStatus.NOT_FOUND);
  });

  it("**não** carrega failureCode: nenhuma regra de negócio foi avaliada", () => {
    // `422` sempre traz um código de D-007 porque houve decisão de negócio.
    // Num `GET` não houve — houve ausência de linha.
    expect(naoEncontrado.failureCode).toBeUndefined();
  });

  it("não colapsa nenhuma das cinco situações de RF-15", () => {
    const cinco = [
      httpProblemFor(new InvalidPayloadError("walletId precisa ser um UUID.")).status,
      httpProblemFor(new IdempotencyConflictError("provider-a:tx-1", "tx-interna")).status,
      httpStatusForResult(WagerTransactionStatus.Rejected),
      httpStatusForResult(WagerTransactionStatus.PendingReference),
      httpProblemFor(erroComCodigo("08006")).status,
    ];

    expect(cinco).not.toContain(HttpStatus.NOT_FOUND);
    expect(new Set([...cinco, naoEncontrado.status]).size).toBe(6);
  });

  it("`WalletNotFoundError` continua sendo `422` com código: mesma ausência, outro verbo", () => {
    // D-031 é a rejeição de negócio da **submissão**; D-056 é a consulta. Os
    // dois tipos coexistem de propósito, e é este par de asserções que impede
    // alguém de "simplificar" fundindo-os.
    const submissao = httpProblemFor(
      new WalletNotFoundError("0192f291-27dd-7d3f-8071-5f8685deef37"),
    );

    expect(submissao.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(submissao.failureCode).toBe(BusinessFailureCode.WalletNotFound);
  });

  it("cursor corrompido é 400, não 404: forma inválida, não recurso ausente", () => {
    const problema = httpProblemFor(new InvalidCursorError("cursor inválido."));

    expect(problema.status).toBe(HttpStatus.BAD_REQUEST);
    expect(problema.failureCode).toBeUndefined();
  });
});
