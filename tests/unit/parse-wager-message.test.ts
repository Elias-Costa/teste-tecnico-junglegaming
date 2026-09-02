/**
 * E-11 — o parser do envelope da fila (§10, RF-18, D-038, D-039, D-044).
 *
 * O que se prova aqui é que a **entrada pela fila não é mais frouxa que a
 * entrada pela rede**. É a tentação óbvia — "a fila é canal interno confiável",
 * como o próprio enunciado diz na §2 —, e ceder a ela daria ao produtor um
 * caminho sem checagem para o mesmo banco. As mesmas primitivas de D-038 valem
 * nos dois lados; o que muda é só o destino do erro.
 *
 * Quatro propriedades que nenhum outro teste alcança:
 *
 *  - a chave da inbox vem do **corpo** (D-044), e o envelope sem ela é recusado;
 *  - `type` inesperado é payload inválido, não algo a ignorar em silêncio;
 *  - `OPENING` é barrado **também** pela fila — RN-13 diz "nem pela API nem pela
 *    fila", e este teste é o que prova que a regra é uma só;
 *  - o `correlationId` atravessa quando vem, e cai no `messageId` quando não vem
 *    (D-039), em vez de um id novo que não correlacionaria nada.
 */
import { describe, expect, it } from "bun:test";
import { WagerTransactionKind } from "../../src/domain/wager-transaction.ts";
import { InvalidPayloadError } from "../../src/interface/http/errors/invalid-payload-error.ts";
import { KindNotSubmittableError } from "../../src/interface/http/errors/kind-not-submittable-error.ts";
import { parseWagerMessage } from "../../src/interface/messaging/dto/parse-wager-message.ts";

/** O `data` do exemplo da §10, para os testes mudarem um campo por vez. */
function dados(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

/** O envelope inteiro, na forma que o enunciado publica. */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "msg-123",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: dados(),
    ...overrides,
  };
}

/**
 * Captura a exceção de uma chamada síncrona.
 *
 * `expect(...).toThrow()` não passa no lint deste projeto, e a asserção por
 * captura ainda permite conferir o **tipo** do erro, que é o que distingue os
 * destinos de D-046 e D-048.
 */
function erroDe(acao: () => unknown): unknown {
  try {
    acao();
  } catch (error) {
    return error;
  }

  return undefined;
}

describe("parseWagerMessage — envelope da §10 vira o comando de RF-18", () => {
  it("traduz o exemplo do enunciado no mesmo comando que o HTTP monta", () => {
    const { messageId, command } = parseWagerMessage(envelope());

    // Mesma forma que `parseSubmitTransactionRequest` produz: é o que faz o use
    // case ser um só (RF-18). A diferença de transporte é a `idempotencyKey`
    // chegar em `data` em vez de header.
    expect(messageId).toBe("msg-123");
    expect(command.idempotencyKey).toBe("provider-a:transaction-123");
    expect(command.providerId).toBe("provider-a");
    expect(command.kind).toBe(WagerTransactionKind.Bet);
    expect(command.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(command.referenceExternalTransactionId).toBeUndefined();
  });

  it("a chave da inbox vem do corpo, e o envelope sem ela é recusado (D-044)", () => {
    const semId = envelope();
    delete semId["messageId"];

    // Sem o `messageId` do corpo não há chave de deduplicação, e processar assim
    // seria decidir por conta própria que aquela entrega pode ser duplicada.
    expect(erroDe(() => parseWagerMessage(semId))).toBeInstanceOf(InvalidPayloadError);
  });

  it("`type` inesperado é payload inválido, não mensagem a ignorar", () => {
    // Ignorar apagaria a mensagem sem ninguém saber que ela chegou à fila errada.
    const erro = erroDe(() => parseWagerMessage(envelope({ type: "WalletBalanceChanged" })));

    expect(erro).toBeInstanceOf(InvalidPayloadError);
    expect((erro as InvalidPayloadError).message).toContain("WagerTransactionRequested");
  });

  it("`OPENING` é barrado também pela fila (RN-13)", () => {
    // RN-13 diz "nem pela API nem pela fila", e a checagem é a **mesma função**
    // do parser HTTP — duas cópias seriam duas regras capazes de divergir.
    expect(erroDe(() => parseWagerMessage(envelope({ data: dados({ kind: "OPENING" }) })))).
      toBeInstanceOf(KindNotSubmittableError);
  });

  it("kind desconhecido é payload inválido, e não a rejeição de RN-13", () => {
    expect(erroDe(() => parseWagerMessage(envelope({ data: dados({ kind: "FOO" }) })))).
      toBeInstanceOf(InvalidPayloadError);
  });

  it("número em `money.amount` morre na borda (EL-01)", () => {
    // A barreira mais barata de EL-01: o ponto flutuante é recusado antes de
    // qualquer código de dinheiro encostar nele.
    const erro = erroDe(() =>
      parseWagerMessage(envelope({ data: dados({ money: { amount: 25.5, currency: "BRL" } }) })),
    );

    expect(erro).toBeInstanceOf(InvalidPayloadError);
  });

  it("`null` explícito é recusado, e não tratado como ausente (D-005)", () => {
    // Aceitar `null` como sinônimo de ausente daria dois hashes possíveis para a
    // mesma operação, e o segundo reenvio viraria `IDEMPOTENCY_CONFLICT` falso.
    const erro = erroDe(() =>
      parseWagerMessage(
        envelope({ data: dados({ referenceExternalTransactionId: null }) }),
      ),
    );

    expect(erro).toBeInstanceOf(InvalidPayloadError);
  });

  it("`data` ausente ou não-objeto é payload inválido", () => {
    expect(erroDe(() => parseWagerMessage(envelope({ data: "nada" })))).toBeInstanceOf(
      InvalidPayloadError,
    );
    expect(erroDe(() => parseWagerMessage([]))).toBeInstanceOf(InvalidPayloadError);
  });
});

describe("correlationId — a correlação atravessa o transporte (D-039)", () => {
  it("usa o do envelope quando o produtor manda", () => {
    const { command } = parseWagerMessage(envelope({ correlationId: "corr-do-provedor" }));

    expect(command.correlationId).toBe("corr-do-provedor");
  });

  it("cai no `messageId` quando não vem, em vez de inventar um id novo", () => {
    // Um id novo deixaria a mensagem e o processamento dela sem nada em comum no
    // log — que é justamente o rastro que RNF-06 quer.
    const { command } = parseWagerMessage(envelope());

    expect(command.correlationId).toBe("msg-123");
  });
});
