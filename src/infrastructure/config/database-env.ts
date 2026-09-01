/**
 * Módulo único de configuração de conexão exigido por D-011.
 *
 * Existe para que o Docker Compose (loop de desenvolvimento) e o Testcontainers
 * (`bun run check:full`) sejam intercambiáveis: ambos apenas populam estas
 * variáveis de ambiente, e nenhum teste precisa saber qual dos dois o provisionou.
 * Se algum teste passar a inspecionar a origem da conexão, a mitigação de D-011
 * falhou e a duplicidade virou dívida.
 */

/** Endereço de um PostgreSQL alcançável, resolvido a partir do ambiente. */
export interface DatabaseEnv {
  host: string;
  port: number;
  user: string;
  password: string;
  dbName: string;
}

/**
 * Lê a conexão do ambiente, com o Compose local como padrão.
 *
 * `Number()` é aceitável aqui: a proibição de EL-01 vale para `src/domain/`,
 * onde dinheiro é manipulado. Porta de banco não é dinheiro.
 */
export function readDatabaseEnv(): DatabaseEnv {
  return {
    host: process.env.PGHOST ?? "localhost",
    // Default alinhado ao que o Compose publica — ver docker-compose.yml.
    port: Number(process.env.PGPORT ?? "55432"),
    user: process.env.PGUSER ?? "wagering",
    password: process.env.PGPASSWORD ?? "wagering",
    dbName: process.env.PGDATABASE ?? "wagering",
  };
}

/**
 * Monta a URL de conexão do PostgreSQL.
 *
 * Existe para dar simetria aos dois caminhos de D-011: o Testcontainers entrega
 * a conexão como URI pronta (`getConnectionUri()`), então expor o Compose no
 * mesmo formato faz com que a configuração do MikroORM seja idêntica nos dois
 * casos e nenhum teste precise ramificar. Opções soltas (`host`/`port`/`user`/
 * `password`) também funcionam — verificado no spike E-00 — mas exigiriam
 * desmontar a URI do Testcontainers só para remontá-la.
 *
 * Credenciais são percent-encoded para tolerar senha com caractere reservado.
 */
export function buildClientUrl(env: DatabaseEnv = readDatabaseEnv()): string {
  const user = encodeURIComponent(env.user);
  const password = encodeURIComponent(env.password);
  return `postgresql://${user}:${password}@${env.host}:${String(env.port)}/${env.dbName}`;
}
