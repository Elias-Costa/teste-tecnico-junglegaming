/**
 * E-08 — o parser artesanal da borda (D-038, D-005, RN-13).
 *
 * Três propriedades que só existem aqui e que nenhum outro teste alcança:
 *
 *  - **`null` é rejeitado explicitamente.** É o item que D-005 exige e que D-032
 *    deixou para esta etapa: no comando tipado o `null` não chega, e o guard lá
 *    seria código que o compilador prova inalcançável.
 *  - **Número não é coagido a texto.** `{"amount": 25.5}` morre na borda, antes
 *    de qualquer coisa encostar em ponto flutuante — a barreira de EL-01 na
 *    entrada, somada ao lint e à coluna `numeric(19,2)`.
 *  - **Kind desconhecido e kind interno têm destinos diferentes.** `"FOO"` é
 *    `400` (contrato errado); `OPENING` é `422` com `KIND_NOT_SUBMITTABLE`
 *    (RN-13). Colapsar os dois é perder a distinção que a §7.2 cobra.
 */
import { describe, expect, it } from "bun:test";
import { WagerTransactionKind } from "../../src/domain/wager-transaction.ts";
import { parseOpenWalletRequest } from "../../src/interface/http/dto/parse-open-wallet-request.ts";
import {
  IDEMPOTENCY_KEY_HEADER,
  parseSubmitTransactionRequest,
} from "../../src/interface/http/dto/parse-submit-transaction-request.ts";
import { InvalidPayloadError } from "../../src/interface/http/errors/invalid-payload-error.ts";
import { KindNotSubmittableError } from "../../src/application/errors/kind-not-submittable-error.ts";

const CORRELACAO = "0199a1f0-0000-7000-8000-000000000000";

/** Corpo válido de submissão, para os testes mudarem um campo por vez. */
function corpoDeAposta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

const HEADERS_VALIDOS: Record<string, unknown> = {
  [IDEMPOTENCY_KEY_HEADER]: "provider-a:transaction-123",
};

function submeter(
  corpo: unknown,
  headers: Record<string, unknown> = HEADERS_VALIDOS,
): ReturnType<typeof parseSubmitTransactionRequest> {
  return parseSubmitTransactionRequest(corpo, headers, CORRELACAO);
}

describe("POST /wagering/transactions: corpo bem formado (RF-13)", () => {
  it("monta o comando com os oito campos e a key do header", () => {
    const comando = submeter(corpoDeAposta());

    expect(comando.idempotencyKey).toBe("provider-a:transaction-123");
    expect(comando.providerId).toBe("provider-a");
    expect(comando.kind).toBe(WagerTransactionKind.Bet);
    expect(comando.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(comando.correlationId).toBe(CORRELACAO);
  });

  it("omite a referência ausente, em vez de preenchê-la com undefined (D-005)", () => {
    expect("referenceExternalTransactionId" in submeter(corpoDeAposta())).toBe(false);
  });

  it("mantém a referência quando ela vem", () => {
    const comando = submeter(corpoDeAposta({ referenceExternalTransactionId: "tx-anterior" }));

    expect(comando.referenceExternalTransactionId).toBe("tx-anterior");
  });
});

describe("POST /wagering/transactions: payload inválido é 400 (D-038)", () => {
  it("recusa `null` num campo obrigatório, com mensagem que diz o que fazer (D-005)", () => {
    expect(() => submeter(corpoDeAposta({ roundId: null }))).toThrow(InvalidPayloadError);
    expect(() => submeter(corpoDeAposta({ roundId: null }))).toThrow(/omita o campo/i);
  });

  it("recusa `null` também no campo opcional — ausente e nulo não são sinônimos", () => {
    expect(() => submeter(corpoDeAposta({ referenceExternalTransactionId: null }))).toThrow(
      InvalidPayloadError,
    );
  });

  it("recusa número em money.amount sem convertê-lo (EL-01)", () => {
    expect(() => submeter(corpoDeAposta({ money: { amount: 25.5, currency: "BRL" } }))).toThrow(
      InvalidPayloadError,
    );
  });

  it("recusa campo obrigatório ausente e campo em branco", () => {
    expect(() => submeter(corpoDeAposta({ playerId: undefined }))).toThrow(InvalidPayloadError);
    expect(() => submeter(corpoDeAposta({ playerId: "   " }))).toThrow(InvalidPayloadError);
  });

  it("recusa corpo que não é objeto JSON, array incluído", () => {
    expect(() => submeter([])).toThrow(InvalidPayloadError);
    expect(() => submeter("texto solto")).toThrow(InvalidPayloadError);
    expect(() => submeter(null)).toThrow(InvalidPayloadError);
  });

  it("recusa Idempotency-Key ausente ou vazia (RF-13)", () => {
    expect(() => submeter(corpoDeAposta(), {})).toThrow(/idempotency-key/i);
    expect(() => submeter(corpoDeAposta(), { [IDEMPOTENCY_KEY_HEADER]: "  " })).toThrow(
      InvalidPayloadError,
    );
  });

  it("recusa Idempotency-Key repetida — duas keys não têm desempate correto", () => {
    expect(() => submeter(corpoDeAposta(), { [IDEMPOTENCY_KEY_HEADER]: ["a", "b"] })).toThrow(
      InvalidPayloadError,
    );
  });
});

describe("POST /wagering/transactions: kind (RN-13)", () => {
  it("kind desconhecido é payload inválido — o provedor errou o contrato", () => {
    expect(() => submeter(corpoDeAposta({ kind: "FOO" }))).toThrow(InvalidPayloadError);
  });

  it("OPENING é rejeição de negócio, não payload inválido (RN-13)", () => {
    expect(() => submeter(corpoDeAposta({ kind: "OPENING" }))).toThrow(KindNotSubmittableError);
  });

  it("os demais kinds passam pela borda — quem os processa é E-12", () => {
    for (const kind of ["WIN", "LOSS", "REFUND", "ROLLBACK"]) {
      expect(submeter(corpoDeAposta({ kind })).kind).toBe(kind as WagerTransactionKind);
    }
  });
});

describe("POST /wallets (RF-08)", () => {
  it("monta o comando de abertura", () => {
    const comando = parseOpenWalletRequest(
      { playerId: "player-1", initialBalance: { amount: "1000.00", currency: "BRL" } },
      CORRELACAO,
    );

    expect(comando.playerId).toBe("player-1");
    expect(comando.initialBalance).toEqual({ amount: "1000.00", currency: "BRL" });
  });

  it("recusa initialBalance ausente, malformado ou numérico", () => {
    expect(() => parseOpenWalletRequest({ playerId: "p" }, CORRELACAO)).toThrow(
      InvalidPayloadError,
    );
    expect(() =>
      parseOpenWalletRequest({ playerId: "p", initialBalance: "1000.00" }, CORRELACAO),
    ).toThrow(InvalidPayloadError);
    expect(() =>
      parseOpenWalletRequest(
        { playerId: "p", initialBalance: { amount: 1000, currency: "BRL" } },
        CORRELACAO,
      ),
    ).toThrow(InvalidPayloadError);
  });
});
