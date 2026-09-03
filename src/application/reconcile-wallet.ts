import { LedgerDirection } from "../domain/ledger-direction.ts";
import { Money, type MoneyProps } from "../domain/money.ts";
import { ResourceNotFoundError } from "./errors/resource-not-found-error.ts";
import type { UnitOfWork } from "./ports/unit-of-work.ts";

/**
 * Tamanho da página usada para dobrar o ledger.
 *
 * A reconciliação lê o ledger **inteiro**, e ler tudo de uma vez faria o
 * endpoint deixar de caber na memória no dia em que uma wallet acumular
 * histórico. Ler em páginas mantém o custo constante; o número é grande o
 * bastante para não multiplicar viagens ao banco numa wallet comum.
 */
const RECONCILIATION_PAGE_SIZE = 500;

/** O relatório de RF-16, na forma exata que o enunciado (§9) exibe. */
export interface ReconciliationReport {
  walletId: string;
  /** Saldo materializado na coluna da wallet. */
  storedBalance: MoneyProps;
  /** Saldo reconstruído somando o ledger — **nunca** lido do saldo materializado. */
  calculatedBalance: MoneyProps;
  /** `storedBalance − calculatedBalance`: quanto o saldo tem a mais do que o ledger justifica (D-057). */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Reconcilia o saldo materializado contra o ledger (RF-16, §6.4).
 *
 * **Não corrige nada, em hipótese alguma.** Uma correção silenciosa apagaria a
 * única evidência de que a invariante foi violada, e é justamente a divergência
 * que precisa chegar a um humano — o enunciado é explícito. O que este use case
 * faz é medir, sinalizar e avisar.
 *
 * Lê sob o lock da wallet (D-057). Em READ COMMITTED, ler o saldo e depois o
 * ledger sem lock veria dois instantes diferentes, e uma aposta confirmada entre
 * as duas leituras produziria uma divergência que nunca existiu — alarme falso
 * num sinal que RF-16 manda logar e contabilizar.
 */
export class ReconcileWallet {
  /**
   * @param onDivergence avisado quando `consistent` é falso. Existe para que a
   * divergência **não** suma em silêncio enquanto o log estruturado de RNF-06 e
   * as métricas de D-010 não existem (E-15) — mesma forma e mesmo motivo do
   * `onCycleError` de E-10. E-15 liga aqui o logger e a métrica de D-060.
   */
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly onDivergence?: ((report: ReconciliationReport) => void) | undefined,
  ) {}

  /**
   * @throws ResourceNotFoundError se a wallet não existe (D-056 → 404).
   */
  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.unitOfWork.run(async (repos) => {
      // Sob lock (D-057): o mesmo `findByIdForUpdate` de D-002, que RI-06 exige
      // ser o ponto único de aquisição. A reconciliação espera a movimentação em
      // voo terminar em vez de correr contra ela.
      const wallet = await repos.wallets.findByIdForUpdate(walletId);

      if (wallet === undefined) {
        throw new ResourceNotFoundError("wallet", walletId);
      }

      let calculated = Money.zero(wallet.currency);
      let checkedEntries = 0;
      let afterId: string | undefined = undefined;

      // Dobra o ledger em páginas pelo mesmo keyset de D-014. Toda a aritmética
      // passa por `Money`: reconstruir saldo com `number` seria EL-01 dentro do
      // endpoint que existe para provar que o saldo fecha.
      for (;;) {
        const page = await repos.ledger.findPage({
          walletId,
          afterId,
          limit: RECONCILIATION_PAGE_SIZE,
        });

        const last = page[page.length - 1];

        if (last === undefined) {
          break;
        }

        for (const entry of page) {
          calculated =
            entry.direction === LedgerDirection.Credit
              ? calculated.add(entry.money)
              : calculated.subtract(entry.money);
        }

        checkedEntries += page.length;
        afterId = last.id;

        if (page.length < RECONCILIATION_PAGE_SIZE) {
          break;
        }
      }

      const stored = wallet.balance;
      const difference = stored.subtract(calculated);

      return {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries,
      };
    });

    // Fora da transação: avisar é efeito colateral de observabilidade, e mantê-lo
    // dentro faria uma falha do observador desfazer uma leitura correta.
    if (!report.consistent) {
      this.onDivergence?.(report);
    }

    return report;
  }
}
