/**
 * Lançamento recusado pela factory de `WalletLedgerEntry` (RF-04, EL-07).
 *
 * Cobre as duas validações da factory num tipo só — aritmética que não fecha
 * (`isBalanced()` falso) e valor não estritamente positivo (D-021) —, pelo mesmo
 * argumento que uniu `InvalidMoneyError` em E-02: quem consome trata as duas
 * identicamente. Ambas são erro de programação do use case, nunca uma rejeição
 * que o provedor possa corrigir sozinho, e por isso nenhuma tem `failureCode`.
 */
export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLedgerEntryError";
  }
}
