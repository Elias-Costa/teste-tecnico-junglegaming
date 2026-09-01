import { InvalidLedgerEntryError } from "./errors/invalid-ledger-entry-error.ts";
import { LedgerDirection } from "./ledger-direction.ts";
import type { Money } from "./money.ts";

/** Dados de um lançamento no ledger (RF-04, §6.4). */
export interface CreateLedgerEntryProps {
  /** UUIDv7 (D-014) — gerado fora do domínio, como todo id de entidade. */
  id: string;
  walletId: string;
  /** Transação financeira que originou o lançamento. */
  transactionId: string;
  direction: LedgerDirection;
  /** Valor movimentado, sempre positivo — o sinal é da direção (D-021). */
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Estado persistido de um lançamento.
 *
 * Idêntico às props de criação porque a entidade **não tem campo mutável**: não
 * existe estado que a persistência acrescente depois. O alias existe para que o
 * call site de `rehydrate` diga o que está fazendo.
 */
export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento imutável no ledger da wallet (RF-04, EL-07, RI-05).
 *
 * É a fonte auditável do saldo: RF-16 reconstrói `calculatedBalance` a partir
 * daqui, e a invariante final de todos os testes é `wallet.balance` igual a essa
 * reconstrução. Por isso a imutabilidade é **estrutural** — todos os campos são
 * `readonly` e não existe método de transição — e não uma convenção que alguém
 * possa quebrar acrescentando um setter. A contraparte no banco é a revogação de
 * `UPDATE`/`DELETE` em E-05 (RI-09).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /**
   * Cria um lançamento, validando valor e aritmética.
   *
   * As duas validações são o que impede o ledger de virar um registro decorativo:
   * um lançamento que não fecha `balanceBefore ± money = balanceAfter` faria a
   * reconciliação de RF-16 divergir sem que ninguém soubesse onde.
   *
   * @throws InvalidLedgerEntryError se o valor não for estritamente positivo
   * (D-021) ou se a aritmética não fechar.
   * @throws CurrencyMismatchError se os três valores não forem da mesma moeda —
   * vem de `Money`, porque `isBalanced()` opera sobre eles (D-017).
   */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        `lançamento exige valor estritamente positivo, recebido ${props.money.toString()}. ` +
          `A direção ${props.direction} é quem carrega o sinal (D-021).`,
      );
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    // Construir antes de validar mantém a aritmética num lugar só: `isBalanced()`
    // é a mesma regra que a reconciliação de RF-16 vai conferir depois.
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `lançamento desbalanceado: ${props.balanceBefore.toString()} ${props.direction} ` +
          `${props.money.toString()} não resulta em ${props.balanceAfter.toString()}.`,
      );
    }

    return entry;
  }

  /**
   * Reconstrói um lançamento já persistido.
   *
   * **Não revalida** (§6.0): o que está no banco já passou por `create` e pelas
   * constraints de E-05. Revalidar aqui transformaria um dado histórico legítimo
   * — gravado sob uma regra anterior — em exceção durante uma simples leitura.
   */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /**
   * Verdadeiro se `balanceBefore ± money === balanceAfter`, conforme a direção.
   *
   * Público de propósito: RF-16 reconcilia o ledger inteiro e precisa perguntar
   * isto lançamento a lançamento, não só na criação.
   */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expected.equals(this.balanceAfter);
  }
}
