import { Migration } from "@mikro-orm/migrations";

/**
 * Saldo observado no desfecho da transação (D-030, RN-12).
 *
 * RN-12 manda o replay devolver o resultado original **incluindo o saldo
 * observado naquele momento**, e nada no schema de E-05 guardava esse valor.
 * Para uma transação aplicada com movimento ele existiria no `balance_after` do
 * lançamento, mas rejeição não gera lançamento (RN-11) e `LOSS` não gera
 * lançamento (RN-03) — reconstruir pelo ledger falharia exatamente onde a
 * pergunta é feita. Guardar a resposta junto da transação que a produziu é o que
 * torna o replay uma leitura de linha, uniforme para todo kind e status.
 *
 * **Migration nova, não edição da `m0001`.** A anterior já está aplicada e é
 * versionada; reescrevê-la faria uma migration aplicada mudar de conteúdo sem
 * mudar de nome, que é o oposto do que RNF-09 pede.
 *
 * **Duas colunas, e não reuso de `currency`.** A moeda do saldo é a **da
 * wallet**; a coluna `currency` da transação é a moeda da operação. As duas
 * divergem precisamente no caso que rejeita com `CURRENCY_MISMATCH`, que é
 * quando ler a coluna errada daria um valor plausível e errado.
 */
export class M0002ObservedBalance extends Migration {
  /** Nome estável, independente do nome da classe (que um minificador mangla). */
  override name = "M0002ObservedBalance";

  override up(): void {
    // Nuláveis porque o saldo só é observado no desfecho: uma transação em
    // `PENDING` ou `PENDING_REFERENCE` ainda não tem resposta a preservar.
    this.addSql(`
      alter table "wager_transactions"
        add column "observed_balance" numeric(19,2),
        add column "observed_balance_currency" varchar(3);
    `);

    this.addSql(`
      alter table "wager_transactions"
        -- Par ou nada, mesmo idioma do lease da outbox: valor sem moeda seria
        -- dinheiro sem unidade, e moeda sem valor não diz nada (D-004).
        add constraint "ck_wager_transactions_observed_balance_pair" check (
          ("observed_balance" is null) = ("observed_balance_currency" is null)
        ),
        -- EL-02 também na trilha de resposta: saldo observado negativo seria um
        -- estado que o \`CHECK\` de \`wallets\` não deixa existir.
        add constraint "ck_wager_transactions_observed_balance_non_negative" check (
          "observed_balance" is null or "observed_balance" >= 0
        ),
        add constraint "ck_wager_transactions_observed_balance_currency_format" check (
          "observed_balance_currency" is null
            or "observed_balance_currency" ~ '^[A-Z]{3}$'
        );
    `);
  }

  /**
   * Desfaz as duas colunas (RNF-09).
   *
   * Sem `drop constraint`: as três `CHECK` só referenciam as colunas removidas,
   * e o PostgreSQL as derruba junto. Listá-las daria a impressão de que existe
   * ordem a respeitar entre elas.
   */
  override down(): void {
    this.addSql(`
      alter table "wager_transactions"
        drop column "observed_balance_currency",
        drop column "observed_balance";
    `);
  }
}
