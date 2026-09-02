# AGENTS.md — Instruções para Agentes de IA neste Repositório

Fonte primária de comportamento para qualquer agente de IA trabalhando neste repositório (Claude Code ou outra ferramenta compatível com `AGENTS.md`). Leia por completo antes de propor ou executar qualquer mudança.

**Duas prioridades se sobrepõem a qualquer outra consideração neste repositório:**

1. Existem **falhas eliminatórias** (`docs/requirements.md`, seção 5 — EL-01..EL-08). Uma única delas invalida o trabalho inteiro, independentemente da qualidade do resto. Vêm antes de tudo, inclusive de elegância.
2. **Prefira sempre a solução explícita e explicável à solução esperta.** Havendo duas formas corretas, escolha a que se defende em uma frase. Código que ninguém consegue explicar é passivo, não ativo.

---

## 0. Regra de Ouro

**Não invente regra de negócio, decisão de arquitetura ou requisito que não esteja documentado.**

O desafio (`docs/desafio-original.md`) **delega deliberadamente** cerca de 12 decisões ao candidato — ORM, estratégia de lock, taxonomia de `failureCode`, mapa de status HTTP, TTL de retry, etc. Essas decisões são parte do que está sendo avaliado e **não são suas para tomar**.

Se uma tarefa exigir uma decisão não registrada:

1. **Pare antes de implementar.**
2. Verifique se ela já não está resolvida (ou listada como "em aberto") em `docs/decisions.md`.
3. Descreva explicitamente qual decisão falta e as opções razoáveis, com o trade-off de cada uma.
4. **Pergunte ao mantenedor.** Não assuma o "padrão de mercado" nem a alternativa mais provável.
5. Registre a resposta em `docs/decisions.md` **antes** de implementar.

Isso vale mesmo que a decisão pareça óbvia. Se não está escrito, não está definido — e o registro precisa dizer *por que* foi assim e não de outro jeito, não apenas o que ficou decidido.

---

## 1. Documentos de Referência (fonte da verdade)

Releia o arquivo atual no repositório. **Não confie em memória de conversas anteriores.**

| Documento | Quando consultar |
|---|---|
| `docs/desafio-original.md` | Enunciado íntegro do desafio. Fonte da verdade final. Em conflito com qualquer outro documento, **ele vence** |
| `docs/requirements.md` | Antes de qualquer implementação. Requisitos numerados (RF/RN/RNF), restrições invioláveis (RI), falhas eliminatórias (EL) e testes obrigatórios (RT), com critério de aceite |
| `docs/decisions.md` | Decisões já tomadas com o mantenedor + fila de decisões em aberto. Consultar antes de perguntar; registrar toda decisão nova aqui |
| `docs/implementation-plan.md` | Ordem oficial de implementação. Consultar o "Estado atual" no início de toda tarefa; trabalhar só na etapa atual; atualizar ao concluir |
| `ARCHITECTURE.md` | Entregável avaliado (5 pts). Curadoria final de `docs/decisions.md` — decisões, trade-offs e limitações conhecidas |
| `README.md` | Entregável avaliado. Setup e comandos que um avaliador vai executar do zero |

---

## 2. Stack Obrigatória (imposta pelo desafio — não trocar)

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | **Bun 1.x** |
| Linguagem | **TypeScript** em modo estrito |
| Framework | **NestJS** |
| Banco | **PostgreSQL** |
| Mensageria | **AWS SQS** via **LocalStack** ou **MiniStack** |
| Orquestração local | **Docker Compose** |
| Migrations | versionadas e **reversíveis** |
| ORM | **MikroORM** — decidido em D-001, **sem fallback para TypeORM** |

**Prisma e outros ORMs estão fora do escopo do desafio.** Trocar qualquer item desta lista não é decisão do agente — é motivo de parada (seção 0).

### 2.1 Não escreva API de biblioteca de memória

**Este é o maior ponto de alucinação deste projeto.** A combinação Bun + NestJS + MikroORM tem pouca representação nos dados de treino, e as APIs mudam entre versões.

