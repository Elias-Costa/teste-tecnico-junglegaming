# ARCHITECTURE

Decisões, trade-offs e limitações conhecidas do **Distributed Wagering Processor**.

Este documento é uma **curadoria** de [`docs/decisions.md`](docs/decisions.md), onde as 64 decisões estão registradas por extenso, cada uma com o contexto que a motivou e as alternativas descartadas. Aqui está o que sustenta o desenho e o que ele custa. Toda seção aponta para o `D-XXX` correspondente.

Duas regras governaram o projeto inteiro, e valem como chave de leitura:

1. **As falhas eliminatórias vêm antes de tudo.** Uma única delas invalida o trabalho inteiro. Cada uma tem um mecanismo que a torna difícil de introduzir **e** um teste que prova sua ausência — a tabela está na §3.
2. **A solução explicável vence a solução esperta.** Havendo duas formas corretas, escolhemos a que se defende em uma frase.

---

## 1. Visão

### Camadas

```
                    ┌──────────────────────────────────────────┐
   HTTP  ─────────► │  interface/http      interface/messaging │ ◄──── SQS
                    │  controllers,        parser de envelope, │
                    │  parsers, filtro     handler, DLQ        │
                    └────────────────────┬─────────────────────┘
                                         │  ProcessWagerTransactionCommand
                                         ▼
                    ┌──────────────────────────────────────────┐
                    │  application                             │
                    │  casos de uso, portas (Clock, IdGen,     │
                    │  Logger, UnitOfWork, ProviderIdentity)   │
                    └────────────────────┬─────────────────────┘
                                         ▼
                    ┌──────────────────────────────────────────┐
                    │  domain                                  │
                    │  Money, Wallet, WagerTransaction,        │
                    │  WalletLedgerEntry, Inbox/Outbox,        │
                    │  eventos, interfaces de repositório      │
                    └────────────────────▲─────────────────────┘
                                         │  implementa
                    ┌────────────────────┴─────────────────────┐
                    │  infrastructure                          │
                    │  MikroORM (EntitySchema, mappers,        │
                    │  repositórios), SQS, métricas, logger    │
                    └──────────────────────────────────────────┘
```

A dependência aponta **para dentro**. O domínio não conhece NestJS, MikroORM, o SDK da AWS nem `prom-client`; as interfaces de repositório vivem nele (D-027) e a infraestrutura as implementa.

### As fronteiras são impostas, não convencionadas

Duas delas não dependem de disciplina de quem escreve:

- **O MikroORM v7 removeu decorators por completo.** Não existe `@Entity`/`@Property`: o mapeamento vive num `EntitySchema`, que é objeto de infraestrutura. A exigência de "domínio sem decorators de ORM" passou a ser **estrutural** — não há ferramenta para violá-la (D-001).
- **Regras de ESLint fecham o resto.** `no-restricted-imports` proíbe o domínio de importar as camadas de fora; `no-restricted-syntax` bane `Number()`, `parseFloat`/`parseInt`, `.toFixed()` e `Math` em `src/domain/` — a guarda de EL-01, verificada com sonda que confirma que a regra dispara de fato. A única exceção é `src/infrastructure/config/`, onde porta de banco e tamanho de lote são inteiros de configuração, e a exceção é **por diretório** justamente para não poder ser ampliada por descuido.

### O que o repositório contém

| Diretório | Papel |
|---|---|
| `src/domain` | invariantes, entidades, eventos, interfaces de repositório. Sem dependência externa |
| `src/application` | casos de uso e portas. Orquestra o domínio; não conhece HTTP, SQL nem SQS |
| `src/infrastructure` | MikroORM, SQS, métricas, logger, configuração, migrations |
| `src/interface` | as duas bordas de entrada (HTTP e SQS) e o `WorkersModule` |
| `src/main.ts` | um processo que serve HTTP **e** roda os três laços |

---

## 2. O caminho do dinheiro

É o coração da avaliação, e o desenho inteiro existe para sustentar uma frase: **tudo que uma operação financeira produz é confirmado junto, ou descartado junto.**

```
                       ┌─── em.transactional() ──────────────────────────┐
                       │                                                 │
  comando ──► inbox?   │  1. SELECT ... FOR UPDATE  na wallet            │
  (HTTP ou SQS)        │  2. idempotência: a chave já existe?            │
                       │  3. regra de negócio decide o desfecho          │
                       │  4. INSERT  wager_transactions                  │
                       │  5. INSERT  wallet_ledger_entries               │
                       │  6. UPDATE  wallets  (saldo + version)          │
                       │  7. INSERT  inbox_messages   (se veio da fila)  │
                       │  8. INSERT  outbox_messages  (o evento)         │
                       │                                                 │
                       └──────────────── COMMIT ─────────────────────────┘
                                              │
                                              ▼
                        worker da outbox reivindica com lease,
                        publica no SQS, marca published_at
                                              │
                                              ▼
                        consumidor: ack SOMENTE depois do commit
```

Quatro propriedades caem desse desenho:

**A transação é única e curta, e não contém I/O externo.** O `SELECT ... FOR UPDATE` serializa por wallet; wallets diferentes não se veem. Como a publicação vai para a **outbox** e não para o SQS, nenhuma chamada de rede acontece com o lock na mão — que é a crítica clássica ao pessimistic locking, e aqui ela não se aplica (D-002).

**O evento nunca sai antes do commit.** A única via de publicação é a linha da outbox, gravada na mesma transação. Não existe cliente SQS acessível do caso de uso (D-009).

**O `ack` vem depois do commit.** Um crash entre o commit e o `ack` faz o SQS reentregar; a inbox absorve a reentrega sem duplicar efeito. É o cenário do teste RT-18, provado com um processo que morre de verdade.

**A idempotência é do banco.** Nenhuma estrutura em memória participa da decisão de replay: a `UNIQUE (idempotency_key)` e a PK composta da inbox é que decidem. Isso é o que torna a solução correta com N instâncias, e não com uma.

