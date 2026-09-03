import type { BusinessFailureCode } from "../domain/failure-code.ts";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.ts";

/**
 * Desfecho de negócio de uma transação, com o que cada caminho produz.
 *
 * União discriminada em vez de ler `transaction.failureCode` depois: aquele
 * getter é a união com os códigos de infraestrutura, e `WagerTransactionRejected`
 * exige um `BusinessFailureCode` por decisão de RF-25. Carregar o código no
 * desfecho entrega ao evento exatamente o tipo que ele pede, sem narrowing.
 *
 * O `entry` opcional de `processed` **é** RN-03 no tipo: `LOSS` é uma transação
 * aplicada que não move saldo e não gera lançamento. Como `WalletBalanceChanged`
 * se constrói a partir do lançamento (D-018), a ausência dele é o que faz o
 * evento não ser publicado — sem `if` sobre kind em lugar nenhum (RF-25).
 *
 * Mora em arquivo próprio (D-066) porque tem três donos: quem decide o desfecho
 * (`ProcessWagerTransaction`), quem o traduz em eventos (`OutboxEventRecorder`) e
 * quem lê o tipo para entender o contrato entre os dois.
 */
export type TransactionOutcome =
  | { readonly outcome: "processed"; readonly entry: WalletLedgerEntry | undefined }
  | { readonly outcome: "rejected"; readonly failureCode: BusinessFailureCode }
  | { readonly outcome: "pending-reference" };
