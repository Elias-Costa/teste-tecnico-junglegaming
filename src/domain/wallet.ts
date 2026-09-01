import { CurrencyMismatchError } from "./errors/currency-mismatch-error.ts";
import { InsufficientFundsError } from "./errors/insufficient-funds-error.ts";
import { InvalidLedgerEntryError } from "./errors/invalid-ledger-entry-error.ts";
import { NegativeBalanceError } from "./errors/negative-balance-error.ts";
import { LedgerDirection } from "./ledger-direction.ts";
import { Money } from "./money.ts";
import { WalletLedgerEntry } from "./wallet-ledger-entry.ts";

/** Dados de abertura de uma wallet (RF-02, RF-08). */
export interface OpenWalletProps {
  /** UUIDv7 (D-014), gerado fora do domínio. */
  id: string;
  playerId: string;
  /** Saldo com que a wallet nasce; define também a moeda da wallet. */
  initialBalance: Money;
  /** Id da transação `OPENING` interna que acompanha a abertura (RF-08). */
  openingTransactionId: string;
  /** Id do lançamento `CREDIT` de abertura. */
  openingEntryId: string;
  at: Date;
}

/**
 * Resultado da abertura: a wallet e o lançamento que justifica o saldo inicial.
 *
 * RF-08 e o exemplo da §9 do enunciado exigem, juntos, `balance` já com o saldo
 * inicial **e** `version: 1` na resposta — ou seja, o saldo nasce com a wallet,
 * não por um `credit` posterior, que daria `version: 2`. Mas a abertura **é**
 * mudança de saldo, e RF-02 exige lançamento correspondente. Devolver os dois
 * juntos é o que mantém a invariante estrutural também no nascimento: não existe
 * caminho que produza saldo inicial sem produzir o lançamento (D-018).
 */
export interface OpenedWallet {
  wallet: Wallet;
  /** `undefined` quando o saldo inicial é zero — RF-08 só gera `OPENING` acima de zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

/** Estado persistido da wallet, para `rehydrate`. */
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Uma movimentação de saldo e o lançamento que ela produz (D-018). */
export interface WalletMovementProps {
  /** UUIDv7 do lançamento a ser criado (D-014). */
  entryId: string;
  /** Transação financeira que originou a movimentação. */
  transactionId: string;
  /** Valor movimentado, estritamente positivo — a direção carrega o sinal (D-021). */
  money: Money;
  at: Date;
}

/**
 * Aggregate root da carteira do jogador (RF-02, EL-02).
 *
 * Guarda o saldo materializado e é o **único** caminho que o altera. `debit` e
 * `credit` devolvem o `WalletLedgerEntry` que acabaram de produzir (D-018), de
 * modo que a invariante "toda alteração de saldo tem lançamento correspondente"
 * seja estrutural: não existe assinatura neste agregado capaz de mover saldo sem
 * entregar o lançamento junto.
 *
 * O que **não** está aqui, de propósito:
 *
 * - **unicidade por `playerId` + `currency`** — é invariante entre agregados,
 *   impossível de garantir dentro de uma instância. Vai para o `UNIQUE` do
 *   schema em E-05 (RI-09).
 * - **controle de concorrência** — `version` existe por exigência de RF-02, mas
 *   o mecanismo é o lock pessimista por wallet de D-002, aplicado no repositório
 *   (E-06). O agregado não sabe que existe concorrência.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet com o saldo inicial e o lançamento de abertura (RF-08).
   *
   * A moeda da wallet é a do saldo inicial: uma wallet sem moeda definida não
   * teria como recusar operação em moeda divergente (RF-02).
   *
   * @throws NegativeBalanceError se o saldo inicial for negativo.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new NegativeBalanceError(props.initialBalance);
    }

    const currency = props.initialBalance.currency;

    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      // RF-02: `version` inicia em 1 após a criação. A abertura é uma única
      // mudança de estado — a wallet e seu lançamento nascem juntos —, então não
      // há um segundo incremento a fazer aqui.
      1,
      props.at,
      props.at,
    );

    // RF-08 gera `OPENING` apenas quando o saldo inicial é maior que zero.
    // Abertura com saldo zero não move saldo e, por RF-04, não gera lançamento.
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: props.initialBalance,
          createdAt: props.at,
        })
      : undefined;

    return { wallet, openingEntry };
  }

  /**
   * Reconstrói uma wallet já persistida.
   *
   * **Não revalida** (§6.0): o saldo lido do banco já passou pelo `CHECK
   * (balance >= 0)` de E-05 e pelas regras que o produziram.
   */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Verdadeiro se o saldo cobre o valor pedido — o caminho de negócio de D-019.
   *
   * É esta consulta, e não uma exceção, que o use case usa para decidir a
   * rejeição: só ele sabe o kind e, portanto, se o `failureCode` é
   * `INSUFFICIENT_FUNDS` ou `INSUFFICIENT_FUNDS_ON_REVERSAL` (RN-16). A wallet
   * não conhece a taxonomia de D-007.
   *
   * @throws CurrencyMismatchError se a moeda divergir da moeda da wallet — o
   * check de moeda vem antes do de valor, na ordem que as regras já têm (D-017).
   */
  hasSufficientBalanceFor(money: Money): boolean {
    this.assertSameCurrency(money);

    return !this._balance.isLessThan(money);
  }

