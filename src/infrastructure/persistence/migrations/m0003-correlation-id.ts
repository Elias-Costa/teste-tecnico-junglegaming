import { Migration } from "@mikro-orm/migrations";

/**
 * Correlação de ponta a ponta guardada na transação (D-055, RNF-06).
 *
 * O worker de referências fora de ordem (RF-26) publica eventos **muito depois**
 * da submissão que criou a transação: quando a `BET` finalmente chega, quem
 * anuncia o `ROLLBACK` resolvido é um laço de fundo, não a requisição do
 * provedor. Sem esta coluna, esse evento nasceria com uma correlação inventada,
 * e o rastro que RNF-06 pede se romperia exatamente no ponto em que ele é mais
 * difícil de reconstruir à mão — o desfecho que aconteceu fora da requisição.
 *
 * **Migration nova, não edição das anteriores.** Mesmo motivo da `m0002`: uma
 * migration já aplicada não muda de conteúdo mantendo o nome (RNF-09).
 */
export class M0003CorrelationId extends Migration {
  /** Nome estável, independente do nome da classe (que um minificador mangla). */
  override name = "M0003CorrelationId";

  override up(): void {
    // `varchar(128)`, e não os 120 dos demais identificadores: a correlação não é
    // identificador de negócio deste sistema, é um valor **do provedor** ecoado de
    // volta, e `SAFE_CORRELATION_ID` (D-039) aceita até 128 caracteres. Cortar em
    // 120 recusaria em silêncio um valor que a borda HTTP já aceitou.
    //
    // Nulável porque uma linha criada **antes** desta migration não tem valor
    // honesto a receber. Um sentinela de backfill fingiria um rastro que não
    // existe; o nulo diz a verdade, e quem lê cai no fallback de D-039.
    this.addSql(`
      alter table "wager_transactions"
        add column "correlation_id" varchar(128);
    `);
  }

  /** Desfaz a coluna (RNF-09). */
  override down(): void {
    this.addSql(`
      alter table "wager_transactions"
        drop column "correlation_id";
    `);
  }
}
