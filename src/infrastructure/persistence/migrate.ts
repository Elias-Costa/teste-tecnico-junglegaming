/**
 * Comando de migration (D-063, RNF-09).
 *
 * `bun run migration:up` aplica; `bun run migration:down` reverte **uma**.
 * Até E-14 o `up` só acontecia dentro dos testes, o que significa que um
 * avaliador clonando o repositório não tinha como preparar o banco — e o README
 * é entregável avaliado (RNF-08).
 *
 * Usa o **mesmo** `buildOrmConfig()` da aplicação, com a `migrationsList`
 * explícita de E-05. Nenhuma segunda fonte de verdade de schema: o que este
 * comando aplica é exatamente o que os testes de RT-08 exercitam.
 *
 * `down` sem argumento reverte só o último lote, e é deliberado não expor um
 * "desfaz tudo" por aqui: `down({ to: 0 })` apaga o schema inteiro, e um comando
 * de uma palavra que faz isso é um acidente esperando acontecer. Quem precisa
 * dele nos testes o chama pela API do ORM, onde a intenção fica escrita.
 */
import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "./orm-config.ts";

/** As duas direções aceitas. Qualquer outra coisa é erro de uso. */
const DIRECTIONS = ["up", "down"] as const;

type Direction = (typeof DIRECTIONS)[number];

const direction = process.argv[2] ?? "up";

if (!isDirection(direction)) {
  process.stderr.write(`uso: migrate [${DIRECTIONS.join("|")}]\n`);
  process.exit(1);
}

const orm = await MikroORM.init(buildOrmConfig());

try {
  if (direction === "up") {
    await orm.migrator.up();
  } else {
    await orm.migrator.down();
  }

  process.stdout.write(`migration ${direction} concluída\n`);
} finally {
  // `close(true)` força o fim do pool: sem ele o processo fica pendurado numa
  // conexão ociosa e o comando nunca retorna ao shell.
  await orm.close(true);
}

/**
 * Estreita o argumento da linha de comando para uma das duas direções.
 *
 * `some` com comparação, e não `includes`: `includes` sobre uma tupla `readonly`
 * exigiria um `as` para calar o compilador, e `AGENTS.md` §4 veta exatamente isso.
 */
function isDirection(value: string): value is Direction {
  return DIRECTIONS.some((known) => known === value);
}