  /**
   * Debita o saldo e devolve o lançamento correspondente (RN-01, RN-05).
   *
   * A checagem de saldo aqui é **guarda de último recurso** (D-019), não o
   * caminho de negócio: um caminho novo que esqueça `hasSufficientBalanceFor`
   * falha alto em vez de gravar saldo negativo. EL-02 é eliminatória, e o
   * `CHECK` do banco de E-05 não deve ser a única barreira.
   *
   * @throws CurrencyMismatchError se a moeda divergir da wallet.
   * @throws InvalidLedgerEntryError se o valor não for estritamente positivo (D-021).
   * @throws InsufficientFundsError se o débito produziria saldo negativo.
   */
  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    assertPositiveMovement(props.money);

    if (!this.hasSufficientBalanceFor(props.money)) {
      throw new InsufficientFundsError(this._balance, props.money);
    }

    return this.applyMovement(LedgerDirection.Debit, props);
  }

  /**
   * Credita o saldo e devolve o lançamento correspondente (RN-02, RN-04).
   *
   * @throws CurrencyMismatchError se a moeda divergir da wallet.
   * @throws InvalidLedgerEntryError se o valor não for estritamente positivo (D-021).
   */
  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    assertPositiveMovement(props.money);

    return this.applyMovement(LedgerDirection.Credit, props);
  }

  /**
   * Aplica a movimentação — ponto único de escrita de saldo, `version` e `updatedAt`.
   *
   * O lançamento é criado **antes** de o estado mudar: se a aritmética não
   * fechar, `WalletLedgerEntry.create` lança e a wallet fica intacta, em vez de
   * ficar com saldo novo e nenhum lançamento que o justifique.
   *
   * `version` incrementa aqui e só aqui, o que satisfaz RF-02 ("incrementa
   * somente quando o saldo muda") por construção: este é o único caminho que
   * muda o saldo, e D-021 garante que ele nunca é chamado com movimento nulo.
   */
  private applyMovement(
    direction: LedgerDirection,
    props: WalletMovementProps,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(props.money)
        : balanceBefore.add(props.money);

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;

    return entry;
  }

  /** Recusa operação em moeda diferente da moeda da wallet (RF-02, RT-04). */
  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

/**
 * Recusa movimentação de valor nulo ou negativo (D-021).
 *
 * Zero é recusado porque RF-04 diz que operação sem efeito no saldo não gera
 * lançamento — e aceitar zero criaria um lançamento sem mudança de saldo, ou um
 * incremento de `version` sem mudança de saldo, contrariando RF-02 num dos dois
 * lados. Negativo é recusado porque a direção do lançamento já carrega o sinal.
 *
 * @throws InvalidLedgerEntryError quando o valor não é estritamente positivo.
 */
function assertPositiveMovement(money: Money): void {
  if (!money.isPositive()) {
    throw new InvalidLedgerEntryError(
      `movimentação exige valor estritamente positivo, recebido ${money.toString()} (D-021).`,
    );
  }
}
