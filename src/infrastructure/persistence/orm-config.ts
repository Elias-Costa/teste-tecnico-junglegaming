import { defineConfig, type Options } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { buildClientUrl } from "../config/database-env.ts";
import { MIGRATIONS } from "./migrations/index.ts";
import { ROW_SCHEMAS } from "./rows/index.ts";

/**
 * Configuração do MikroORM.
 *
 * A conexão vem do módulo único de D-011 (`database-env.ts`), o que faz o Docker
 * Compose e o Testcontainers serem intercambiáveis sem que nada aqui saiba qual
 * dos dois provisionou o banco.
 *
 * `entities` recebe os `EntitySchema` de E-06 (D-026) — mapeamentos sobre
 * modelos de linha, não sobre as classes de domínio. O schema em si continua
 * sendo criado pela migration escrita à mão: a metadata aqui **descreve** as
 * tabelas de E-05, nunca as gera. `snapshot: false` abaixo é o que impede as
 * duas coisas de virarem duas fontes da verdade.
 *
 * O `Migrator` é registrado explicitamente em `extensions`. `MikroORM.init()`
 * também carrega extensões sozinho, mas a dependência passaria a ser implícita —
 * e `AGENTS.md` §2.1 pede o caminho explícito onde a API do MikroORM está em
 * jogo, justamente porque D-001 assumiu esse ORM sem plano B.
 */
export function buildOrmConfig(): Options {
  return defineConfig({
    clientUrl: buildClientUrl(),
    entities: [...ROW_SCHEMAS],
    extensions: [Migrator],
    migrations: {
      // Lista explícita em vez de descoberta por glob — ver `migrations/index.ts`.
      migrationsList: [...MIGRATIONS],
      // Cada migration roda dentro da própria transação, e o lote inteiro dentro
      // de uma transação-mestre: um `up` que falha no meio não deixa metade do
      // schema de pé. São os defaults do MikroORM, declarados aqui porque o
      // comportamento é premissa de RT-08, não detalhe de configuração.
      transactional: true,
      allOrNothing: true,
      // O snapshot só existe para o `migrator.create` calcular o diff contra a
      // metadata. Aqui a migration é SQL escrito à mão, então o arquivo seria
      // lixo gerado na raiz do repositório — e um lixo perigoso, porque daria a
      // impressão de que o schema tem uma segunda fonte da verdade.
      snapshot: false,
    },
  });
}