Antes de escrever qualquer chamada de MikroORM/TypeORM, SDK da AWS, LocalStack ou NestJS: **confira a versão instalada em `package.json` e consulte a documentação oficial daquela versão.** Vale especialmente para `EntityManager.transactional()`, `LockMode`, `QueryBuilder`, `MessageGroupId`/`MessageDeduplicationId` em filas FIFO e visibility timeout.

Se não for possível confirmar a API, **diga isso** em vez de gerar código plausível.

**Fatos já verificados no spike E-00** (não re-derivar, não contradizer):

- MikroORM **v7 não tem decorators**. Mapeamento por `EntitySchema`, na camada de infraestrutura.
- `LockMode.PESSIMISTIC_WRITE` → `SELECT ... FOR UPDATE`; `LockMode.PESSIMISTIC_PARTIAL_WRITE` → `FOR UPDATE SKIP LOCKED`.
- `orm.isConnected()` é preguiçoso e retorna `false` antes da primeira conexão — **não serve como readiness** (RF-17).
- `Bun.randomUUIDv7()` é nativo. Nenhuma biblioteca de UUID no projeto.
- O driver devolve `numeric` como `string`. Nenhum type parser pode ser registrado.

**Fatos verificados em E-06** (mesma regra — não re-derivar, não contradizer):

- `em.insert()` e `em.nativeUpdate()` **não passam pelo Unit of Work** e carregam o `transactionContext` do `EntityManager` até o driver. É o que torna a escrita por comando explícito de D-028 atômica dentro de `em.transactional()`.
- `checkLockRequirements` **recusa `PESSIMISTIC_READ`/`PESSIMISTIC_WRITE` fora de transação** com `ValidationError`. `PESSIMISTIC_PARTIAL_WRITE` **não** está nessa lista — vale para o claim com lease de E-10.
- `DecimalType` converte para `number` quando `runtimeType` é `'number'`. Por isso as colunas de dinheiro são mapeadas como `type: "string", columnType: "numeric(19,2)"`: nenhum tipo do ORM opina sobre o valor (EL-01).
- O `CommitOrderCalculator` deriva a ordem dos `INSERT` das **relações declaradas**. Os modelos de linha de D-026 não declaram nenhuma, então quem ordena é o código do use case.

**Fatos verificados em E-08** (mesma regra — não re-derivar, não contradizer):

- `DriverException` copia **todas as próprias propriedades** do erro original ao envolvê-lo (`Object.getOwnPropertyNames(previous).forEach(...)`). É por isso que `.constraint` e `.code` do `pg` sobrevivem à conversão — sem eles, D-035 não teria como saber **qual** UNIQUE falhou, e D-037 não teria SQLSTATE para classificar.
- O `PostgreSqlExceptionConverter` mapeia exatamente `40001`/`40P01`, `23502`, `23503`, `23505`, `23514`, `42601`, `42702`, `42703`, `42P01` e `42P07`. **Não produz `ConnectionException` nem `LockWaitTimeoutException`** — falha de conexão chega como `DriverException` base. Por isso a lista de D-037 é de SQLSTATE, e não de classes do ORM.
- No NestJS 12, `createHandleResponseFn` é chamada **sem** o `httpStatusCode`, e o status do handler é aplicado **antes** do método rodar. Consequência prática: com `@Res({ passthrough: true })`, um `response.status(...)` dentro do controller **prevalece** sobre o padrão `201` do `POST`. É o que sustenta D-036.
- `@types/express` **não** está instalado — `express` é transitivo de `@nestjs/platform-express`. O objeto de resposta é tipado por interface estrutural própria (`src/interface/http/http-response.ts`), nunca por import de tipo do express.
- `MikroOrmCoreModule` registra o middleware de `RequestContext` por padrão (`registerRequestContext !== false`). Vai **desligado** neste projeto: identity map por requisição é exatamente o que D-028 removeu.
- O `EntityManager` exportado por `@mikro-orm/postgresql` é o `PostgreSqlEntityManager`, e é ele que `PostgreSqlDriver.createEntityManager()` instancia — então injetá-lo por esse símbolo resolve o provider que o `MikroOrmModule` registra.

**Fatos verificados em E-10** (mesma regra — não re-derivar, não contradizer). Valem em cheio para E-11, que é a **outra** ponta do mesmo SDK:

