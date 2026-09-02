/**
 * Identidade do consumidor na inbox (RF-19, D-025, D-045).
 *
 * **Constante, e não variável de ambiente**, por decisão registrada em D-045. A
 * deduplicação de RF-19 só vale entre instâncias se todas usarem o mesmo valor, e
 * o sintoma de uma divergência não seria erro: seria **efeito duplicado em
 * silêncio**, que é literalmente EL-03. Uma variável de ambiente transformaria
 * esse risco em algo que um arquivo de compose esquecido consegue disparar.
 *
 * A dedupe continua sendo por consumidor — a mesma mensagem entregue a dois
 * consumidores diferentes é trabalho legítimo dos dois (D-025) —, mas hoje só
 * existe um. Um segundo grupo acrescenta **outra constante** aqui: mudança de
 * código revisada, não de ambiente.
 */

/** Consumidor da fila `wager-transactions.fifo` (§10 do enunciado). */
export const WAGER_TRANSACTIONS_CONSUMER = "wager-transactions-consumer";
