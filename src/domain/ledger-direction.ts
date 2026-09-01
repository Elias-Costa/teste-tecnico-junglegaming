/**
 * Direção de um lançamento no ledger (RF-04, §6.4).
 *
 * Vive em arquivo próprio porque tanto `WalletLedgerEntry` — que a usa para
 * validar a aritmética — quanto `WagerTransaction` — que a deriva do kind em
 * `ledgerDirectionFor` — dependem dela. Deixá-la em qualquer um dos dois criaria
 * uma dependência de direção arbitrária entre duas entidades irmãs.
 *
 * **A direção é quem carrega o sinal do movimento.** O `money` do lançamento é
 * sempre positivo (D-021); um valor negativo com direção codificaria o sinal
 * duas vezes, e duas fontes para o mesmo fato é como divergência entra.
 */
export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}