- `@aws-sdk/client-sqs@3.1123.0`: `CreateQueueRequest` tem `QueueName` e `Attributes?: Partial<Record<QueueAttributeName, string>>` — os atributos são **strings**, então FIFO é `{ [QueueAttributeName.FifoQueue]: "true" }`, nunca booleano. `SendMessageRequest` carrega `MessageGroupId` e `MessageDeduplicationId` como campos opcionais de primeiro nível.
- `QueueNameExists` é uma **classe de exceção exportada** pelo pacote e só é lançada quando a fila existe com atributos **diferentes**. Com atributos iguais, `CreateQueue` é idempotente e devolve a URL existente — é o que sustenta D-041.
- `Message.Attributes` é `Partial<Record<MessageSystemAttributeName, string>>` e vem **vazio** a menos que o `ReceiveMessage` peça `MessageSystemAttributeNames`. O campo antigo `AttributeNames` ainda existe, mas é tipado como `QueueAttributeName[]` — tipo diferente, e não é ele que traz `MessageGroupId`.
- No `EntityManager`, `nativeUpdate` e os `find`/`findOne` com `disableIdentityMap: true` resolvem o contexto por `getContext(false)`, ou seja, **sem** a validação de `allowGlobalContext`. É o que permite `OutboxClaimStore` operar sobre o `orm.em` global fora de transação sem `cannotUseGlobalContext`.
- `FindOptions.lockMode` é tipado como `Exclude<LockMode, LockMode.OPTIMISTIC>`; `FindOneOptions` omite `limit` e `lockMode` do `FindOptions` e redeclara `lockMode` sem a exclusão.
- A regra `@typescript-eslint/no-unnecessary-condition` **estreita campos de `this`** através de um `while`: reler a bandeira de parada depois de um `await` vira erro de lint. A leitura precisa passar por um método (`isRunning()`), que o compilador não estreita. Vale para todo laço de worker — E-11 e E-13 vão esbarrar no mesmo.

### 2.2 Quirks do ambiente de desenvolvimento

- O Compose publica o PostgreSQL em **55432**, não 5432. Uma instalação nativa de PostgreSQL na máquina ocupa a 5432 e responde ao `localhost` antes do proxy do Docker; o sintoma é `28P01` com o container saudável e as credenciais corretas.
- O LocalStack está fixado em **`4.14.0`**. A linha 2026.x exige token de licença e encerra com exit 55.

---

## 3. O Que Não Fazer (explícito, não implícito)

**Restrições invioláveis do desafio** (`docs/requirements.md`, RI-01..RI-09) — resumo:

- Não usar `number`, `float` ou `double` para dinheiro, em lugar nenhum.
- Não usar cache em memória como garantia de idempotência.
- Não confiar apenas em SQS FIFO para garantir consistência — o banco é o guardião das invariantes.
- Não publicar evento antes do commit da transação financeira.
- Não sobrescrever nem excluir lançamentos do ledger.
- Não usar lock global compartilhado por todas as wallets.
- Não implementar saldo como `read → calculate → update` sem controle de concorrência.
- Unicidade, imutabilidade e não-negatividade devem estar **no schema do banco**, não só em código de aplicação.

**Escopo:**

- Não implementar nada listado em `docs/requirements.md` seção 7 (Fora de Escopo), mesmo que pareça trivial "já que está ali".
- **Não implementar autenticação** (decidido em D-012). Apenas `ProviderIdentityPort` + `AuthGuard` no-op como ponto de extensão. Auth vale **0 ponto** e compete com os 70 pontos do núcleo.
- Não adicionar diferenciais opcionais (teste de carga, double-entry, OpenTelemetry, dashboard) sem que o núcleo esteja completo e verde.
- Não "aproveitar para" refatorar código fora da etapa atual.

---

## 4. Convenções de Código

