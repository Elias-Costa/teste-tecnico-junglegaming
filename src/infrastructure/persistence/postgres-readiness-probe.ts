import type { EntityManager } from "@mikro-orm/postgresql";
import type { ReadinessProbe } from "../observability/readiness.ts";

/**
 * Readiness do PostgreSQL (RF-17): uma query real, não um flag.
 *
 * **`orm.isConnected()` não serve, e isso está registrado desde D-001:** ele é
 * preguiçoso e devolve `false` antes da primeira conexão, o que faria um processo
 * saudável recém-subido se declarar indisponível — e, pior, poderia devolver
 * `true` com o banco já inalcançável. `select 1` é o mesmo par de verificações
 * que `tests/integration/infrastructure-reachability.test.ts` faz desde E-01.
 */
export class PostgresReadinessProbe implements ReadinessProbe {
  readonly name = "postgres";

  constructor(private readonly em: EntityManager) {}

  async check(): Promise<boolean> {
    try {
      const rows = await this.em.getConnection().execute<{ ok: number }[]>("select 1 as ok");

      return rows[0]?.ok === 1;
    } catch {
      // Banco fora é a resposta, não a exceção: quem chama precisa de `false`
      // para responder `503`, e um erro escapando daqui viraria `500` no filtro.
      return false;
    }
  }
}
