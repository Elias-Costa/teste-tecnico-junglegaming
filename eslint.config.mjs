// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Configuração de lint do projeto.
 *
 * Além do papel usual de estilo e correção, este arquivo carrega duas regras
 * que existem para tornar falhas eliminatórias **inintroduzíveis por ferramenta**
 * em vez de dependerem de disciplina de quem escreve:
 *
 *  - EL-01 (`number` para dinheiro): ver o bloco "Aritmética de ponto flutuante".
 *  - A fronteira do domínio exigida por RF-01 e `AGENTS.md` §4: ver "Fronteira".
 */
export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Lint com informação de tipos. Custa tempo, mas é o que habilita
        // `no-floating-promises` — e este projeto é transação e worker de ponta
        // a ponta, onde um `await` esquecido é bug silencioso de consistência.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Aritmética de ponto flutuante — EL-01, RI-01
  //
  // D-003 representa dinheiro como `bigint` de centavos. O risco não é escrever
  // `float` de propósito: é `Number(algumBigint)`, que converte para ponto
  // flutuante **em silêncio, sem lançar**. Nenhum teste de negócio quebraria de
  // imediato e o diff pareceria correto.
  //
  // Proibição por padrão em todo `src/`, com exceção estreita mais abaixo.
  // ---------------------------------------------------------------------------
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='Number']",
          message:
            "EL-01: `Number()` converte bigint para ponto flutuante em silêncio. Dinheiro é bigint de centavos (D-003).",
        },
        {
          selector: "CallExpression[callee.name=/^parse(Float|Int)$/]",
          message:
            "EL-01: `parseFloat`/`parseInt` produzem `number`. Converta string decimal para centavos pelo parser de `Money` (D-003, D-015).",
        },
        {
          selector: "MemberExpression[property.name='toFixed']",
          message:
            "EL-01: `toFixed` só existe em `number`. A formatação de dinheiro é divisão e resto sobre bigint (D-003).",
        },
        {
          selector: "MemberExpression[object.name='Math']",
          message:
            "EL-01: `Math` opera em ponto flutuante. Nenhuma operação monetária deste domínio precisa dele (D-003).",
        },
      ],
    },
  },
  {
    // Exceção estreita e deliberada: porta de banco, tamanho de lote e limites
    // de retry (D-008) são inteiros de configuração, não dinheiro. A exceção é
    // por diretório justamente para não poder ser ampliada por descuido.
    files: ["src/infrastructure/config/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },

  // ---------------------------------------------------------------------------
  // Fronteira do domínio — RF-01, AGENTS.md §4
  //
  // O domínio não conhece ORM, framework HTTP, SDK de nuvem nem as camadas de
  // fora. O MikroORM v7 já removeu decorators, o que torna metade disso
  // estrutural; esta regra cobre a outra metade — imports diretos.
  // ---------------------------------------------------------------------------
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@mikro-orm/*", "@nestjs/*", "@aws-sdk/*", "pg", "prom-client"],
              message:
                "RF-01: o domínio não depende de ORM, framework nem SDK. O mapeamento vive em `src/infrastructure` (D-004).",
            },
            {
              group: ["**/application/**", "**/infrastructure/**", "**/interface/**"],
              message:
                "AGENTS.md §4: o domínio é a camada mais interna e não importa das camadas de fora.",
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Fronteira da aplicação — EL-06, RI-04, D-028
  //
  // O critério de conclusão de E-07 é "grep no `src/application` não encontra
  // nenhuma chamada de cliente SQS". Grep é verificação de quem lembra de rodar;
  // esta regra é a mesma verificação rodando no gate de toda etapa.
  //
  // O SDK da AWS está aí pelo motivo óbvio: publicar do use case é EL-06, e a
  // outbox existe para ser a única via. O MikroORM está pelo motivo menos
  // óbvio — a aplicação orquestra transação pela porta `UnitOfWork` (D-028), e
  // um `EntityManager` importado aqui abriria caminho para escrita fora dela.
  // ---------------------------------------------------------------------------
  {
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@aws-sdk/*"],
              message:
                "EL-06/RI-04: a publicação é exclusivamente pela outbox. Quem fala com o SQS é o worker de E-10.",
            },
            {
              group: ["@mikro-orm/*", "pg"],
              message:
                "D-028: a aplicação orquestra transação pela porta `UnitOfWork`. O ORM vive em `src/infrastructure`.",
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Módulos do NestJS
  //
  // Um módulo é uma classe vazia por desenho: todo o conteúdo está no decorator,
  // e o container só precisa do símbolo como chave. `no-extraneous-class` está
  // certa em geral e errada aqui, então a exceção é por padrão de nome de
  // arquivo — não por comentário solto, que se espalharia a cada módulo novo.
  // ---------------------------------------------------------------------------
  {
    files: ["src/**/*.module.ts"],
    rules: {
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },

  // ---------------------------------------------------------------------------
  // Fronteira da borda HTTP — EL-06, RI-04
  //
  // A camada de interface é a segunda com motivo aparente para "publicar direto":
  // o controller tem o resultado em mãos e o SDK estaria a um import de
  // distância. A outbox é a única via, e um evento publicado no controller sairia
  // **antes** do commit da transação que o use case abriu — EL-06 na forma mais
  // difícil de enxergar em revisão, porque o caminho feliz continuaria correto.
  //
  // Ao contrário de `src/application`, o MikroORM é permitido aqui: é esta camada
  // que monta o grafo de dependências (`app.module.ts`) e precisa do
  // `EntityManager` para construir o `UnitOfWork`.
  // ---------------------------------------------------------------------------
  {
    files: ["src/interface/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@aws-sdk/*"],
              message:
                "EL-06/RI-04: a publicação é exclusivamente pela outbox, dentro da transação do use case. Quem fala com o SQS é o worker de E-10.",
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Testes
  // ---------------------------------------------------------------------------
  {
    files: ["tests/**/*.ts"],
    rules: {
      // Asserção de não-nulo é legítima em teste: o próprio teste falha se a
      // premissa não valer, que é exatamente o que se quer.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Este arquivo de configuração não faz parte do programa TypeScript.
  {
    files: ["**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