- TypeScript em modo estrito (`strict: true`), sem `any` e sem `as` para calar o compilador.
- Nomes de arquivo e pasta em `kebab-case`; classes e componentes em `PascalCase`.
- **A camada de domínio não depende de nada externo**: sem decorators do NestJS, sem tipos monetários ou decorators do ORM, sem imports de infraestrutura. Entidades usam construtor `private`/`protected` + factories estáticas (`create`, `open`, `from`, `rehydrate`).
- `rehydrate` **não revalida** regras de transição — apenas reconstrói estado já persistido.
- **Comentários são obrigatórios**, mas explicam **propósito e porquê** — não narram o código. Sempre em português (pt-BR). Lógica não óbvia (estratégia de lock, cálculo de hash canônico, backoff, direção do ledger) ganha comentário citando a origem da regra (RF-XX / RN-XX / EL-XX).
- **JSDoc** em todo símbolo exportado: descrição curta (1–3 linhas) do que faz e por que existe. **Sem tipos nos tags** (`@param {string}` é redundante em TypeScript). `@param`/`@returns` só quando dizem algo além do nome e do tipo; `@throws` para erros esperados. Helpers internos triviais não precisam.
- **Documentação acompanha o código.** Se a mudança afeta algo descrito em `docs/`, atualizar o documento **na mesma tarefa** e citar a atualização na resposta. Nunca deixar documento e código divergirem.

---

## 5. Fluxo de Trabalho Esperado

1. Verificar a etapa atual no "Estado atual" de `docs/implementation-plan.md`. Trabalhar **apenas nela**, na ordem do roteiro.
2. Ler os requisitos citados na etapa (`docs/requirements.md`) antes de codar. Não implementar de memória.
3. Implementar apenas o que a etapa descreve — nem menos, nem mais.
4. Rodar `bun run check` (e `bun run check:full` quando a etapa tocar banco ou fila) e **colar a saída na resposta**. Afirmar que passou não é evidência; a saída é.
5. Atualizar a documentação afetada e registrar decisões novas em `docs/decisions.md`.
6. Marcar o checkbox da etapa e atualizar o "Estado atual" em `docs/implementation-plan.md`.
7. Ao concluir, **citar quais RF-XX/RN-XX foram atendidos** e sugerir os commits da etapa (ver abaixo), cada mensagem de uma linha no formato `tipo: descrição curta`.
8. Se a tarefa expõe uma lacuna nos documentos, sinalizar explicitamente — não seguir em frente.

**O agente não cria branches nem faz commits.** Quem commita é o mantenedor, depois de ler o diff. Isso é intencional: ler o diff é como o mantenedor mantém domínio sobre o que entra no repositório.

### 5.1 Granularidade de commit

A etapa é a unidade de **trabalho**; o commit é a unidade de **mudança**. Quase sempre coincidem — o roteiro foi desenhado com escopo fechado —, mas não por definição.

Ao concluir, o agente diz explicitamente se a etapa é **uma** mudança ou **várias**, aplicando três testes:

- **A mensagem precisa de "e"?** Assunto que não cabe numa oração sem conjunção são dois assuntos.
- **O revert leva refém?** Se desfazer uma parte apaga trabalho não relacionado, são commits distintos.
- **Cada metade fica verde sozinha?** Se não fica, é **uma** mudança — split que produz commit quebrado é pior que commit grande.

Quando forem várias, apontar a costura, dar a ordem (a dependência de import manda) e confirmar que cada lado passa `bun run check` isoladamente. Quando for uma, dizer isso e sugerir um commit só.

**Fatiar mudança atômica para o histórico parecer arrumado é pior que não fatiar:** espalha um raciocínio único por vários diffs e obriga quem lê a remontá-lo. A decisão final é sempre do mantenedor, na leitura do diff.

---

## 6. Bloqueio Externo = Parar

Se a etapa depender de container que não sobe, imagem que não baixa, porta ocupada ou configuração ausente: **pare e reporte**. Nunca crie mock, stub silencioso ou desvio condicional para "destravar" — mock que substitui Postgres ou SQS é falha eliminatória (EL-08).

---

## 7. Sobre Ambiguidade

Este repositório é mantido por uma pessoa, sob prazo, sem revisão constante. Erros silenciosos — uma regra de negócio inventada, uma decisão revertida sem aviso — passam despercebidos por muito mais tempo do que passariam num time, e costumam aparecer quando já é caro corrigir.

Na dúvida, **é sempre preferível perguntar e parecer "menos autônomo" do que assumir errado e seguir em frente**.
