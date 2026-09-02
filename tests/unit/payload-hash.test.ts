/**
 * `payloadHash` canônico — D-005, RF-14.
 *
 * O que se testa aqui é a propriedade que sustenta a idempotência: **o mesmo
 * negócio produz o mesmo hash, e negócio diferente produz hash diferente**. Um
 * hash instável transformaria reenvio legítimo em `IDEMPOTENCY_CONFLICT` (RN-14)
 * — o provedor receberia `409` para a mesma aposta que já mandou, e a única
 * pista seria uma string de 64 caracteres diferente da anterior.
 */
import { describe, expect, it } from "bun:test";
import {
  payloadHashOf,
  type PayloadHashFields,
} from "../../src/application/payload-hash.ts";
import { WagerTransactionKind } from "../../src/domain/wager-transaction.ts";

const campos = (overrides: Partial<PayloadHashFields> = {}): PayloadHashFields => ({
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "player-1",
  walletId: "wallet-1",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: WagerTransactionKind.Bet,
  money: { amount: "25.00", currency: "BRL" },
  ...overrides,
});

describe("payloadHashOf — forma e estabilidade (D-005)", () => {
  it("produz SHA-256 em hexadecimal, a largura de char(64) no schema", () => {
    expect(payloadHashOf(campos())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("é determinístico: a mesma entrada, duas vezes, dá o mesmo hash", () => {
    expect(payloadHashOf(campos())).toBe(payloadHashOf(campos()));
  });

  it("a ordem das chaves na entrada não altera o hash", () => {
    // O enunciado pede JSON **canônico** com chaves ordenadas justamente por
    // isto: a ordem em que o objeto chegou é acidente de quem montou o payload,
    // e não pode virar identidade de negócio.
    const direto = payloadHashOf({
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      playerId: "player-1",
      walletId: "wallet-1",
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
    });

    const invertido = payloadHashOf({
      money: { amount: "25.00", currency: "BRL" },
      kind: WagerTransactionKind.Bet,
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: "wallet-1",
      playerId: "player-1",
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
    });

    expect(invertido).toBe(direto);
  });
});

describe("payloadHashOf — sensibilidade campo a campo (RN-14)", () => {
  /**
   * Cada um dos 10 campos de D-005, com um valor alterado.
   *
   * Como dados e não como testes escritos à mão: a lista é contrato, e um campo
   * que deixasse de entrar no hash — por edição distraída da função — passaria
   * despercebido se o teste só verificasse os dois ou três "interessantes".
   */
  const alteracoes: ReadonlyArray<[string, Partial<PayloadHashFields>]> = [
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "transaction-124" }],
    ["playerId", { playerId: "player-2" }],
    ["walletId", { walletId: "wallet-2" }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "outro-jogo" }],
    ["kind", { kind: WagerTransactionKind.Win }],
    ["money.amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["money.currency", { money: { amount: "25.00", currency: "USD" } }],
    ["referenceExternalTransactionId", { referenceExternalTransactionId: "ext-origem" }],
  ];

  const original = payloadHashOf(campos());

  for (const [campo, alteracao] of alteracoes) {
    it(`muda quando ${campo} muda`, () => {
      expect(payloadHashOf(campos(alteracao))).not.toBe(original);
    });
  }
});

describe("payloadHashOf — ausência e omissão (D-005)", () => {
  it("campo ausente e campo explicitamente undefined dão o mesmo hash", () => {
    // `undefined` é **omitido** do JSON canônico. Sem isso, o mesmo `BET` sem
    // referência hashearia diferente conforme quem montou o comando tivesse
    // escrito a chave ou não.
    expect(payloadHashOf(campos({ referenceExternalTransactionId: undefined }))).toBe(
      payloadHashOf(campos()),
    );
  });

  it("referência presente difere de referência ausente", () => {
    expect(payloadHashOf(campos({ referenceExternalTransactionId: "ext-origem" }))).not.toBe(
      payloadHashOf(campos()),
    );
  });
});