### As garantias moram no schema

RI-09 exige que unicidade, imutabilidade e não-negatividade estejam **no banco**, não apenas em código de aplicação:

| Garantia | Objeto no schema |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` |
| Uma wallet por `(playerId, currency)` | `UNIQUE (player_id, currency)` |
| Idempotência | `UNIQUE (idempotency_key)` |
| Uma transação por `(providerId, externalTransactionId)` | `UNIQUE (provider_id, external_transaction_id)` |
| Reversão única por referência | índice **parcial** único, restrito a `PROCESSED` (D-024) |
| Ledger imutável | **trigger** que lança `P0001` em qualquer `UPDATE`/`DELETE` (D-023) |
| Lançamento aritmeticamente válido | `CHECK` de `balanceBefore ± amount = balanceAfter` |
| Dedupe da inbox | PK composta `(consumer_name, message_id)` (D-025) |
| Coerência do lease da outbox | `CHECK` que exige `locked_by` e `locked_until` juntos |

Os enums são replicados como `CHECK` e não como `CREATE TYPE`: o `down` de um `CHECK` é o próprio drop da tabela, enquanto remover um valor de enum no PostgreSQL é operação hostil. A reversibilidade exigida por RNF-09 decidiu a favor do `CHECK`.

---

## 3. As oito falhas eliminatórias

Cada uma com o mecanismo que a previne e o arquivo que prova sua ausência.

| # | Falha | Mecanismo | Prova |
|---|---|---|---|
| **EL-01** | `number` para dinheiro | `Money` sobre `bigint` de centavos (D-003); coluna `numeric(19,2)` (D-004); regras de ESLint banindo `Number()`, `parseFloat`, `.toFixed()` e `Math` em `src/domain/` | `bun run lint` · [`tests/unit/money.test.ts`](tests/unit/money.test.ts) · [`tests/unit/money-mapper.test.ts`](tests/unit/money-mapper.test.ts), que trava o fato de o driver devolver `numeric` como **string** |
| **EL-02** | Saldo negativo por race | `CHECK (balance >= 0)` no schema **mais** `SELECT ... FOR UPDATE` por wallet (D-002) | [`tests/concurrency/same-wallet-contention.test.ts`](tests/concurrency/same-wallet-contention.test.ts) — 50 submissões paralelas e o cenário obrigatório da §8 · [`tests/integration/schema-constraints.test.ts`](tests/integration/schema-constraints.test.ts) |
| **EL-03** | Débito ou crédito duplicado | `UNIQUE (idempotency_key)` + inbox persistente; a segunda tentativa espera o `FOR UPDATE` da primeira e depois **lê** o resultado dela | [`tests/concurrency/same-wallet-contention.test.ts`](tests/concurrency/same-wallet-contention.test.ts) · [`tests/integration/sqs-wager-consumer.test.ts`](tests/integration/sqs-wager-consumer.test.ts) — mesma `messageId` entregue duas vezes |
| **EL-04** | Idempotência apenas em memória | Nenhuma estrutura em processo participa da decisão de replay. Decidem `UNIQUE (idempotency_key)`, a PK composta da inbox (D-025) e o `payloadHash` persistido (D-005) | [`tests/concurrency/multi-instance.test.ts`](tests/concurrency/multi-instance.test.ts) — **três processos separados**, que não compartilham memória por construção · [`tests/integration/http-write-api.test.ts`](tests/integration/http-write-api.test.ts) |
| **EL-05** | Correta só com uma instância | Nenhum estado de coordenação em memória: lease da outbox (D-009), inbox e `FOR UPDATE` estão **todos** no banco | [`tests/concurrency/multi-instance.test.ts`](tests/concurrency/multi-instance.test.ts) · [`tests/concurrency/outbox-publishers.test.ts`](tests/concurrency/outbox-publishers.test.ts) · [`tests/concurrency/service-restart.test.ts`](tests/concurrency/service-restart.test.ts) |
| **EL-06** | Evento publicado antes do commit | A outbox é a **única** via de publicação. `ProcessWagerTransaction` não tem acesso a cliente SQS nenhum — é ausência estrutural, não convenção | [`tests/integration/outbox-publisher.test.ts`](tests/integration/outbox-publisher.test.ts) · [`tests/concurrency/outbox-publishers.test.ts`](tests/concurrency/outbox-publishers.test.ts) — o cenário obrigatório de RF-24: o processo **morre depois de commitar o claim e antes de publicar**, e outra instância assume quando o lease vence e publica o evento |
| **EL-07** | Ausência de ledger auditável | Ledger insert-only, imutável por **trigger** no banco (D-023); nenhum `UPDATE`/`DELETE` concedido. Sem Unit of Work, não existe nem o caminho de um flush sujar uma linha (D-028) | [`tests/integration/schema-constraints.test.ts`](tests/integration/schema-constraints.test.ts) — o `UPDATE` morre com `P0001` · [`tests/unit/wallet-ledger-entry.test.ts`](tests/unit/wallet-ledger-entry.test.ts) · reconciliação em [`tests/integration/http-read-api.test.ts`](tests/integration/http-read-api.test.ts) |
| **EL-08** | Testes que substituem PostgreSQL e SQS por mocks | As 19 suítes de integração e concorrência rodam contra **containers reais**, autoprovisionados (D-011). Nenhum mock de banco ou de fila existe no repositório | as 13 suítes de `tests/integration/` e as 6 de `tests/concurrency/` · o preload [`tests/support/testcontainers-setup.ts`](tests/support/testcontainers-setup.ts) sobe PostgreSQL 17 e LocalStack de verdade |

**A invariante final da §6.4** — `wallet.balance == saldo reconstruído pelo ledger` — é verificada por uma **única** função, `expectLedgerReconciles` em [`tests/support/concurrency-harness.ts`](tests/support/concurrency-harness.ts). Um requisito que cada arquivo reimplementasse do seu jeito seria um requisito valendo de quatro jeitos.

---

## 4. Decisões e trade-offs

### 4.1 Dinheiro

**`Money` sobre `bigint` de centavos, sem biblioteca decimal (D-003).**
O domínio só faz `add`, `subtract` e `negate` — **nunca multiplica nem divide**. Não há política de arredondamento a decidir, que é justamente o problema que `decimal.js` e `big.js` resolvem. Inteiro é exato por construção e elimina a classe inteira de erro de configuração de precisão.

> Este é um desvio deliberado do esqueleto da §6.1 do enunciado, que mostra um campo `Decimal`. A justificativa: `Decimal` seria necessário se houvesse multiplicação. Não há. Toda a superfície pública continua sendo `MoneyProps { amount: string; currency: string }`, exatamente como o enunciado especifica.

Efeitos colaterais bons: `BigInt("25.00")` **lança**, então validar a entrada é obrigatório por construção em vez de por disciplina; `===` volta a comparar valor em vez de referência; e `JSON.stringify` lança em `bigint`, então um vazamento do tipo interno seria barulhento em vez de silencioso.

**Coluna `numeric(19,2)` + mapper explícito (D-004).**
Descartados `bigint` de centavos no banco e o Custom Type do MikroORM. `numeric` mantém a semântica monetária **visível no schema** — quem inspeciona o banco lê `25.00`, não `2500` precisando saber a escala de cabeça — e faz `CHECK (balance >= 0)` e o `SUM` da reconciliação saírem em SQL puro. O mapper é código nosso: mais fácil de testar e de defender, e reduz a superfície de API do MikroORM em jogo, o que importa porque D-001 assumiu esse ORM sem plano B.

A simetria é o ponto: o domínio guarda centavos (exato por construção), o banco guarda a forma legível (inspecionável e somável em SQL), e o mapper é o **único** ponto que conhece as duas representações.

**Escala de entrada exatamente 2 casas, `currency` validada por forma (D-015, D-016, D-017).**
`"25"` e `"25.5"` são rejeitados, assim como `"025.00"`. Não é rigor gratuito: garante **uma** representação textual por valor, sem o que `"25"` e `"25.00"` produziriam `payloadHash` diferentes para a mesma operação e gerariam `IDEMPOTENCY_CONFLICT` falso num reenvio legítimo. D-005 e D-015 se sustentam mutuamente. Pela mesma razão de canonicidade, `currency` exige `^[A-Z]{3}$`. As quatro operações binárias — incluindo `equals` — lançam entre moedas diferentes (D-017): comparar moedas distintas é erro de programação, não uma comparação que devolve `false`.

### 4.2 Concorrência

**Pessimistic locking por wallet — `SELECT ... FOR UPDATE` (D-002).**
Descartados optimistic com `version` + retry limitado, e `UPDATE ... WHERE balance >= :v` atômico.

A defesa cabe numa frase: *"o banco serializa por wallet; wallets diferentes não se veem"* — e esse era o critério de desempate do projeto. Além disso, RT-14 manda enviar a mesma aposta **50 vezes em paralelo sobre a mesma wallet**: contenção máxima, exatamente o regime em que optimistic degrada, o retry vira o caminho comum e o teste fica lento ou intermitente. O `UPDATE` condicionado seria o mais rápido dos três, mas migraria a regra de saldo do agregado para o SQL, enfraquecendo o encapsulamento que a área de Modelagem cobra.

A coluna `version` continua existindo e incrementando — RF-02 a exige — mas **não é o mecanismo de controle**; é estado observável do agregado. Por consequência, a métrica de "conflitos de lock" mede **espera por lock**, não falha de versão.

A aquisição do lock fica isolada num **único ponto** do repositório de wallet. Se aparecer um segundo lugar que trave wallet, a proibição de lock global estará sendo violada por dispersão em vez de por desenho — e isso é revisável no diff.

> **D-002 e D-009 parecem contraditórias e não são.** Uma escolhe pessimistic; a outra recusa segurar transação durante I/O. Coexistem porque a transação financeira **não contém I/O externo**: a publicação vai para a outbox. Vale apresentá-las juntas.

### 4.3 Idempotência

**`payloadHash`: SHA-256 sobre uma lista fechada de 10 campos (D-005).**
`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`. JSON canônico com chaves ordenadas. `undefined` é omitido; `null` é **rejeitado** como payload inválido.

A lista explícita é o que impede que um campo novo ou opcional mude o hash e produza conflito falso. Hashear o corpo inteiro seria mais simples de escrever, mas deixaria metadados de transporte entrarem no hash — precisamente o que o enunciado proíbe. **A lista é contrato:** alterá-la invalida todos os hashes já gravados.

`matchesPayload()` compara o hash **armazenado** e nunca recomputa a partir da entidade — recomputar reintroduziria a chance de divergência que a lista fechada eliminou.

**A `Idempotency-Key` não entra no hash.** É por isso que a mesma operação chega por HTTP (header) e por fila (campo em `data`) produzindo o mesmo hash, atendendo à exigência de que as duas bordas percorram o mesmo caminho.

**A inbox dedupa pelo `messageId` do corpo, não pelo id de transporte (D-044).** É o único dos dois que sobrevive a um reenvio do produtor. O `consumerName` é **constante no código** e não variável de ambiente (D-045): instâncias com valores divergentes não dariam erro — dariam efeito duplicado em silêncio.

**O saldo do replay é uma coluna (D-030).** `observed_balance` guarda o saldo que a operação original observou, porque um replay precisa responder o mesmo que a primeira execução respondeu — e não o saldo de agora, que já mudou.

### 4.4 Persistência

**MikroORM, sem plano B (D-001).**
O enunciado nomeia MikroORM como preferencial. Manter TypeORM como rota de fuga convidaria a abandonar a escolha no primeiro atrito, quando a maioria dos atritos previsíveis tem solução conhecida e barata. O risco assumido **não se materializou**: v7.1.14 conecta ao PostgreSQL 17 sob Bun 1.4.0 sem atrito, e um spike confirmou **no SQL efetivamente emitido** que `LockMode.PESSIMISTIC_WRITE` produz `SELECT ... FOR UPDATE` — descobrir isso na etapa de concorrência teria sido tarde demais.

**Modelos de linha + mapper, não mapeamento sobre as classes de domínio (D-026, D-027).**
As interfaces de repositório vivem no domínio; as implementações, na infraestrutura. O `EntitySchema` mapeia **modelos de linha** burros, e um mapper converte linha ↔ agregado. O domínio nunca é tocado pelo ORM.

**Comandos explícitos, não Unit of Work (D-028).**
Esta merece nota, porque D-001 citou o Unit of Work entre as razões de escolher o MikroORM — e o projeto **não o usa**. O que se usa dele é o `EntityManager` e o `transactional()`.

Dois motivos. Primeiro: com UoW, quem ordena os `INSERT` é o `CommitOrderCalculator`, que deriva a ordem das **relações declaradas** — e os modelos de linha não declaram nenhuma. A FK do ledger exige a wallet antes do lançamento; sem relação declarada, essa ordem viraria acidente, e o modo de falhar é um `23503` intermitente sob carga. Segundo, e mais importante: sem UoW não há identity map, e sem identity map **não existe caminho** em que um flush emita `UPDATE` sobre uma linha do ledger. Ter a trigger de D-023 **e** não ter como acioná-la é melhor que depender só da trigger.

A atomicidade de RF-23 não é afetada: ela vem do `em.transactional()`, que abre e fecha a transação do PostgreSQL. O flush do UoW é agrupamento de escrita, não a garantia.

### 4.5 Mensageria

**Outbox com claim por lease (D-009).**
`UPDATE ... SET locked_by, locked_until WHERE id IN (subselect com SKIP LOCKED) RETURNING *`, com **commit imediato do claim**. O publish acontece **fora** da transação; um segundo `UPDATE` marca `published_at` e limpa o par do lease (D-043).

Descartado o `SKIP LOCKED` simples com publish dentro da transação: um SQS lento seguraria conexões e poderia exaurir o pool. É a primeira crítica que um avaliador levanta, e ela não tem defesa boa. Descartado também o advisory lock por partição, que daria ordenação por agregado de graça mas fixa o número de partições no deploy.

**O custo aceito é entrega at-least-once**, e duas escritas por mensagem em vez de uma. Crash depois do publish e antes de marcar `published_at` faz o lease expirar e outra instância republicar. O enunciado assume isso explicitamente.

**As 10 tentativas limitam a curva, não a entrega (D-042).**
`OUTBOX_MAX_ATTEMPTS` é o teto do expoente do backoff e o limiar de alerta — **não** um ponto de desistência. Todo evento gravado na mesma transação SQL do dinheiro continua sendo reivindicado até sair, porque desistir dele quebraria a invariante de que toda transação aplicada tem evento.

**Backoff equal jitter, política injetada na chamada (D-022).**
Uma fórmula só, compartilhada pelos três laços, com números próprios para cada um: eles falham por motivos diferentes (SQS fora contra PostgreSQL fora) e nada obriga a mesma cadência. O jitter importa em cheio: sem ele, três instâncias varreriam as mesmas linhas no mesmo instante e disputariam locks à toa.

**Fila FIFO dedicada para eventos, provisionada de forma idempotente (D-040, D-041).**
O enunciado nomeia as filas de **entrada** e nenhuma de saída; `wagering-events.fifo` foi decisão nossa, com `MessageGroupId` = `aggregateId`. O LocalStack sobe vazio e ninguém tinha o encargo de criar as filas — o mesmo `ensureQueue` serve o worker, o consumidor e o preload de teste, para que nome e atributos não tenham duas fontes de verdade.

**Erro permanente vai à DLQ por envio explícito (D-046, D-048).**
Três destinos distintos conforme a natureza do erro: erro de negócio é resultado (não retenta), erro transitório volta à fila para o SQS reentregar, erro permanente vai à DLQ **na primeira entrega**, sem gastar as cinco tentativas. Numa fila FIFO isso importa: mensagem presa bloqueia o `MessageGroupId` inteiro e atrasa agregados sem relação nenhuma com o defeito. E erro de negócio que não deixaria rastro também vai à DLQ (D-048) — a classificação literal do requisito apagaria três erros de negócio sem ninguém saber que chegaram.

**Reversão fora de ordem: espera quem ainda pode, rejeita quem não pode mais (D-050).**
Um `ROLLBACK` que chega antes da `BET` de referência responde `202` e fica em `PENDING_REFERENCE`; um worker o reexamina até a referência chegar ou o TTL de 15 min esgotar, quando vira `REJECTED` com `REFERENCE_NOT_FOUND` e evento publicado. O TTL é expresso em **tempo**, não em contagem de tentativas: a pergunta de negócio é "quanto tempo esperamos a `BET` chegar", não "quantas vezes varremos".

### 4.6 Borda HTTP

**Cinco situações, cinco códigos (D-006).**
O critério do enunciado é que o provedor decida reenviar **sem ler texto de erro**. `400` payload inválido · `409` conflito de idempotência ou wallet duplicada · `422` rejeição de negócio com `failureCode` · `202` aceite pendente · `503` falha transitória. Os dois usos de `409` compartilham o mesmo eixo semântico — "este recurso já existe com outro conteúdo" — e por isso não colapsam situações distintas.

**Desfecho é resultado, não exceção (D-036, emenda a D-006).**
Um filtro de exceção único é dono dos **erros**; uma função pura ao lado dele é dona do **resultado**. Rejeição de negócio e pendência chegam à borda como valor de retorno, não como exceção lançada — porque não são erros: são desfechos legítimos que precisam de linha no banco e evento publicado. Nenhum controller decide status por conta própria.

**`503` por lista de SQLSTATE; o não mapeado é `500` (D-037).**
A lista é de códigos do PostgreSQL e não de classes do ORM, porque o conversor do MikroORM não produz `ConnectionException` — falha de conexão chega como `DriverException` base. Um erro não mapeado responde `500` deliberadamente: promovê-lo a `503` diria ao provedor "reenvie" sobre um defeito que reenviar não resolve.

**Parser artesanal, sem biblioteca de validação (D-038).**
A borda checa só **forma**; valor é do domínio. É onde um número JSON em `money.amount` morre antes de encostar em ponto flutuante, e onde o `null` que D-005 manda rejeitar é barrado. A fila usa as mesmas primitivas: entrada de fila é tão não confiável quanto a rede, e afrouxar ali porque "vem de dentro" daria ao produtor um caminho sem checagem para o mesmo banco.

**Taxonomia de 13 `failureCode` fechados (D-007, D-013).**
O código sozinho basta para o provedor decidir. A **ação esperada** é documentada aqui e não transmitida na resposta: transmiti-la denormalizaria o contrato, e numa adição futura código e ação poderiam divergir, entregando dois sinais conflitantes.

| `failureCode` | Situação | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | desistir ou reenviar após crédito |
| `INSUFFICIENT_FUNDS_ON_REVERSAL` | reversão produziria saldo negativo | **escalar** — é anomalia operacional |
| `REFERENCE_NOT_FOUND` | referência não resolvida após o TTL | corrigir ou desistir |
| `REFERENCE_MISMATCH` | referência diverge em provider/player/wallet/moeda/rodada | corrigir payload |
| `INVALID_REFERENCE_KIND` | `REFUND` sobre não-`BET`, `ROLLBACK` sobre kind não permitido | corrigir payload |
| `ALREADY_REVERSED` | referência já revertida pelo mesmo tipo | desistir |
| `AMOUNT_MISMATCH` | valor diferente do da referência | corrigir payload |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir payload |
| `IDEMPOTENCY_CONFLICT` | mesma key, payload diferente | corrigir payload |
| `WALLET_NOT_FOUND` | wallet inexistente | corrigir payload |
| `KIND_NOT_SUBMITTABLE` | `OPENING` submetido externamente | corrigir payload |
| `PERMANENT_INFRASTRUCTURE_ERROR` † | erro permanente identificado no processamento | escalar — não é problema de payload |
| `MAX_RETRIES_EXHAUSTED` † | mensagem esgotou tentativas e foi à DLQ | escalar; reenvio é seguro, mas exige diagnóstico |

† **Os dois códigos de infraestrutura não têm emissor hoje, e nenhuma transação chega ao status `FAILED`** (D-047, D-064). Não é esquecimento, e a razão tem duas metades.

A primeira é D-047: uma falha permanente no consumo faz **rollback da transação inteira** — E-07 insere a `WagerTransaction` já no estado terminal, então não sobra linha onde marcar `FAILED` —, e gravá-la numa segunda transação ocuparia a `idempotencyKey` da operação, fazendo o reenvio legítimo, depois de o defeito corrigido, responder replay de uma falha em vez de processar.

A segunda é o enunciado. D-047 previu que o emissor apareceria no worker de referências pendentes, ao esgotar o TTL; não apareceu, e não deve aparecer: a **§7.1 do enunciado** escreve, como critério de aceite, que o esgotamento do limite produz `REJECTED` com um `failureCode` que identifique a referência inexistente. D-007 já concordava por outro caminho, ao classificar `REFERENCE_NOT_FOUND` entre os 11 códigos de negócio — a referência que não chega em 15 minutos é desfecho da cadeia do provedor, não falha de infraestrutura nossa. D-064 registra a escolha e emenda a previsão de D-047.

O enum continua fechado em 13; dois deles estão **reservados**, e o compilador segue impedindo que um código de infraestrutura entre em `reject()`. Ver a limitação correspondente na §6.

> **Uma propriedade que cai de graça do desenho:** reenviar depois de `MAX_RETRIES_EXHAUSTED` **não duplica efeito**. Ou o commit nunca aconteceu — e nada foi aplicado — ou aconteceu e o `ack` falhou, caso em que a inbox deduplica na redelivery. Exigir diagnóstico antes do reenvio é orientação operacional, não requisito de segurança. Vale como propriedade do desenho mesmo com o código reservado: ela descreve o que acontece quando a mensagem volta, não o que a tabela de transações registra.

**Cursor keyset por UUIDv7 (D-014).**
Os ids de exemplo do próprio enunciado já são UUIDv7. Como o v7 é ordenável no tempo por construção, um índice de **coluna única** entrega ordem cronológica e ordem total ao mesmo tempo. O par `(created_at, id)` daria o mesmo resultado com índice composto, cursor maior e duas partes para validar — complexidade sem ganho. O cursor é base64url do id, opaco: o cliente repassa o `nextCursor` e nunca o constrói.

Consequência que extrapola a paginação: **os ids não têm `DEFAULT` no banco**. `gen_random_uuid()` é v4 e quebraria o cursor sem ninguém ver, então um id ausente vira `23502` em vez de virar um UUID errado.

### 4.7 Observabilidade

**`prom-client` em `GET /metrics` (D-010).**
Descartados contadores no log estruturado e OpenTelemetry. O critério foi demonstrabilidade: o avaliador vai rodar o projeto, e poder abrir uma URL e ver `outbox_lag_seconds` subindo enquanto o worker está parado vale mais, para os pontos em jogo, do que a métrica existir mas só ser observável por `grep`. OpenTelemetry sem coletor no Compose seria esforço sem demonstração.

**A lista de nomes é contrato de observabilidade:**

| Métrica | Tipo | Cobre |
|---|---|---|
| `wager_transactions_total{status,kind}` | counter | transações por status |
| `wager_duplicates_total{source}` | counter | replay idempotente (`http`) e dedup de inbox (`sqs`) |
| `wager_retries_total{loop}` | counter | `loop` = `sqs` \| `outbox` \| `pending_reference` |
| `wager_dlq_messages_total` | counter | mensagens em DLQ |
| `wallet_lock_wait_seconds` | histogram | **espera** por lock |
| `outbox_lag_seconds` | gauge | `now() - occurred_at` da mensagem pendente mais antiga |
| `wager_processing_seconds{source}` | histogram | latência, `source` = `http` \| `sqs` |
| `wallet_reconciliation_checks_total{consistent}` | counter | divergência de reconciliação |

Essa lista **só cresce por decisão registrada**, e não por um nome improvisado no meio de uma implementação — que é exatamente o que teria acontecido se a métrica de reconciliação tivesse sido batizada de improviso (D-060).

**Logger JSON próprio, com campos fechados em tipo (D-061).**
Não é escolha de estilo: é o mecanismo que faz a proibição de logar payload financeiro ser verificada **pelo compilador**. Quem acrescentar campo ao log precisa acrescentá-lo ao tipo `LogContext` — e é aí que a pergunta "isso é dado financeiro?" acontece, em vez de não acontecer. Redaction de biblioteca deixaria a proibição na memória de quem escreve.

**Instrumentação nas bordas e no repositório (D-062).**
O domínio e a aplicação não conhecem `prom-client`. A borda tem `kind` do comando e `status` do resultado; o repositório é o único lugar de onde a espera por lock é mensurável. O registry é singleton de módulo, porque contador é por processo — com N instâncias, quem agrega é o scraper.

**Um achado que virou regra:** `outbox_lag_seconds` é ligado no `AppModule`, não junto dos workers. O lag é estado do **banco**; ligá-lo pelo `WorkersModule` faria um processo só-HTTP expor `0`, que se lê como "outbox em dia" quando significa "ninguém mediu". Métrica que mente para o lado saudável é pior que métrica ausente.

**Dois health checks separados (RF-17).**
`live` não toca dependência nenhuma de propósito — um `live` que falha porque o banco caiu faz o orquestrador reiniciar um processo saudável. `ready` faz `select 1` real (o flag de conexão do ORM é preguiçoso e retorna `false` antes da primeira conexão, então não serve como readiness) e `ListQueues`, e responde `503` dizendo **qual** sonda falhou.

### 4.8 Processo e testes

**Um processo serve HTTP e roda os três laços (D-063).**
Os contadores do `prom-client` são por processo, então API e workers juntos fazem um `/metrics` cobrir as oito métricas. Separá-los é legítimo em produção — bastaria um segundo entrypoint montando só o `WorkersModule` —, e aí cada processo exporia o seu, com o scraper agregando. O que **não** funcionaria é worker sem `/metrics` nenhum.

**A aplicação não aplica migration ao subir.** Duas instâncias subindo juntas disputariam o `up`, e um `up` automático transforma deploy em migração silenciosa. É comando próprio.

**Infraestrutura de teste híbrida (D-011).**
Compose fixo para o loop de desenvolvimento; **Testcontainers** na suíte de integração e concorrência, de modo que `bun run check:full` se autoprovisione. Os dois públicos têm necessidades opostas: durante o desenvolvimento, subir container a cada suíte é custo repetido; para o avaliador, um comando único que provisiona tudo é a demonstração mais direta de que EL-08 não foi violada — e evita que a avaliação dependa de alguém lembrar de subir o Compose.

A mitigação obrigatória da duplicidade: a configuração de conexão vive num **único módulo** que lê do ambiente, e Compose e Testcontainers apenas populam esse ambiente. **Nenhum teste sabe qual dos dois está por trás** — se um teste precisasse saber, a mitigação teria falhado.

---

## 5. Autenticação — não implementada, por decisão (D-012)

O enunciado aceita explicitamente a não-implementação, desde que documentada com o desenho pretendido e um ponto de extensão explícito no código. **Foi o que se fez**, e por uma razão de alocação: auth vale **0 ponto** na tabela de avaliação, e as horas liberadas foram para as quatro áreas que somam 70 dos 100 pontos. A seção aparece antes de todo o resto no enunciado exatamente para o candidato dimensionar o timebox.

### O desenho que seria adotado

**IdP externo com OAuth 2.0 client credentials.** Cada provedor de jogos é um *client* registrado no IdP (Keycloak, Auth0 ou Cognito — a escolha não muda o desenho), recebe `client_id`/`client_secret` e troca por um access token JWT de vida curta. Nenhuma tabela de usuários e nenhum hash de senha entra neste serviço: o enunciado é explícito em que, havendo auth, ela é via IdP externo.

**Onde o guard entraria.** `AuthGuard` já está registrado e hoje é no-op. Ele passaria a:

1. ler o `Authorization: Bearer <jwt>`;
2. validar assinatura contra o **JWKS** do IdP, com cache das chaves e rotação por `kid`;
3. validar `iss`, `aud`, `exp` e o escopo exigido pela rota;
4. anexar as claims à requisição.

**Onde a identidade entraria.** `ProviderIdentityPort` já está no caminho de **toda** submissão, em `WageringTransactionsController`. Hoje devolve a identidade declarada sem verificar nada. A implementação real resolveria o `providerId` a partir da claim do token — e repare que o `providerId` **resolvido** é o que segue para o caso de uso, não o do corpo. Com auth de verdade, os dois podem divergir, e é o resolvido que vale. Essa assimetria já está implementada; só a resolução é que é no-op.

**O que mudaria no contrato da API:** `401` para token ausente, expirado ou inválido; `403` para token válido cujo `providerId` não confere com o do payload. Nenhum dos códigos atuais muda de significado, e nenhuma outra parte do caminho é tocada — que é o ponto de o ponto de extensão existir.

**Health e métricas continuariam abertos**, porque RF-17 os exige sem auth.

> **Não autenticar não relaxa regra de negócio.** A identidade do provedor contida na mensagem continua sujeita a todas as validações de domínio: uma reversão cujo `providerId` não bate com o da referência é rejeitada com `REFERENCE_MISMATCH` hoje, sem auth nenhuma.

---

## 6. Limitações conhecidas

Cortes e trade-offs assumidos conscientemente. Um corte documentado é engenharia; um corte silencioso é lacuna.

### Do modelo financeiro

- **A escala 2 é global.** Vive numa constante única (`SCALE_FACTOR = 100n`), e o enunciado fixa escala 2. Moedas de escala 0 (JPY) ou 3 (KWD) exigiriam uma tabela por moeda. O modelo continua multi-moeda no restante.
- **`currency` é validada por forma, não contra a ISO-4217.** `"XYZ"` passa. Uma tabela ISO daria validação real, mas o argumento de canonicidade que motiva a regra (D-016) já está atendido pela forma, e a lista traria manutenção sem ganho no prazo.
- **Não há conversão entre moedas** — fora de escopo pelo enunciado.
- **Reversão parcial de `REFUND`/`ROLLBACK` não é suportada** — fora de escopo pelo enunciado (§7.5). O índice único de reversão é total, sobre a referência inteira.

### Da concorrência

- **Throughput por wallet é serial por construção.** É o preço direto de D-002: uma hot wallet é o gargalo, e o pessimistic o torna explícito em vez de escondê-lo em retries. O enunciado não define meta de RPS. Se houvesse, o caminho seria particionar a wallet em sub-saldos — o que muda o modelo, não a estratégia de lock.
- **Não há teste de carga.** É diferencial opcional, e o núcleo tinha prioridade. Sem ele, não há número de throughput, p95 ou outbox lag sob carga para apresentar — só a garantia de correção sob contenção, que é o que os testes de concorrência provam.
- **A reconciliação segura o lock da wallet durante a varredura inteira do ledger** (D-057). `POST /wallets/:id/reconciliation` entra pelo mesmo `findByIdForUpdate` e só commita depois de dobrar o ledger em páginas de 500 — então uma wallet com histórico longo bloqueia o próprio caminho do dinheiro enquanto o relatório é montado, e a espera aparece em `wallet_lock_wait_seconds` para operações que nada têm a ver com a auditoria. É o custo que D-057 aceitou para não acusar divergência falsa em READ COMMITTED, e ele **não tem teto**: limitar a varredura mudaria o contrato de RF-16, que pede o saldo reconstruído do ledger inteiro — um relatório parcial rotulado como reconciliação é pior que um lento. Quem operar isso em produção agenda a chamada, em vez de expô-la no caminho quente.

### Da mensageria

- **Entrega é at-least-once, por desenho.** Crash entre o publish e a marcação de `published_at` republica. O enunciado assume isso, e o consumidor é idempotente pela inbox — mas quem consumir `wagering-events.fifo` precisa saber disso.
- **A outbox nunca desiste de um evento (D-042).** Uma falha *permanente* de publicação — fila apagada, credencial revogada — faz a linha ser reivindicada indefinidamente, com o backoff saturado em `OUTBOX_MAX_DELAY_MS`. É deliberado: desistir quebraria a invariante de que toda transação aplicada tem evento. O sinal operacional é `attempts` passando de `OUTBOX_MAX_ATTEMPTS` mais `outbox_lag_seconds` subindo, e não um alerta próprio.
- **Uma mensagem que vai à DLQ não deixa rastro na tabela de transações (D-047, D-064).** Quem investiga olha a DLQ e o log, não `GET /wagering/transactions/:id`: a falha permanente faz rollback e não sobra linha para marcar. É o motivo de `FAILED` não ter emissor e de os dois códigos de infraestrutura da §4.6 estarem reservados. O preço é uma consulta que responde `404` para uma operação que o provedor efetivamente enviou; a alternativa — gravar a falha numa segunda transação — custaria a `idempotencyKey` da operação e transformaria um incidente recuperável em perda definitiva, que é o pior dos dois.
- **Duas escritas por mensagem** em vez de uma, em troca de não bloquear conexão durante I/O (D-009).
- **A ordem cronológica do ledger fica implícita no formato do id** (D-014). Se o padrão de id mudasse, a paginação quebraria em silêncio. Trade-off aceito em troca do índice de coluna única.

### Da operação

- **Contadores são por processo.** Com múltiplas instâncias, quem agrega é o scraper Prometheus. Isso está correto e não deve ser "consertado" guardando contador no banco — seria estado compartilhado inventado, com custo de escrita no caminho quente.
- **`outbox_lag_seconds` consulta o banco a cada scrape.** É a única métrica que não é incrementada no caminho quente, e a que mais diz sobre a saúde do sistema. Um scrape muito frequente adiciona uma query por intervalo.
- **`GET /health/ready` verifica que o SQS está alcançável (`ListQueues`), não que a fila específica existe.** Exigir a fila faria um processo só-HTTP se declarar indisponível por não ter provisionado uma fila que não é dele.
- **O encerramento ordenado custa, no pior caso, o `waitTimeSec` do consumidor** (20 s por default). Não é lentidão: é o `stop()` esperando o `ReceiveMessage` em voo, como o requisito de shutdown manda.
- **Não há OpenTelemetry nem dashboard** — diferenciais opcionais, fora do núcleo.

### Da suíte de testes

- **A metade "ordenada" do shutdown é provada por `close()`, não por sinal do SO.** O Windows não entrega `SIGTERM` a processo nativo, então `enableShutdownHooks()` ligando o sinal ao `onApplicationShutdown` é a metade que fica com o container. A outra metade — o processo que **não** encerra coisa nenhuma — é provada com `SIGKILL` de verdade em [`tests/concurrency/service-restart.test.ts`](tests/concurrency/service-restart.test.ts).
- **`check:full` exige Docker.** Sem ele, resta `bun run check`, que cobre typecheck, lint e a suíte de unidade.
- **O LocalStack está preso a `4.14.0`**, o último release community. A linha 2026.x exige token de licença e encerra com exit 55 — restrição de ambiente, não preferência.
- **Duas infraestruturas de teste para manter** (Compose e Testcontainers), mitigadas por um módulo único de configuração que ambos populam.
- **A lista de colunas de cada `UPDATE` é escrita à mão** (D-028). Mais verboso que um `flush()`, e uma coluna esquecida não é apontada pelo compilador. A contrapartida é o teste de round-trip, que compara o agregado ida e volta campo a campo.

### De escopo

- **Autenticação não implementada** (§5 acima). Vale 0 ponto por decisão do próprio enunciado.
- **Sem ledger de partidas dobradas** (*double-entry*) — diferencial opcional.
- **Sem frontend, sem OpenAPI gerado.** As rotas estão documentadas no [README](README.md).

---

## 7. Rastreabilidade dos testes obrigatórios

Os 21 testes que o enunciado exige, e onde cada um vive.

### Unidade

| # | Cobertura | Arquivo |
|---|---|---|
| RT-01 | `Money`: escala, entradas inválidas | [`tests/unit/money.test.ts`](tests/unit/money.test.ts) |
| RT-02 | Invariantes da `Wallet` | [`tests/unit/wallet.test.ts`](tests/unit/wallet.test.ts) |
| RT-03 | Regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK` | [`tests/unit/wager-transaction.test.ts`](tests/unit/wager-transaction.test.ts) · [`tests/integration/process-wager-transaction.test.ts`](tests/integration/process-wager-transaction.test.ts) |
| RT-04 | Conflito de moeda | [`tests/unit/wallet.test.ts`](tests/unit/wallet.test.ts) · [`tests/unit/money.test.ts`](tests/unit/money.test.ts) · [`tests/integration/http-write-api.test.ts`](tests/integration/http-write-api.test.ts) |
| RT-05 | Idempotency key com payload divergente | [`tests/integration/http-write-api.test.ts`](tests/integration/http-write-api.test.ts) |
| RT-06 | `isBalanced()` e recusa de lançamento inválido | [`tests/unit/wallet-ledger-entry.test.ts`](tests/unit/wallet-ledger-entry.test.ts) |
| RT-07 | Terminal não transiciona | [`tests/unit/wager-transaction.test.ts`](tests/unit/wager-transaction.test.ts) |

