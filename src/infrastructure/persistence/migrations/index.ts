import type { MigrationObject } from "@mikro-orm/core";
import { M0001InitialSchema } from "./m0001-initial-schema.ts";

/**
 * Lista explícita de migrations, na ordem de aplicação.
 *
 * O MikroORM também descobre migrations varrendo uma pasta por glob. Aqui a
 * lista é declarada à mão por dois motivos: a descoberta por filesystem depende
 * de o processo estar rodando de `src/` ou de `dist/` — e este projeto roda TS
 * direto no Bun, sem build —, e um arquivo que ninguém importa some do
 * `tsc --noEmit` e do lint, que são o gate de toda etapa (`AGENTS.md` §5).
 *
 * O `name` é fixo e independente do nome da classe: é ele que vai gravado na
 * tabela de controle do migrator, e renomear a classe depois não pode
 * transformar uma migration já aplicada numa migration pendente.
 */
export const MIGRATIONS: readonly MigrationObject[] = [
  { name: "M0001InitialSchema", class: M0001InitialSchema },
];
