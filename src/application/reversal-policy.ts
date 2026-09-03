import { BusinessFailureCode } from "../domain/failure-code.ts";
import type { LedgerDirection } from "../domain/ledger-direction.ts";
import type { Money } from "../domain/money.ts";
import type { WagerTransactionRepository } from "../domain/repositories/wager-transaction-repository.ts";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction.ts";

/** Os dois kinds que revertem outra transação (RN-04, RN-05). */
export type ReversalKind = WagerTransactionKind.Refund | WagerTransactionKind.Rollback;

/**
 * Estreita o kind para os dois que revertem (RN-04, RN-05).
 *
 * O compilador conhece `ReversalKind` pelo `switch` do use case, mas não tem como
 * derivá-lo de uma linha **lida do banco**: `resolvePendingReference` recebe um id
 * e precisa recuperar a garantia que o caminho de submissão tinha de graça.
 */
export function isReversalKind(kind: WagerTransactionKind): kind is ReversalKind {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

/**
 * O que cada reversão pode referenciar (RN-08).
 *
 * Tabela e não `if`: a regra é uma matriz de duas linhas no enunciado (§7), e
 * escrevê-la como matriz mantém a correspondência visível para quem confere o
 * código contra o documento. `LOSS`, `OPENING` e `ROLLBACK` não aparecem em
 * nenhuma das listas, e é isso que faz reverter um estorno ser
 * `INVALID_REFERENCE_KIND` em vez de recursão.
 */
const REVERSIBLE_REFERENCE_KINDS: Readonly<
  Record<ReversalKind, readonly WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * O que fazer com uma reversão, decidido sem tocar em agregado nenhum (D-066).
 *
 * Três desfechos, e a união é o contrato com o use case:
 *
 * - `wait` — a referência ainda pode chegar (RN-15). Nada foi decidido contra a
 *   transação; ela espera o worker de RF-26.
 * - `reject` — a regra que falhou já tem código, e é ele que o provedor recebe.
 * - `apply` — a reversão é válida; a direção e o id da referência resolvida vão
 *   junto porque quem os calculou foi esta função, com a referência em mãos.
 */
export type ReversalVerdict =
  | { readonly verdict: "wait" }
  | { readonly verdict: "reject"; readonly failureCode: BusinessFailureCode }
  | {
      readonly verdict: "apply";
      readonly direction: LedgerDirection;
      readonly referenceId: string;
    };

/**
 * Decide `REFUND` e `ROLLBACK` resolvendo a transação referenciada (RN-04..RN-10).
 *
 * **Decide e não aplica** (D-066). Nada aqui muta wallet ou transação: a função
 * lê a referência, confere as regras e devolve o veredito; quem move saldo e
 * marca status é o use case, que é onde a movimentação já morava. Uma função
 * chamada "decide" que move dinheiro é o tipo de coisa que passa despercebida na
 * leitura de um revisor.
 *
 * **A ordem dos `if` é a ordem de D-051**, e não é arbitrária: primeiro tudo
 * que o provedor corrige no payload (`REFERENCE_MISMATCH`,
 * `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`), depois o que o manda desistir
 * (`ALREADY_REVERSED`) e por último o que o manda escalar — este, o saldo
 * insuficiente na reversão, é do use case, porque depende do saldo da wallet
 * travada e não da referência.
 *
 * Ponto único da regra, servindo os **dois** chamadores do use case — a submissão
 * e a re-resolução do worker de RF-26 (D-054). Uma segunda implementação seria a
 * forma mais fácil de os dois divergirem justamente onde a divergência move
 * dinheiro.
 */
export async function decideReversal(
  transactions: WagerTransactionRepository,
  transaction: WagerTransaction,
  money: Money,
  kind: ReversalKind,
): Promise<ReversalVerdict> {
  // Garantido por `WagerTransaction.create`, que recusa `REFUND`/`ROLLBACK` sem
  // referência com `MissingReferenceError` (D-020, RN-06 → 400).
  const referenceExternalId = transaction.referenceExternalTransactionId ?? "";

  const reference = await transactions.findByProviderExternalId(
    transaction.providerId,
    referenceExternalId,
  );

  // RN-15: a referência pode simplesmente ainda não ter chegado. Não é
  // rejeição — a transação espera e o worker de RF-26 a resolve.
  if (reference === undefined) {
    return { verdict: "wait" };
  }

  // D-050: quem ainda pode virar `PROCESSED` espera; quem não pode mais é
  // rejeitado agora. Uma referência em `PENDING_REFERENCE` está ela própria
  // aguardando (cadeia fora de ordem); uma em `REJECTED`/`FAILED` é terminal
  // por D-013 e nunca vai ser reversível.
  if (reference.status === WagerTransactionStatus.PendingReference) {
    return { verdict: "wait" };
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    return { verdict: "reject", failureCode: BusinessFailureCode.ReferenceMismatch };
  }

  // RN-07: mesmo provider, player, wallet, moeda e rodada. O provider já é
  // critério da busca, então os quatro restantes são os que sobram para checar.
  if (
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.money.currency !== money.currency ||
    reference.roundId !== transaction.roundId
  ) {
    return { verdict: "reject", failureCode: BusinessFailureCode.ReferenceMismatch };
  }

  // RN-08. **Este passo protege o cálculo de direção lá embaixo:**
  // `ledgerDirectionFor` lança `NoLedgerDirectionError` se a referência for
  // `LOSS` ou `ROLLBACK`, e é esta lista que garante que ela nunca é chamada
  // com uma dessas.
  if (!REVERSIBLE_REFERENCE_KINDS[kind].includes(reference.kind)) {
    return { verdict: "reject", failureCode: BusinessFailureCode.InvalidReferenceKind };
  }

  // RN-10: reversão parcial está fora de escopo. Seguro depois do check de
  // moeda acima — `equals` lança entre moedas diferentes (D-017).
  if (!reference.money.equals(money)) {
    return { verdict: "reject", failureCode: BusinessFailureCode.AmountMismatch };
  }

  // RN-09, caminho de negócio. A garantia é o índice parcial de D-024, que
  // continua valendo se duas instâncias perguntarem ao mesmo tempo.
  if (await transactions.hasProcessedReversal(reference.id, kind)) {
    return { verdict: "reject", failureCode: BusinessFailureCode.AlreadyReversed };
  }

  // RN-05: a direção é o inverso da referência para `ROLLBACK`; `REFUND` sempre
  // credita (RN-04). Estornar um `WIN` ou um `REFUND`, portanto, **debita**.
  return {
    verdict: "apply",
    direction: transaction.ledgerDirectionFor(reference),
    referenceId: reference.id,
  };
}
