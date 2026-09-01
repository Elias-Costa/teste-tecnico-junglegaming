import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError } from "../../src/domain/errors/currency-mismatch-error.ts";
import { InvalidLedgerEntryError } from "../../src/domain/errors/invalid-ledger-entry-error.ts";
import { LedgerDirection } from "../../src/domain/ledger-direction.ts";
import { Money } from "../../src/domain/money.ts";
import {
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from "../../src/domain/wallet-ledger-entry.ts";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

const EM = new Date("2026-09-01T12:00:00.000Z");

/** Lançamento de débito que fecha: 100.00 − 30.00 = 70.00. */
const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "tx-1",
  direction: LedgerDirection.Debit,
  money: brl("30.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("70.00"),
  createdAt: EM,
  ...overrides,
});

describe("WalletLedgerEntry.create — aritmética validada (RT-06)", () => {
  it("aceita débito que fecha", () => {
    const entry = WalletLedgerEntry.create(props());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: "70.00", currency: "BRL" });
  });

  it("aceita crédito que fecha", () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        balanceBefore: brl("70.00"),
        balanceAfter: brl("100.00"),
      }),
    );

    expect(entry.isBalanced()).toBe(true);
  });

  // O lançamento desbalanceado é a forma silenciosa de o ledger deixar de ser
  // auditável (EL-07): o saldo materializado e a reconstrução de RF-16 passariam
  // a divergir sem que nada acusasse onde.
  it("recusa débito que não fecha", () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl("71.00") }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it("recusa crédito que não fecha", () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Credit,
          balanceBefore: brl("70.00"),
          balanceAfter: brl("99.99"),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("recusa lançamento com direção invertida, ainda que os valores existam", () => {
    // Mesmos três valores do caso feliz, só que declarados como CREDIT:
    // 100.00 + 30.00 não dá 70.00. É o erro que um `ROLLBACK` mal derivado faria.
    expect(() => WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it("recusa valor zero (D-021)", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...props(),
        money: Money.zero("BRL"),
        balanceAfter: brl("100.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("recusa valor negativo — o sinal é da direção (D-021)", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...props(),
        money: brl("30.00").negate(),
        balanceAfter: brl("130.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("recusa lançamento com moedas diferentes entre si (RT-04)", () => {
    expect(() => WalletLedgerEntry.create(props({ money: usd("30.00") }))).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe("WalletLedgerEntry — imutabilidade estrutural (RF-04, EL-07)", () => {
  // RF-04 exige que a imutabilidade seja estrutural, não convenção. Este teste
  // falha no dia em que alguém acrescentar um método que mude o lançamento —
  // que é exatamente o momento em que RI-05 seria violado.
  it("não expõe nenhum método além de isBalanced", () => {
    const metodos = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (nome) => nome !== "constructor",
    );

    expect(metodos).toEqual(["isBalanced"]);
  });
});

describe("WalletLedgerEntry.rehydrate — não revalida (§6.0)", () => {
  it("reconstrói estado persistido sem passar pela validação da factory", () => {
    // Estado que `create` recusaria. Reidratar não é criar: um lançamento
    // histórico gravado sob outra regra não pode virar exceção numa leitura.
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl("71.00") }));

    expect(entry.isBalanced()).toBe(false);
    expect(entry.id).toBe("entry-1");
  });
});
