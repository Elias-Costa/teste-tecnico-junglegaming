import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError } from "../../src/domain/errors/currency-mismatch-error.ts";
import { InsufficientFundsError } from "../../src/domain/errors/insufficient-funds-error.ts";
import { InvalidLedgerEntryError } from "../../src/domain/errors/invalid-ledger-entry-error.ts";
import { NegativeBalanceError } from "../../src/domain/errors/negative-balance-error.ts";
import { LedgerDirection } from "../../src/domain/ledger-direction.ts";
import { Money } from "../../src/domain/money.ts";
import { Wallet, type OpenedWallet } from "../../src/domain/wallet.ts";
import type { WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry.ts";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

const ABERTURA = new Date("2026-09-01T12:00:00.000Z");
const DEPOIS = new Date("2026-09-01T12:05:00.000Z");

const abrir = (saldoInicial = "100.00"): OpenedWallet =>
  Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(saldoInicial),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    at: ABERTURA,
  });

/**
 * Reconstrói o saldo a partir dos lançamentos, como faz a reconciliação de RF-16.
 *
 * É a invariante final exigida de **todo** teste (`docs/requirements.md` §6.4):
 * `wallet.balance` tem de bater com esta soma.
 */
const reconstruir = (lancamentos: readonly WalletLedgerEntry[], moeda: string): Money =>
  lancamentos.reduce(
    (saldo, lancamento) =>
      lancamento.direction === LedgerDirection.Debit
        ? saldo.subtract(lancamento.money)
        : saldo.add(lancamento.money),
    Money.zero(moeda),
  );

describe("Wallet.open — abertura (RF-02, RF-08)", () => {
  it("nasce com o saldo inicial e version 1", () => {
    const { wallet } = abrir("1000.00");

    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.createdAt).toEqual(ABERTURA);
    expect(wallet.updatedAt).toEqual(ABERTURA);
  });

  it("produz o lançamento CREDIT de abertura junto com a wallet (D-018)", () => {
    const { wallet, openingEntry } = abrir("1000.00");

    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.walletId).toBe(wallet.id);
    expect(openingEntry!.transactionId).toBe("tx-opening");
    expect(openingEntry!.balanceBefore.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(openingEntry!.balanceAfter.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(openingEntry!.isBalanced()).toBe(true);
  });

  // RF-08 só gera `OPENING` para saldo inicial maior que zero, e RF-04 diz que
  // operação sem efeito no saldo não gera lançamento.
  it("não produz lançamento quando o saldo inicial é zero", () => {
    const { wallet, openingEntry } = abrir("0.00");

    expect(openingEntry).toBeUndefined();
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it("recusa saldo inicial negativo (EL-02)", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: brl("10.00").negate(),
        openingTransactionId: "tx-opening",
        openingEntryId: "entry-opening",
        at: ABERTURA,
      }),
    ).toThrow(NegativeBalanceError);
  });
});

describe("Wallet — version incrementa somente quando o saldo muda (RT-02)", () => {
  it("leitura de estado não incrementa version", () => {
    const { wallet } = abrir();

    expect(wallet.balance.toString()).toBe("100.00 BRL");
    expect(wallet.hasSufficientBalanceFor(brl("50.00"))).toBe(true);
    expect(wallet.updatedAt).toEqual(ABERTURA);

    expect(wallet.version).toBe(1);
  });

  it("cada débito e cada crédito incrementa version e atualiza updatedAt", () => {
    const { wallet } = abrir();

    wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("30.00"), at: DEPOIS });
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(DEPOIS);

    wallet.credit({ entryId: "e2", transactionId: "t2", money: brl("5.00"), at: DEPOIS });
    expect(wallet.version).toBe(3);
    expect(wallet.balance.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });
  });

  // Toda recusa é um caminho que **não** muda saldo. Se algum deles incrementasse
  // `version` ou mexesse em `updatedAt`, RF-02 estaria quebrada exatamente onde
  // ninguém olha — no caminho de erro.
  it("nenhuma operação recusada altera saldo, version ou updatedAt", () => {
    const recusas: ReadonlyArray<[string, (wallet: Wallet) => void]> = [
      [
        "saldo insuficiente",
        (wallet) => {
          wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.01"), at: DEPOIS });
        },
      ],
      [
        "moeda divergente",
        (wallet) => {
          wallet.debit({ entryId: "e1", transactionId: "t1", money: usd("10.00"), at: DEPOIS });
        },
      ],
      [
        "valor zero",
        (wallet) => {
          wallet.credit({
            entryId: "e1",
            transactionId: "t1",
            money: Money.zero("BRL"),
            at: DEPOIS,
          });
        },
      ],
      [
        "valor negativo",
        (wallet) => {
          wallet.credit({
            entryId: "e1",
            transactionId: "t1",
            money: brl("10.00").negate(),
            at: DEPOIS,
          });
        },
      ],
    ];

    for (const [caso, acao] of recusas) {
      const { wallet } = abrir();

      expect(() => {
        acao(wallet);
      }).toThrow();

      expect(`${caso}: ${wallet.balance.toString()}`).toBe(`${caso}: 100.00 BRL`);
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(ABERTURA);
    }
  });
});

