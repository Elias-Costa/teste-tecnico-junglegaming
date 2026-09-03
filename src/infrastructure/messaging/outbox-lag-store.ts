import type { EntityManager } from "@mikro-orm/postgresql";

/**
 * A consulta que alimenta `outbox_lag_seconds` (D-010, RF-24).
 *
 * Vive ao lado de `OutboxClaimStore` pela mesma razão que ele não vive no
 * repositório da outbox: isto não persiste agregado nenhum, é leitura de **estado
 * de entrega** — há quanto tempo existe a mensagem mais antiga que ainda não
 * saiu.
 *
 * SQL cru, e não `QueryBuilder`: é uma agregação sobre uma coluna, e o índice
 * parcial `ix_outbox_messages_pending` de E-05 já cobre exatamente este predicado.
 */
export class OutboxLagStore {
  constructor(private readonly em: EntityManager) {}

  /**
   * Idade, em segundos, da mensagem pendente mais antiga. Zero quando não há
   * nenhuma pendente — que é o estado saudável e o que o gauge deve mostrar.
   *
   * **A subtração acontece no banco, e o resultado vem como `float8`.** Duas
   * razões, e as duas importam:
   *
   *  1. comparar um `timestamptz` do PostgreSQL com o relógio do processo mediria
   *     também o desvio entre os dois relógios, e um lag de segundos não sobrevive
   *     a esse ruído;
   *  2. o cast é para `float8` **de propósito**: `extract(epoch ...)` devolve
   *     `numeric`, que o driver entrega como **string** (fato de E-00), e
   *     converter string para número em código exigiria justamente o que a guarda
   *     de EL-01 bane. `float8` chega como número pelo próprio driver. Lag é
   *     duração, não dinheiro — a guarda continua valendo onde ela existe para
   *     valer.
   */
  async oldestPendingLagSeconds(): Promise<number> {
    const rows = await this.em.getConnection().execute<{ lag_seconds: number | null }[]>(
      `select extract(epoch from now() - min("occurred_at"))::float8 as lag_seconds
         from "outbox_messages"
        where "published_at" is null`,
    );

    // `min()` sobre conjunto vazio devolve `null`, e uma outbox vazia é lag zero.
    return rows[0]?.lag_seconds ?? 0;
  }
}