### Integração — PostgreSQL e LocalStack reais

| # | Cobertura | Arquivo |
|---|---|---|
| RT-08 | Migrations e constraints, `up`/`down` | [`tests/integration/schema-constraints.test.ts`](tests/integration/schema-constraints.test.ts) |
| RT-09 | Atomicidade entre wallet, ledger, inbox e outbox | [`tests/integration/process-wager-transaction.test.ts`](tests/integration/process-wager-transaction.test.ts) |
| RT-10 | Inbox e redelivery | [`tests/integration/sqs-wager-consumer.test.ts`](tests/integration/sqs-wager-consumer.test.ts) |
| RT-11 | Publishers concorrentes sobre a mesma outbox | [`tests/integration/outbox-publisher.test.ts`](tests/integration/outbox-publisher.test.ts) |
| RT-12 | Retry e DLQ | [`tests/integration/sqs-wager-consumer.test.ts`](tests/integration/sqs-wager-consumer.test.ts) |
| RT-13 | Recuperação após reinicialização | [`tests/integration/recovery-after-restart.test.ts`](tests/integration/recovery-after-restart.test.ts) |

### Concorrência — paralelismo real

| # | Cenário | Arquivo |
|---|---|---|
| RT-14 | Mesma aposta **50× em paralelo** → um único débito | [`tests/concurrency/same-wallet-contention.test.ts`](tests/concurrency/same-wallet-contention.test.ts) |
| RT-15 | Cenário obrigatório da §8: `100.00`, duas apostas de `80.00` | [`tests/concurrency/same-wallet-contention.test.ts`](tests/concurrency/same-wallet-contention.test.ts) |
| RT-16 | Wallets distintas em paralelo | [`tests/concurrency/distinct-wallets.test.ts`](tests/concurrency/distinct-wallets.test.ts) |
| RT-17 | **≥ 3 processos** simultâneos | [`tests/concurrency/multi-instance.test.ts`](tests/concurrency/multi-instance.test.ts) |
| RT-18 | Worker morto **depois do commit, antes do ack** | [`tests/concurrency/consumer-crash-before-ack.test.ts`](tests/concurrency/consumer-crash-before-ack.test.ts) |
| RT-19 | Dois publishers sobre a mesma outbox | [`tests/concurrency/outbox-publishers.test.ts`](tests/concurrency/outbox-publishers.test.ts) |
| RT-20 | `ROLLBACK`/`REFUND` entregue **antes** da referência | [`tests/integration/pending-reference-worker.test.ts`](tests/integration/pending-reference-worker.test.ts) |
| RT-21 | Reinício do serviço com consistência final | [`tests/concurrency/service-restart.test.ts`](tests/concurrency/service-restart.test.ts) |

Os testes de concorrência sobem **processos de sistema operacional** de verdade — três instâncias do `AppModule` disputando a mesma wallet em RT-17, um serviço morto com `SIGKILL` no meio de 20 apostas em RT-21 — e não chamadas paralelas ao mesmo caso de uso no mesmo processo. A diferença importa: a exigência é "correta com múltiplas **instâncias da aplicação**", e paralelismo dentro de um processo não a prova.

---

## 8. Onde ler mais

| Documento | Conteúdo |
|---|---|
| [README.md](README.md) | setup do zero, comandos, superfície HTTP e de mensageria |
| [docs/decisions.md](docs/decisions.md) | as 64 decisões por extenso, com alternativas descartadas |
| [docs/requirements.md](docs/requirements.md) | requisitos numerados e critérios de aceite |
| [docs/desafio-original.md](docs/desafio-original.md) | enunciado íntegro — fonte da verdade final |
| [docs/implementation-plan.md](docs/implementation-plan.md) | roteiro e o que cada etapa deixou para a seguinte |
