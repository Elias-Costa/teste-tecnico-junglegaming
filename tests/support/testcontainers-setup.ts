/**
 * Provisionamento automático de PostgreSQL e SQS para `bun run check:full`.
 *
 * Metade Testcontainers de D-011. Carregado via `--preload`, roda **antes** de
 * qualquer arquivo de teste e popula as mesmas variáveis de ambiente que o
 * Docker Compose popula no loop de desenvolvimento. É isso que torna os dois
 * caminhos intercambiáveis: nenhum teste sabe — nem pode saber — quem
 * provisionou a infraestrutura que ele está usando.
 *
 * O loop de desenvolvimento **não** carrega este arquivo; lá o Compose já está
 * de pé e as variáveis vêm do `.env`.
 */
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/** Imagens fixadas nas mesmas versões do `docker-compose.yml`. */
const POSTGRES_IMAGE = "postgres:17.11-alpine";
// 4.14.0 é o último LocalStack community que sobe sem token de licença — ver D-011.
const LOCALSTACK_IMAGE = "localstack/localstack:4.14.0";
const LOCALSTACK_PORT = 4566;

let postgres: StartedPostgreSqlContainer | undefined;
let localstack: StartedTestContainer | undefined;

const started = (async () => {
  [postgres, localstack] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new GenericContainer(LOCALSTACK_IMAGE)
      .withEnvironment({ SERVICES: "sqs", AWS_DEFAULT_REGION: "us-east-1" })
      .withExposedPorts(LOCALSTACK_PORT)
      .start(),
  ]);

  process.env.PGHOST = postgres.getHost();
  process.env.PGPORT = String(postgres.getPort());
  process.env.PGUSER = postgres.getUsername();
  process.env.PGPASSWORD = postgres.getPassword();
  process.env.PGDATABASE = postgres.getDatabase();

  process.env.SQS_ENDPOINT = `http://${localstack.getHost()}:${String(
    localstack.getMappedPort(LOCALSTACK_PORT),
  )}`;
  process.env.AWS_REGION = "us-east-1";
  // O LocalStack não valida assinatura; as credenciais são fictícias por definição.
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
})();

await started;

// Derrubar os containers ao fim do processo de teste. `beforeExit` não dispara
// quando o processo é encerrado por sinal, então o Ryuk do Testcontainers segue
// sendo a rede de segurança para runs interrompidos.
process.on("beforeExit", () => {
  void Promise.all([postgres?.stop(), localstack?.stop()]);
});