describe("Wallet.debit — saldo nunca negativo (RT-02, RN-01, EL-02)", () => {
  it("debita e devolve o lançamento correspondente (D-018)", () => {
    const { wallet } = abrir();

    const lancamento = wallet.debit({
      entryId: "e1",
      transactionId: "t1",
      money: brl("80.00"),
      at: DEPOIS,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: "20.00", currency: "BRL" });
    expect(lancamento.direction).toBe(LedgerDirection.Debit);
    expect(lancamento.walletId).toBe("wallet-1");
    expect(lancamento.balanceBefore.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(lancamento.balanceAfter.toJSON()).toEqual({ amount: "20.00", currency: "BRL" });
    expect(lancamento.isBalanced()).toBe(true);
  });

  it("aceita débito exatamente igual ao saldo, zerando a wallet", () => {
    const { wallet } = abrir();

    wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.00"), at: DEPOIS });

    expect(wallet.balance.isZero()).toBe(true);
  });

  // A guarda de D-019: mesmo que o use case esqueça `hasSufficientBalanceFor`,
  // não existe caminho que grave saldo negativo a partir do agregado.
  it("recusa débito acima do saldo mesmo sem consulta prévia", () => {
    const { wallet } = abrir();

    expect(() => {
      wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.01"), at: DEPOIS });
    }).toThrow(InsufficientFundsError);
  });

  it("hasSufficientBalanceFor é exato no limite de um centavo", () => {
    const { wallet } = abrir();

    expect(wallet.hasSufficientBalanceFor(brl("100.00"))).toBe(true);
    expect(wallet.hasSufficientBalanceFor(brl("100.01"))).toBe(false);
  });
});

describe("Wallet — conflito de moeda (RT-04, RF-02)", () => {
  it("recusa débito, crédito e consulta em moeda diferente da wallet", () => {
    const { wallet } = abrir();

    expect(() => {
      wallet.debit({ entryId: "e1", transactionId: "t1", money: usd("10.00"), at: DEPOIS });
    }).toThrow(CurrencyMismatchError);

    expect(() => {
      wallet.credit({ entryId: "e2", transactionId: "t2", money: usd("10.00"), at: DEPOIS });
    }).toThrow(CurrencyMismatchError);

    expect(() => wallet.hasSufficientBalanceFor(usd("10.00"))).toThrow(CurrencyMismatchError);
  });
});

describe("Wallet — movimentação exige valor estritamente positivo (D-021)", () => {
  it("recusa valor zero e valor negativo", () => {
    const { wallet } = abrir();

    expect(() => {
      wallet.credit({ entryId: "e1", transactionId: "t1", money: Money.zero("BRL"), at: DEPOIS });
    }).toThrow(InvalidLedgerEntryError);

    expect(() => {
      wallet.debit({
        entryId: "e2",
        transactionId: "t2",
        money: brl("10.00").negate(),
        at: DEPOIS,
      });
    }).toThrow(InvalidLedgerEntryError);
  });
});

describe("Wallet.rehydrate — não revalida (§6.0)", () => {
  it("reconstrói o estado persistido como está", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: ABERTURA,
      updatedAt: DEPOIS,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: "42.00", currency: "BRL" });
    expect(wallet.version).toBe(7);
  });
});

describe("Invariante final: saldo igual à reconstrução pelo ledger (§6.4 dos requisitos)", () => {
  it("mantém a igualdade ao longo de uma sequência de operações (RN-01, RN-02, RN-04)", () => {
    const { wallet, openingEntry } = abrir("100.00");
    const lancamentos: WalletLedgerEntry[] = [openingEntry!];

    // BET de 80.00 (RN-01), WIN de 30.00 (RN-02) e REFUND de 80.00 (RN-04).
    lancamentos.push(
      wallet.debit({ entryId: "e1", transactionId: "t-bet", money: brl("80.00"), at: DEPOIS }),
    );
    lancamentos.push(
      wallet.credit({ entryId: "e2", transactionId: "t-win", money: brl("30.00"), at: DEPOIS }),
    );
    lancamentos.push(
      wallet.credit({ entryId: "e3", transactionId: "t-refund", money: brl("80.00"), at: DEPOIS }),
    );

    // 100 − 80 + 30 + 80 = 130. Quatro lançamentos, quatro movimentos de saldo:
    // um LOSS no meio da sequência não apareceria aqui nem mexeria no saldo (RN-03).
    expect(wallet.balance.toJSON()).toEqual({ amount: "130.00", currency: "BRL" });
    expect(lancamentos).toHaveLength(4);
    expect(wallet.version).toBe(4);
    expect(reconstruir(lancamentos, "BRL").equals(wallet.balance)).toBe(true);

    for (const lancamento of lancamentos) {
      expect(lancamento.isBalanced()).toBe(true);
    }
  });
});
