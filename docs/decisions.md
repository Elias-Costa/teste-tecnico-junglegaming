# Registro de Decisões

Registro leve de decisões, estilo ADR. Neste projeto ele tem **três** funções:

1. **Histórico** — toda decisão que o enunciado delega ao candidato fica registrada aqui, com a alternativa rejeitada e o porquê.
2. **Fila de decisões em aberto** — itens que precisam de resposta do mantenedor **antes** de virar código. O agente consulta esta fila antes de perguntar qualquer coisa.
3. **Rascunho do `ARCHITECTURE.md`** — o entregável avaliado (5 pts) e o roteiro da apresentação oral são a curadoria deste arquivo. Ele é escrito **incrementalmente, à medida que as decisões acontecem**, não no fim do dia 3.

> **Regra:** nenhuma decisão desta fila é resolvida pelo agente. Ver `AGENTS.md` §0.

## Formato

```markdown
## D-NNN — Título curto (AAAA-MM-DD)
**Status:** EM ABERTO | DECIDIDA
**Contexto:** por que a decisão foi necessária; o que o enunciado exige.
**Opções:** alternativas razoáveis, com o trade-off de cada uma.
**Decisão:** o que foi decidido pelo mantenedor.
**Justificativa:** por que essa e não a outra — esta linha é o que vai ser dito na apresentação.
**Consequências:** o que muda no código; quais requisitos/documentos foram afetados.
```

---

## Fila de decisões em aberto

**Um item, que só bloqueia E-13.**

- **Dono de `reference_attempts` e `next_reference_attempt_at`** — aberto por **D-029**. As duas colunas existem no schema desde E-05 e não têm dono no domínio. E-13 escolhe entre levá-las ao agregado (um `scheduleReferenceRetry(now, policy)` reusando o `RetryPolicy` de D-022) ou tratá-las como estado operacional manipulado por `UPDATE` direto, como o lease da outbox em E-10. **Nada até E-12 depende disso:** por D-029, o repositório de E-06 simplesmente não escreve essas colunas, e nenhuma das duas saídas fica mais cara por causa disso.

As 15 decisões que o enunciado delegava ao candidato foram fechadas em 2026-09-01, antes de existir código de produção. A elas se somam **D-016** e **D-017** — expostas por E-02 e resolvidas antes de o `Money` ser escrito —, **D-018** a **D-021**, expostas por E-03 e resolvidas antes de as entidades serem escritas, **D-022**, exposta por E-04 e resolvida antes de o `scheduleRetry` ser escrito, **D-023** a **D-025**, expostas por E-05 e resolvidas antes de a migration ser escrita, **D-026** a **D-029**, expostas por E-06 e resolvidas antes de o mapeamento ser escrito, **D-030** a **D-032**, expostas por E-07 e resolvidas antes de o use case ser escrito, e **D-033** a **D-039**, expostas por E-08 e resolvidas antes de a borda HTTP ser escrita. **Nenhuma etapa até E-12 está bloqueada.**

A fila continua valendo daqui em diante: se a implementação expuser uma decisão não prevista — como aconteceu com D-015 (escala de entrada) e com os códigos de infraestrutura de D-007, ambos descobertos ao detalhar outra decisão; como voltou a acontecer em E-02 com a validação de `currency` (D-016) e o comportamento de `equals` (D-017); como aconteceu em E-03, onde D-018 estava **delegada em texto pelo próprio enunciado** ("assinatura e retorno são decisão sua", §6.2) e D-020 e D-021 apareceram como conflitos entre dois requisitos que só se manifestam ao escrever a validação; como aconteceu em E-04, onde D-008 fixava os limites do backoff mas não a forma da curva (D-022); e como aconteceu em E-05, onde o próprio escopo da etapa registrava duas vias sem escolher entre elas (D-023) e onde **dois documentos já registrados divergiam** sobre a chave da inbox (D-025); e como aconteceu em E-06, onde a rejeição do Custom Type em D-004 já implicava a forma do mapeamento sem que ninguém a tivesse registrado (D-026); e como aconteceu em E-07, onde RN-12 pedia um saldo que **nenhuma coluna guardava** (D-030) e onde **D-007 e o schema de E-05 se contradiziam** sobre `WALLET_NOT_FOUND` (D-031); e como voltou a acontecer em E-08, a etapa que mais expôs decisões de uma vez — **sete** —, incluindo o caso em que **o schema de E-05 tornava impossível** a transação interna que RF-08 exige, por seis colunas NOT NULL sem valor natural na abertura (D-033), e o caso em que **a própria consequência de D-006 não cobria o caminho normal** que E-07 acabara de produzir (D-036) — ela entra aqui e **para a etapa**, conforme `AGENTS.md` §0. Fila curta não significa que não vão surgir mais.

---

## Decisões registradas

## D-010 — Métricas: `prom-client` em `GET /metrics` (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RNF-07 exige, no mínimo: transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, **outbox lag** e latência de processamento. Vale 5 pontos na área de Observabilidade. Descartadas: contadores emitidos no log estruturado, e OpenTelemetry.

**Decisão:** **`prom-client@15.1.3`** expondo `GET /metrics` no formato Prometheus, junto das métricas padrão de processo.

**Justificativa:** o avaliador vai rodar o projeto. Poder abrir uma URL e ver `outbox_lag_seconds` subindo enquanto o worker está parado vale mais, para 5 pontos, do que a métrica existir mas só ser observável por `grep` no log. OpenTelemetry é citado pelo enunciado como diferencial opcional, mas sem um coletor no Compose o avaliador não veria nada — seria esforço sem demonstração, competindo com as áreas que somam 70 pontos.

**Métricas e tipos** — a nomenclatura fecha aqui para não ser improvisada em E-15:

| Métrica | Tipo | Cobre |
|---|---|---|
| `wager_transactions_total{status,kind}` | counter | transações por status |
| `wager_duplicates_total{source}` | counter | replay idempotente (`http`) e dedup de inbox (`sqs`) |
| `wager_retries_total{loop}` | counter | `loop` = `sqs` \| `outbox` \| `pending_reference` |
| `wager_dlq_messages_total` | counter | mensagens em DLQ |
| `wallet_lock_wait_seconds` | histogram | conflitos de lock — **espera por lock**, por D-002 |
| `outbox_lag_seconds` | gauge | `now() - occurred_at` da mensagem pendente mais antiga |
| `wager_processing_seconds{source}` | histogram | latência, com `source` = `http` \| `sqs` |

**Consequências:**
- `outbox_lag_seconds` precisa de um **collect callback** que consulta o banco a cada scrape. É a única métrica que não é incrementada no caminho quente, e é a que mais diz sobre a saúde do sistema.
- `wallet_lock_wait_seconds` mede espera, não falha de versão — coerência exigida por D-002, onde `version` deixou de ser o mecanismo de controle.
- **Os contadores são por processo, e isso está correto.** Com três ou mais instâncias (RI-08), quem agrega é o scraper. Ninguém deve "consertar" isso guardando contador no banco: seria estado compartilhado inventado, com custo de escrita no caminho quente e sem ganho.
- `/metrics` fica aberto, como os endpoints de health (RF-17). Coerente com D-012, que não implementa autenticação.
- `ARCHITECTURE.md` registra a tabela acima; a lista de nomes é contrato de observabilidade.

---

## D-002 — Concorrência da wallet: pessimistic `FOR UPDATE` (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RNF-01..RNF-05. A unidade de concorrência é a `walletId`; lock global é proibido (RI-06); `read → calculate → update` sem controle é eliminatório (RI-07, EL-02). Sustenta 20 pontos e duas eliminatórias. O spike E-00 confirmou que `LockMode.PESSIMISTIC_WRITE` emite `SELECT ... FOR UPDATE` de fato, então as três alternativas eram tecnicamente viáveis. Descartadas: optimistic com `version` + retry limitado, e `UPDATE ... WHERE balance >= :v` atômico.

**Decisão:** **pessimistic locking por wallet.** `findOne` com `LockMode.PESSIMISTIC_WRITE` dentro de `em.transactional()`. A coluna `version` continua sendo mantida e incrementada porque RF-02 a exige, mas **não é o mecanismo de controle** — é estado observável do agregado.

**Justificativa:** *"o banco serializa por wallet; wallets diferentes não se veem"* — a defesa cabe em uma frase, que é o critério adotado neste projeto para escolher entre soluções igualmente corretas. Além disso, RT-14 manda enviar a mesma aposta **50 vezes em paralelo sobre a mesma wallet**: isso é contenção máxima, exatamente o regime em que optimistic degrada, o retry vira o caminho comum e o teste fica lento ou intermitente. O `UPDATE` condicionado seria o mais rápido dos três, mas migraria a regra de saldo do agregado para o SQL, enfraquecendo o encapsulamento que RF-02 e a área de Modelagem cobram.

**Consequências:**
- A aquisição do lock fica **isolada num único ponto** do repositório de wallet. Se aparecer um segundo lugar que trave wallet, RI-06 está sendo violado por dispersão, não por desenho.
- A transação de E-07 é curta e **não contém I/O externo**: a publicação vai para a outbox, não para o SQS (RI-04). É isso que torna o pessimistic seguro aqui — a crítica de "segurar conexão durante chamada de rede" que derrubou a alternativa simples em D-009 **não se aplica**, porque não há I/O dentro do lock. Vale apresentar as duas decisões juntas: elas parecem contraditórias e não são.
- Wallets distintas não compartilham lock — RT-16 prova.
- Contenção em hot wallet é limitação conhecida para `ARCHITECTURE.md`: o throughput por wallet é serial por construção. É o preço da correção, e o enunciado não define meta de RPS.
- A métrica "conflitos de lock" (RNF-07) passa a medir **espera por lock**, não falha de versão.

---

## D-005 — `payloadHash`: SHA-256 sobre lista fechada (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RF-14. O enunciado exige JSON canônico com chaves ordenadas, exclui header e metadados de transporte, e exige o algoritmo documentado. Descartadas: hash do corpo inteiro canonicalizado, e lista fechada com coluna de versão do algoritmo.

**Decisão:** **SHA-256** sobre JSON canônico (chaves ordenadas, UTF-8) da lista fechada:

`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`.

`undefined` é omitido; `null` é rejeitado como payload inválido. `money.amount` já chega normalizado por D-015.

**Justificativa:** a lista explícita é o que impede que um campo novo ou opcional mude o hash e produza `IDEMPOTENCY_CONFLICT` falso num reenvio legítimo. Hashear o corpo inteiro seria mais simples de escrever, mas deixaria metadados de transporte entrarem no hash — precisamente o que §9 proíbe. O versionamento do algoritmo resolveria uma evolução de contrato que não acontece em 3 dias.

**Consequências:**
- **A lista é contrato.** Alterá-la invalida todos os hashes já gravados; qualquer mudança futura vira entrada nova aqui.
- Depende de D-015: sem escala textual única, `"25"` e `"25.00"` produziriam hashes diferentes para o mesmo valor. As duas decisões se sustentam mutuamente e devem ser apresentadas juntas.
- `matchesPayload()` (RF-03) compara o hash **armazenado**, nunca recomputa a partir da entidade — recomputar reintroduziria a chance de divergência que a lista fechada eliminou.
- A canonicalização é testada isoladamente: a mesma entrada com chaves em ordem diferente produz o mesmo hash.

---

## D-006 — Mapa de status HTTP: 400/409/422/202/503 (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RF-15. A §9 exige distinguir cinco situações com clareza e de forma consistente entre todos os endpoints, e afirma que colapsá-las obriga o provedor a interpretar mensagem de erro para decidir se pode reenviar. Descartadas: 200 com `status` no corpo para rejeição de negócio, e 202 para toda submissão aceita.

**Decisão:**

| Situação | Código |
|---|---|
| Payload inválido, `Idempotency-Key` ausente, escala errada (D-015) | `400` |
| Conflito de idempotência — mesma key, payload diferente (RN-14) | `409` |
| Wallet duplicada para `playerId` + `currency` (RF-08) | `409` |
| Rejeição por regra de negócio, com `failureCode` no corpo | `422` |
| Aceite com processamento pendente — `PENDING_REFERENCE` (RN-15) | `202` |
| Falha transitória de infraestrutura | `503` |

**Justificativa:** cada uma das cinco situações tem código próprio, e o provedor decide reenviar sem ler texto — que é o teste que a §9 propõe. Responder 200 com o resultado no corpo faria com que quem olha apenas o status HTTP não distinguisse aceite de rejeição. Responder 202 sempre contradiz o exemplo da própria §9, que mostra resposta síncrona com `status: PROCESSED` e `balance` já atualizado.

**Consequências:**
- O mapeamento vive num **filtro de exceção único**, aplicado a todos os endpoints. Endpoint que trate erro localmente quebra a consistência que a §9 cobra explicitamente. **Emendado por D-036:** o filtro é dono das exceções, e uma função pura ao lado dele é dona do resultado — rejeição de negócio e pendência chegam à borda como valor de retorno, não como exceção. Os dois pontos vivem no mesmo arquivo, e nenhum controller decide status por conta própria.
- `422` sempre carrega um `failureCode` de D-007; `503` nunca carrega, porque não é decisão de negócio.
- Os dois usos de `409` compartilham o mesmo eixo semântico — "este recurso já existe com outro conteúdo" — e por isso não colapsam situações distintas.
- O teste de E-08 exercita as cinco situações e confere cinco códigos distintos.

---

## D-008 — Retries, TTL, backoff e lease: defaults conservadores e configuráveis (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RF-21 (DLQ), RF-26 (`PENDING_REFERENCE`), RF-06 (`scheduleRetry`) e a duração do lease acrescentada por D-009. O enunciado exige limites **definidos e justificados**. Descartadas: constantes fixas, e defaults agressivos fixos.

**Decisão:** backoff exponencial **com jitter** nos três loops, com os defaults abaixo, todos sobrescrevíveis por variável de ambiente:

| Parâmetro | Default | Origem |
|---|---|---|
| TTL de `PENDING_REFERENCE` | 15 min | RF-26 |
| `maxReceiveCount` do SQS, alinhado à redrive policy | 5 | RF-21 |
| Tentativas de publicação da outbox | 10, teto de backoff 5 min | RF-24 |
| Duração do lease da outbox | 30 s | D-009 |

**Justificativa:** o TTL de `PENDING_REFERENCE` é expresso **em tempo, não em contagem de tentativas**, porque a pergunta de negócio é "quanto tempo esperamos a `BET` chegar depois do `ROLLBACK`", não "quantas vezes tentamos". O `maxReceiveCount` do SQS é alinhado ao limite da aplicação para não existirem duas verdades sobre quando a mensagem vai para a DLQ.

A parametrização não é conveniência: RT-20 (referência fora de ordem) e RT-12 (DLQ) esperariam minutos com constantes fixas, ou exigiriam relógio falso — e o enunciado cobra paralelismo real, não mocks. Com os valores injetáveis, os testes usam milissegundos **sem trocar o mecanismo por um substituto**. Defaults agressivos fixos resolveriam o tempo de suíte, mas numa avaliação em máquina lenta produziriam DLQ prematura e republicação, que o avaliador leria como instabilidade do sistema.

**Consequências:**
- Um módulo único de configuração de retry, lido do ambiente com os defaults acima — mesmo padrão do módulo de conexão de D-011.
- O `.env.example` documenta os quatro parâmetros.
- `ARCHITECTURE.md` registra os números **e** o raciocínio: o enunciado pede o limite justificado, não apenas declarado.
- Jitter é obrigatório nos três loops. Sem ele, múltiplas instâncias sincronizam tentativas e criam picos — e a solução precisa estar correta com três ou mais instâncias (RI-08).

---

## D-009 — Publicação da outbox: claim com lease (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RF-24 exige múltiplos publishers concorrentes sem perder nem duplicar indefinidamente, e nomeia o cenário obrigatório: commit → o processo morre antes de publicar → outra instância assume → o evento é publicado → publicação duplicada continua segura. Alternativas descartadas: `FOR UPDATE SKIP LOCKED` com publish dentro da transação, e advisory lock por partição do `aggregateId`.

**Decisão:** **claim com lease.** `UPDATE outbox SET locked_by = :instancia, locked_until = now() + :lease WHERE id IN (subselect com `SKIP LOCKED`) RETURNING *`, com **commit imediato do claim**. O publish acontece **fora** da transação, e um segundo `UPDATE` marca `published_at`.

**Justificativa:** o publisher nunca segura uma transação de banco aberta durante uma chamada de rede ao SQS. Com `SKIP LOCKED` simples, um SQS lento seguraria conexões e poderia exaurir o pool — é a primeira crítica que um avaliador da área levanta, e ela não tem defesa boa. O advisory lock por partição daria ordenação por agregado de graça, mas fixa o número de partições no deploy e um publisher lento travaria a partição inteira.

O custo aceito é entrega **at-least-once**: crash depois do publish e antes de marcar `published_at` faz o lease expirar e outra instância republicar. O próprio enunciado assume isso ("uma publicação duplicada continua segura para o consumidor").

**Consequências:**
- Outbox ganha `locked_by` e `locked_until`, além de `attempts`, `next_attempt_at` e `published_at` já previstos em RF-06.
- Índice parcial `WHERE published_at IS NULL` sobre `(next_attempt_at, locked_until)` — a varredura do worker é o caminho quente.
- **A duração do lease vira parâmetro de D-008.** Curto demais republica sem necessidade; longo demais atrasa a retomada após crash.
- RT-19 (dois publishers sobre a mesma outbox) ganha um segundo caso: **lease expirado é reivindicado por outra instância**. Sem esse teste, o cenário obrigatório de RF-24 não está provado.
- Duas escritas por mensagem em vez de uma. Registrar em `ARCHITECTURE.md` como custo assumido em troca de não bloquear conexão durante I/O.

---

## D-014 — Cursor do ledger: keyset por id UUIDv7 (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RF-10 exige cursor **estável e opaco**, com ordenação total e determinística sob inserção concorrente. Observação que decidiu: os ids de exemplo do próprio enunciado já são UUIDv7 — em `0192f291-27dd-7d3f-8071-5f8685deef37`, o terceiro grupo começa com `7`, que é o nibble de versão.

**Decisão:** ids em **UUIDv7** e cursor = **base64url do id**. Keyset de coluna única.

**Justificativa:** UUIDv7 é ordenável no tempo por construção, então um índice de coluna única entrega ordem cronológica **e** ordem total ao mesmo tempo. O par `(created_at, id)` daria o mesmo resultado com índice composto, cursor maior e duas partes para validar na decodificação — complexidade sem ganho. O cursor versionado resolveria um problema de evolução de contrato que ninguém vai exercer durante a avaliação.

**Consequências:**
- **UUIDv7 passa a ser o padrão de id em todas as tabelas**, não só no ledger. Esta decisão extrapola RF-10 e precisa valer em E-05 inteira. **Alcance corrigido por D-025:** vale para as tabelas com id sintético; `inbox_messages` tem chave primária composta e é a única exceção.
- **Resolvido no spike E-00: `Bun.randomUUIDv7()` é nativo.** Nenhuma biblioteca de UUID entra no projeto. `crypto.randomUUID()` continua gerando v4 e **não deve ser usado** para id de entidade — a ordenação do cursor de RF-10 depende do v7.
- Índice `(wallet_id, id)` no ledger, que é o acesso de RF-10.
- O cursor é validado na decodificação: precisa resultar em UUID bem formado antes de entrar na query.
- **Limitação conhecida para `ARCHITECTURE.md`:** a ordem cronológica fica implícita no formato do id em vez de explícita numa coluna. Se o padrão de id mudasse, a paginação quebraria em silêncio. É o trade-off aceito em troca do índice de coluna única.

---

## D-007 — Taxonomia de `failureCode`: 11 códigos fechados (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RN-17 / §7.2 — cada código precisa ser estável, legível por máquina e suficiente para o provedor decidir entre reenviar, corrigir o payload ou desistir. RN-16 exige que "sem saldo para apostar" e "sem saldo para reverter" sejam códigos **distintos**. Alternativas descartadas: transmitir um campo `action` junto à resposta, e enxugar para ~5 códigos genéricos.

**Decisão:** lista **fechada** de 11 códigos, com a ação esperada do provedor **documentada** em `ARCHITECTURE.md` — documentada, não transmitida.

| `failureCode` | Situação | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | desistir ou reenviar após crédito |
| `INSUFFICIENT_FUNDS_ON_REVERSAL` | reversão que produziria saldo negativo (RN-16) | escalar — é anomalia operacional |
| `REFERENCE_NOT_FOUND` | referência não resolvida após esgotar o TTL (RF-26) | corrigir ou desistir |
| `REFERENCE_MISMATCH` | referência existe mas diverge em provider/player/wallet/moeda/rodada (RN-07) | corrigir payload |
| `INVALID_REFERENCE_KIND` | `REFUND` sobre não-`BET`, `ROLLBACK` sobre kind não permitido (RN-08) | corrigir payload |
| `ALREADY_REVERSED` | referência já revertida pelo mesmo tipo (RN-09) | desistir |
| `AMOUNT_MISMATCH` | valor diferente do da referência (RN-10) | corrigir payload |
| `CURRENCY_MISMATCH` | moeda diferente da wallet (RF-02) | corrigir payload |
| `IDEMPOTENCY_CONFLICT` | mesma key, payload diferente (RN-14) | corrigir payload |
| `WALLET_NOT_FOUND` | wallet inexistente | corrigir payload |
| `KIND_NOT_SUBMITTABLE` | `OPENING` submetido externamente (RN-13) | corrigir payload |

**Justificativa:** o código sozinho já basta para a decisão do provedor, que é exatamente o que §7.2 pede. Transmitir a ação junto denormalizaria o contrato: numa adição futura, código e ação poderiam divergir e o provedor receberia dois sinais conflitantes. Enxugar teria teto — RN-16 exige distinguir os dois casos de saldo insuficiente, e agrupar os erros de referência tiraria do provedor a decisão entre "corrigir payload" e "desistir".

**Consequências:**
- Enum fechado no domínio. Adicionar código passa a ser mudança de contrato, registrada aqui.
- Cada código ganha um teste que prova que a situação correspondente o produz (parte de RT-03).
- **Códigos de infraestrutura aprovados** (2026-09-01), para o status `FAILED` de D-013. A lacuna existia porque os 11 códigos acima são todos de rejeição por regra de negócio, e `fail(code)` exige um `FailureCode`. Com eles, o enum fica **fechado em 13** e E-03 está desbloqueada.

| `failureCode` | Situação | Ação do provedor |
|---|---|---|
| `PERMANENT_INFRASTRUCTURE_ERROR` | erro permanente de infraestrutura identificado no processamento | escalar — não é problema de payload |
| `MAX_RETRIES_EXHAUSTED` | mensagem esgotou as tentativas e foi para a DLQ (RF-21) | escalar; reenvio é seguro, mas exige diagnóstico antes |

**Nota de coerência com a inbox:** reenviar após `MAX_RETRIES_EXHAUSTED` **não** duplica efeito. Ou o commit nunca aconteceu — e nada foi aplicado — ou aconteceu e o `ack` falhou, caso em que a inbox deduplica na redelivery (RF-19, RF-20). Exigir diagnóstico antes do reenvio é orientação operacional, não requisito de segurança. Vale registrar no `ARCHITECTURE.md`: é uma propriedade que cai de graça do desenho, e é bom material de apresentação.

---

## D-013 — Grafo de transições e semântica de `FAILED` (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RF-03. O enunciado manda definir e documentar as transições válidas, e diz que transicionar a partir de um terminal é erro de programação, não caminho de negócio. Duas perguntas estavam abertas: se o reagendamento de `PENDING_REFERENCE` conta como transição, e quem escreve `FAILED`.

**Decisão — grafo fechado:**

```
PENDING            → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE  → PROCESSED | REJECTED | FAILED
PROCESSED          → (terminal)
REJECTED           → (terminal)
FAILED             → (terminal)
```

**Sem self-loop e sem volta para `PENDING`.** O contador de tentativas de referência vive em colunas próprias (`reference_attempts`, `next_reference_attempt_at`), espelhando o padrão que a outbox já adota em RF-06.

**Decisão — `FAILED`:** escrito quando um erro **permanente** de infraestrutura é identificado no processamento, ou quando a mensagem esgota as tentativas e vai para a DLQ (RF-21). Erro **transitório nunca** marca `FAILED`: não toca o status e devolve a mensagem para retry.

**Justificativa:** status é estado de negócio; retry é dado operacional. Misturar os dois codificaria um contador dentro do grafo e tornaria a regra "terminal não transiciona" mais difícil de testar de forma limpa. Sobre `FAILED`: marcar como terminal qualquer erro não-negocial queimaria transações durante uma indisponibilidade momentânea do Postgres — exatamente o cenário de recuperação que a §3 do enunciado exige que funcione.

**Consequências:**
- `markPendingReference()` é válida **apenas** a partir de `PENDING`. Chamá-la sobre uma transação já em `PENDING_REFERENCE` lança `InvalidTransactionStateError`; o reagendamento é `UPDATE` nas colunas de tentativa, não transição. Vira caso explícito de RT-07.
- Uma transação pode permanecer em `PENDING` entre tentativas transitórias. Isso é esperado e **não** é estado preso — quem encerra o ciclo é a DLQ.
- E-05 ganha as colunas `reference_attempts` e `next_reference_attempt_at` na tabela de transações.
- `FAILED` exige um `failureCode` de infraestrutura, e a lacuna está sinalizada em D-007.

---

## D-015 — Escala de entrada: exatamente 2 casas decimais (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna do enunciado, levantada ao escrever a regex de `Money.from()`. A §6.1 rejeita "mais de 2 casas decimais" e diz que a escala é fixa em 2, mas não diz o que fazer com **menos** — `"25"`, `"25.5"`.

**Decisão:** **rejeitar.** `Money.from()` exige exatamente 2 casas decimais; `"25"` e `"25.5"` são payload inválido.

**Justificativa:** falha cedo e alto — um provedor que envia `"25"` tem bug de serialização e precisa saber. E há um ganho que vai além do estilo: com escala exata existe **uma única representação textual por valor**, o que remove uma interação perigosa com o `payloadHash` de D-005. Se `"25"` e `"25.00"` fossem ambos aceitos sob a mesma idempotency key, o hash divergiria e um reenvio legítimo viraria `IDEMPOTENCY_CONFLICT` falso — o pior tipo de bug de idempotência, porque parece funcionamento correto.

**Consequências:**
- Regex de `Money.from()`: exatamente 2 decimais, **sem zeros à esquerda** na parte inteira, no máximo 17 dígitos inteiros (o que `numeric(19,2)` de D-004 comporta). Zeros à esquerda caem pelo mesmo argumento de canonicidade: `"025.00"` e `"25.00"` não podem coexistir sob uma mesma idempotency key.
- RT-01 passa a cobrir `"25"`, `"25.5"` e `"025.00"` como rejeitados, além dos casos já listados.
- `docs/requirements.md` RF-01: a marcação `[INTERPRETAÇÃO]` vira regra.

---

## D-016 — Validação de `currency` em `Money`: forma `[A-Z]{3}` (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna descoberta em E-02, ao escrever as factories de `Money`. RF-01 diz que `currency` é ISO-4217 e D-015 fechou a escala do `amount`, mas nada dizia o que `from()` e `zero()` fazem com `"brl"`, `"BR"`, `"BRLX"` ou `""`.

**Opções:**
- **Rejeitar o que não casar `[A-Z]{3}`** — validação de forma, sem tabela.
- **Normalizar para maiúscula** — aceita `"brl"` e guarda `"BRL"`.
- **Não validar em E-02** — `currency` como string opaca no domínio, validação só no DTO da API (E-08).

**Decisão:** **rejeitar tudo que não casar `^[A-Z]{3}$`**, com erro de domínio. Sem tabela ISO-4217: a validação é de **forma**, não de existência do código.

**Justificativa:** é o argumento de D-015 aplicado à outra metade do `MoneyProps` — **uma representação textual por valor**. Se `"brl"` e `"BRL"` coexistissem, dois efeitos ruins e difíceis de enxergar apareceriam: o `payloadHash` de D-005 divergiria para o mesmo dinheiro, transformando reenvio legítimo em `IDEMPOTENCY_CONFLICT` falso; e a comparação de moeda contra a wallet produziria `CURRENCY_MISMATCH` falso. Normalizar resolveria o primeiro, mas ao custo de o payload guardado não ser mais o payload que chegou — e D-005 calcula o hash sobre o que chegou. Não validar deixaria o domínio aceitar `""` como moeda, que é exatamente o tipo de entrada que RF-01 manda rejeitar.

A tabela ISO-4217 completa foi descartada: é escopo que ninguém pediu, tem manutenção própria (a lista muda) e ganho marginal — a §6.1 do enunciado autoriza assumir moeda única `BRL`, desde que o modelo continue multi-moeda.

**Consequências:**
- `CURRENCY_PATTERN = /^[A-Z]{3}$/` em `src/domain/money.ts`, aplicado por `from()` **e** por `zero()`.
- RT-01 cobre `"brl"`, `"BR"`, `"BRLX"`, `""` e `" BRL"` como rejeitados nas duas factories.
- A ausência de validação de existência do código ISO vira **limitação conhecida** em `ARCHITECTURE.md` (E-17), junto da escala 2 global de D-003.
- `docs/requirements.md` RF-01 atualizado.

---

## D-017 — `equals()` entre moedas diferentes: lança (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna descoberta em E-02. RF-01 lista `equals` entre as **consultas** (`isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`) e, separadamente, diz que "operação entre moedas diferentes lança erro de domínio". A taxonomia não decide o caso: `isLessThan` também é consulta e precisa lançar, porque é o teste de saldo insuficiente — resposta silenciosa errada ali é vizinha de EL-02.

**Opções:**
- **Lançar `CurrencyMismatchError`**, como `add` e `subtract`.
- **Retornar `false`** — igualdade total, convenção usual de JS: moedas diferentes nunca são o mesmo dinheiro.

**Decisão:** **lançar.** Toda operação binária de `Money` entre moedas diferentes passa por `assertSameCurrency` — `add`, `subtract`, `isLessThan` e `equals`.

**Justificativa:** uma regra só, explicável numa frase: *comparar BRL com USD é erro de programação, não resposta*. A alternativa é defensável em abstrato, mas aqui tem custo concreto: com `false`, um bug cross-currency em RN-10 (a reversão precisa ter valor igual ao original) sairia como `AMOUNT_MISMATCH` — um `failureCode` errado e plausível o bastante para ninguém investigar. Lançar exige que o check de moeda venha antes do check de valor, que é a ordem que as regras de negócio já têm.

**Consequências:**
- `assertSameCurrency` em `add`, `subtract`, `isLessThan` e `equals`. `negate`, `isZero`, `isPositive` e `isNegative` são unários e não se aplicam.
- RT-04 exercita os quatro métodos entre `BRL` e `USD`.
- `docs/requirements.md` RF-01 atualizado.

---

## D-003 — Representação interna de `Money`: `bigint` de centavos (2026-09-01)

**Status:** DECIDIDA
**Histórico:** decidida inicialmente como `decimal.js` e **revista no mesmo dia**, a pedido do mantenedor, depois de verificar que a troca não altera o contrato público de `Money`. Registro mantido porque a revisão é parte do raciocínio, não um erro a esconder.

**Contexto:** RF-01, RI-01, EL-01 — `number` é eliminatório. Alternativas consideradas: `decimal.js` e `big.js`. Dois fatos decidiram:
1. O domínio só faz `add`, `subtract` e `negate` — **nunca multiplica nem divide**. Não existe política de arredondamento a decidir, que é justamente o problema que bibliotecas decimais resolvem.
2. `Decimal` aparece no esqueleto do enunciado (§6.1) em **um único lugar**: um campo privado de um construtor privado. Toda a superfície pública é expressa em `MoneyProps { amount: string; currency: string }`. A §6 do enunciado ainda diz explicitamente que os blocos são esqueletos de referência e que assinaturas podem ser adaptadas.

**Decisão:** **`bigint` de centavos**, com escala 2 numa constante única. Nenhuma dependência externa para dinheiro.

**Justificativa:** exato por construção. Não há configuração de precisão para acertar, modo de arredondamento para escolher, nem entrada permissiva para guardar — `BigInt("25.00")` simplesmente lança, então a validação de entrada é obrigatória por construção em vez de por disciplina. Uma biblioteca decimal seria necessária se houvesse multiplicação ou divisão; não há. Adotá-la seria carregar superfície para um problema que este domínio não tem.

O desvio em relação ao esqueleto é deliberado e **precisa estar na ponta da língua na apresentação**, porque será perguntado. A resposta: *"o domínio só soma e subtrai; inteiro é exato por construção e elimina a classe inteira de erro de configuração de precisão. `Decimal` seria necessário se houvesse multiplicação — não há."* A §1 do enunciado diz que o que se avalia é raciocínio claro e decisões justificadas; conformidade sem razão não pontua, desvio com razão pontua.

**Consequências — o que vira checkbox em E-02:**
- **Parse por regex é a única porta de entrada.** `Money.from()` valida o formato e só então monta o `bigint`. Não existe caminho preguiçoso que aceite entrada inválida por acidente, porque `BigInt("25.00")` lança.
- **`negate()` não passa por `from()`.** RF-01 rejeita negativos em contratos de entrada, mas `negate()` precisa produzir `Money` negativo para o lançamento invertido do `ROLLBACK` (RN-05). Ele constrói pelo construtor privado, sem revalidar — mesma lógica de `rehydrate`.
- **Formatação sem `Number` em ponto nenhum**: divisão e resto sobre `bigint`, mais `padStart(2, "0")`. Qualquer `Number(bigint)` no caminho converteria para float em silêncio e criaria EL-01.
- **O `bigint` nunca sai do domínio.** `JSON.stringify` lança em `bigint`, então um vazamento seria barulhento — mas o teste que garante que `JSON.stringify(money)` produz `MoneyProps` e não lança trava o comportamento de propósito.
- **Comparação por `===` passa a ser correta.** Com objeto decimal, `a.value === b.value` seria comparação de referência — um bug silencioso plausível. Com `bigint`, `===` compara valor.
- **Escala 2 vive numa constante única** (`SCALE_FACTOR = 100n`), comentada citando §6.1 como origem da premissa. Moedas de escala 0 (JPY) ou 3 (KWD) exigiriam uma tabela por moeda — registrar como limitação conhecida em `ARCHITECTURE.md`, junto com a observação de que o enunciado fixa escala 2 globalmente.
- Documentos atualizados: `docs/implementation-plan.md` E-01 e E-02.

---

## D-004 — Mapeamento de `Money` na persistência: `numeric(19,2)` + mapper próprio (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RF-01 permite colunas separadas desde que a representação seja exata e reidratada como `Money`; §4 do enunciado pede o mapeamento justificado em `ARCHITECTURE.md`. Duas restrições decidiram: RI-09 exige `CHECK (balance >= 0)` **no schema**, e RF-16 reconstrói o saldo com `SUM` sobre o ledger. As duas precisam funcionar em SQL puro. Alternativas consideradas: `bigint` de centavos e Custom Type (`Type<Money, string>`) do MikroORM.

**Decisão:** coluna **`numeric(19,2)`** para o valor + **`varchar(3)`** para a moeda, com a conversão num **mapper explícito da camada de infraestrutura**.

**Justificativa:** `numeric` mantém a semântica monetária visível no próprio schema — quem inspeciona o banco lê `25.00`, não `2500` precisando saber a escala de cabeça. `CHECK` e `SUM` saem diretos. O mapper próprio, em vez de Custom Type do MikroORM, é código nosso: mais fácil de mostrar, de testar e de defender na apresentação, e reduz a superfície de API do MikroORM em jogo — o que importa porque D-001 assumiu esse ORM sem plano B.

**Consequências:**
- **Guarda de EL-01 na camada do driver:** teste que prova que o driver do Postgres devolve `numeric` como **string**, não `number`. É o comportamento padrão do node-postgres, mas um type parser registrado por engano converteria para float silenciosamente e criaria a falha eliminatória mais difícil de enxergar no diff. O teste trava esse comportamento.
- O domínio continua sem conhecer o ORM (RF-01); o mapper vive só em `src/infrastructure`.
- **Simetria com D-003:** o domínio guarda centavos (`2500n`, exato por construção) e o banco guarda a forma legível (`25.00`, inspecionável por humano e somável em SQL). O mapper é o único ponto que conhece as duas representações, e é onde a conversão é testada.
- `CHECK (balance >= 0)` e a reconciliação de RF-16 escritos em SQL puro sobre a coluna.
- Documentos atualizados: `docs/implementation-plan.md` E-05 e E-06.

---

## D-001 — ORM: MikroORM, sem plano B (2026-09-01)

**Status:** DECIDIDA
**Contexto:** o enunciado (§4) exige MikroORM ou TypeORM e pede justificativa em `ARCHITECTURE.md`. MikroORM é declarado **preferencial**, citando Unit of Work e Identity Map explícitos, `EntityManager.transactional()` e `LockMode` — exatamente os recursos que sustentam a defesa técnica deste desafio. O contraponto era o risco de maturidade sob o runtime do Bun.

**Decisão:** **MikroORM, sem fallback.** TypeORM não é caminho de fuga. Se houver atrito com o Bun, a resposta é resolver o atrito — não trocar de ORM no meio do prazo.

**Justificativa:** o enunciado nomeia MikroORM como preferencial e cita os recursos que este desafio precisa defender: Unit of Work explícito para argumentar a atomicidade de RF-23, e `LockMode` para a estratégia de concorrência de D-002. TypeORM entregaria o mesmo comportamento com um argumento mais fraco na apresentação. Manter um fallback aberto convidaria a abandonar a escolha no primeiro atrito, quando a maioria dos atritos previsíveis (decorators, `reflect-metadata`, resolução de módulos) tem solução conhecida e barata.

**Consequências:**
- O timebox de 2h de E-00 passa a governar **a validação**, não a escolha. Falhar em E-00 não troca o ORM: escala para o mantenedor com o erro concreto em mãos.
- E-00 ganha uma verificação obrigatória: confirmar **no SQL efetivamente emitido** que `LockMode.PESSIMISTIC_WRITE` produz `SELECT ... FOR UPDATE`. É o alicerce de D-002 e de EL-02 — descobrir isso na E-09 seria tarde demais.
- Versões `@mikro-orm/*` fixadas exatas (sem `^`) no `package.json`. Desalinhamento entre pacotes do MikroORM é fonte conhecida de erro obscuro.
- **Levantado em 2026-09-01, durante a preparação de E-00:** a linha atual do MikroORM é a **v7** (`@mikro-orm/core@7.1.14`, `@mikro-orm/nestjs@7.1.0`), não a v6.

**Resultado do spike E-00 (2026-09-01) — o risco assumido nesta decisão não se materializou:**

- MikroORM v7.1.14 conecta ao PostgreSQL 17 real sob Bun 1.4.0, persiste e reidrata sem atrito.
- `LockMode.PESSIMISTIC_WRITE` **emite mesmo `SELECT ... FOR UPDATE`** — confirmado inspecionando o SQL capturado pelo logger, não a documentação. É o alicerce de D-002 e de EL-02.
- Achado extra que serve a D-009: **`LockMode.PESSIMISTIC_PARTIAL_WRITE` emite `FOR UPDATE SKIP LOCKED`** nativamente. O claim com lease não precisa de SQL cru.
- NestJS 12.0.1 resolve injeção por construtor sob o transpilador do Bun (`experimentalDecorators` + `emitDecoratorMetadata`).

**Mudança de arquitetura descoberta no spike — a v7 removeu decorators por completo.** Não existe `@Entity`/`@Property`; o mapeamento vive num `EntitySchema`, que é objeto de infraestrutura. Consequência boa e não planejada: a exigência de RF-01 e de `AGENTS.md` §4 (domínio sem decorators de ORM) passa a ser **estrutural** em vez de convencional — não há como violá-la por descuido, porque a ferramenta para violar não existe. Vale registrar em `ARCHITECTURE.md`: reforça o argumento de boundaries sem custo nenhum.

**Armadilha registrada para E-06:** as opções soltas de conexão (`host`/`port`/`user`/`password`) funcionam normalmente — mas `orm.isConnected()` retorna `false` até o pool conectar de fato, porque a conexão é preguiçosa. Usar `isConnected()` como healthcheck de readiness (RF-17) daria falso negativo. O readiness precisa emitir uma query real.
- Documentos atualizados: `AGENTS.md` §2, `docs/implementation-plan.md` E-00.

---

## D-011 — Infraestrutura dos testes de integração: híbrida (2026-09-01)

**Status:** DECIDIDA
**Contexto:** EL-08 torna eliminatório substituir Postgres e SQS por mocks. Os testes rodam sob `bun test`. A tensão era entre velocidade do loop de desenvolvimento (Compose fixo) e autocontenção para o avaliador (Testcontainers).

**Decisão:** **híbrida.** `docker compose` fixo para o loop de desenvolvimento; **Testcontainers na suíte de integração e de concorrência**, de modo que `bun run check:full` se autoprovisione.

**Justificativa:** os dois públicos têm necessidades opostas. Durante o desenvolvimento, subir container a cada suíte é custo repetido dentro de um prazo de 3 dias. Para o avaliador, um comando único que provisiona tudo e roda contra Postgres e SQS reais é a demonstração mais direta de que EL-08 não foi violada — e evita que a avaliação dependa de o avaliador lembrar de subir o Compose antes.

**Consequências:**
- Duas infraestruturas para manter. **Mitigação obrigatória:** a configuração de conexão vive num **único módulo** que lê endereços do ambiente; Compose e Testcontainers apenas populam esse ambiente. Nenhum teste sabe qual dos dois está por trás — se um teste precisar saber, a mitigação falhou.
- E-00 ganha um item bloqueante: **validar Testcontainers sob o runtime do Bun**. Com D-001 sem plano B, este passou a ser o principal risco técnico remanescente do spike.
- `README.md` documenta os dois caminhos: loop de desenvolvimento com Compose de pé, e `bun run check:full` autoprovisionado.
- `ARCHITECTURE.md` registra a duplicidade como trade-off consciente, não como acidente.

**Resultado do spike E-00 (2026-09-01) — a metade de risco está viável:**

- `testcontainers@12.1.0` sobe PostgreSQL 17 sob `bun test` e o MikroORM conecta na URI que o container entrega. O fallback registrado (rodar tudo no Compose) **não precisou ser acionado**.
- A simetria de D-011 se resolveu melhor do que o previsto: o Testcontainers expõe `getConnectionUri()`, então o Compose é exposto no mesmo formato por `buildClientUrl()`. A configuração do MikroORM fica **idêntica** nos dois caminhos e nenhum teste ramifica.

**Dois achados de ambiente que precisam sobreviver a esta etapa:**

1. **LocalStack a partir da linha 2026.x exige token de licença.** A imagem encerra com exit 55 e "License activation failed" mesmo sem nenhuma variável de ambiente — verificado empiricamente. O Compose está fixado em **`localstack/localstack:4.14.0`**, o último release que sobe como community edition. Registrar em `ARCHITECTURE.md` como restrição de ambiente, não como preferência.
2. **PostgreSQL nativo do Windows ocupa a 5432** na máquina de desenvolvimento e responde ao `localhost` antes do proxy do Docker. O sintoma é falha de autenticação `28P01` com o container saudável e as credenciais corretas — diagnóstico caro, porque tudo aparenta estar certo. O Compose publica em **55432**.

---

## D-012 — Autenticação: não implementar (2026-09-01)

**Status:** DECIDIDA
**Contexto:** §2 do enunciado. Auth não pontua na tabela de avaliação, e o enunciado aceita explicitamente a não-implementação desde que documentada com o desenho pretendido e um ponto de extensão explícito no código.

**Decisão:** **não implementar.** Entregar o desenho escrito em `ARCHITECTURE.md` mais `ProviderIdentityPort` e `AuthGuard` no-op como pontos de extensão.

**Justificativa:** o enunciado posicionou essa seção antes de todo o resto exatamente para o candidato dimensionar o timebox — é um teste de disciplina de escopo. As 4–8h liberadas vão para as quatro áreas que somam 70 dos 100 pontos. O desenho documentado demonstra que a decisão foi de alocação de tempo, não de desconhecimento.

**Consequências:**
- E-08 ganha `ProviderIdentityPort` e um `AuthGuard` no-op registrado, sem verificação.
- Os endpoints de health permanecem abertos por requisito (RF-17), o que passa a ser coerente com o resto por construção.
- A identidade do provedor contida na mensagem **continua sujeita às validações de domínio** (RN-07). Não autenticar não relaxa regra de negócio — este ponto precisa estar explícito na apresentação.
- E-17 inclui a seção de `ARCHITECTURE.md`: qual IdP seria adotado, onde o guard entraria, o que mudaria no contrato da API.
- Documentos atualizados: `docs/requirements.md` §7, `AGENTS.md` §3.

---

## D-018 — Retorno de `debit`/`credit`: o lançamento do ledger (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna delegada **explicitamente** pelo enunciado. A §6.2 descreve `debit`/`credit` como "aplicam a movimentação mantendo saldo e ledger consistentes entre si" e acrescenta: "assinatura e retorno são decisão sua". RF-02 lista entre as invariantes que **toda alteração de saldo tem um lançamento correspondente no ledger, e vice-versa**. A decisão é, na prática, quem garante essa invariante.

**Opções:**
- **Devolver o `WalletLedgerEntry` criado** — a wallet é a única fonte de `balanceBefore`/`balanceAfter`, então ela é quem tem os dados para montar o lançamento.
- **Devolver `void`** e deixar o use case montar o lançamento lendo o saldo antes e depois.
- **Receber o lançamento pronto** (`wallet.apply(entry)`), com a wallet validando e aplicando.

**Decisão:** `debit`/`credit` recebem `{ entryId, transactionId, money, at }` e **devolvem o `WalletLedgerEntry`** já criado e balanceado.

**Justificativa:** é a única opção em que a invariante de RF-02 é **estrutural**. Não existe assinatura no agregado capaz de mover saldo sem entregar o lançamento junto — quem chama `debit` recebe o lançamento querendo ou não, e descartá-lo é visível no diff. Com `void`, a correspondência passaria a depender de o use case lembrar de montar o lançamento com os valores certos, e o esquecimento apareceria só na reconciliação de RF-16, muito depois. A terceira opção inverte a responsabilidade: quem monta o lançamento precisaria conhecer `balanceBefore` e `balanceAfter` **antes** de a wallet aplicar, que é exatamente o `read → calculate → update` que RI-07 proíbe.

**Consequências:**
- Ids (`entryId`) e instante (`at`) são **injetados**, não gerados no domínio. Segue o padrão que o próprio enunciado já usa em `Wallet.open`, que recebe `id` de fora, e mantém o domínio determinístico e livre de `Bun.randomUUIDv7()` (D-014).
- **`Wallet.open` segue o mesmo princípio** e devolve `{ wallet, openingEntry }`. RF-08 e o exemplo da §9 exigem, juntos, saldo inicial **e** `version: 1` na resposta — o saldo nasce com a wallet, não por um `credit` posterior, que daria `version: 2`. Mas a abertura é mudança de saldo e precisa do lançamento correspondente. `openingEntry` é `undefined` quando o saldo inicial é zero, porque RF-08 só gera `OPENING` acima de zero.
- E-07 e E-08 persistem o lançamento devolvido dentro da mesma transação SQL (RF-23).
- Coberto por `tests/unit/wallet.test.ts`, incluindo a invariante final de §6.4 dos requisitos.

---

## D-019 — Saldo insuficiente: consulta no caminho de negócio, exceção como guarda (2026-09-01)

**Status:** DECIDIDA
**Contexto:** RN-01 rejeita `BET` sem saldo e RN-16 exige que "sem saldo para apostar" (`INSUFFICIENT_FUNDS`) e "sem saldo para reverter" (`INSUFFICIENT_FUNDS_ON_REVERSAL`) sejam códigos **distintos**. A wallet não sabe o kind da operação, então não pode escolher o código. A pergunta é como a condição sai do agregado.

**Opções:**
- **Consulta `hasSufficientBalanceFor()` + `debit` lançando** como guarda de último recurso.
- **Só exceção**: `debit` lança `InsufficientFundsError` e o use case captura e traduz pelo kind.
- **Só consulta**: `debit` confia no chamador.

**Decisão:** as duas coisas. `Wallet.hasSufficientBalanceFor(money)` é o **caminho de negócio** — o use case consulta e decide o `failureCode` pelo kind — e `debit` **ainda lança** `InsufficientFundsError` se for chamado sem cobertura.

**Justificativa:** as duas metades resolvem problemas diferentes e nenhuma resolve a do outro. A consulta mantém a rejeição — que é o caminho **esperado**, não excepcional — fora do controle de fluxo por exceção, e deixa a escolha do código com quem sabe o kind. A guarda existe porque EL-02 é eliminatória: um caminho novo que esqueça a consulta precisa falhar alto, não gravar saldo negativo e esperar o `CHECK` do banco de E-05 ser a única barreira. Barreira única é barreira pouca quando a falha invalida a entrega inteira.

**Consequências:**
- `InsufficientFundsError` carrega saldo e valor pedido em campos, para o log estruturado de RNF-06.
- `hasSufficientBalanceFor` valida a moeda antes do valor (D-017), na mesma ordem que as regras de negócio já têm.
- E-12 mapeia a condição para `INSUFFICIENT_FUNDS` ou `INSUFFICIENT_FUNDS_ON_REVERSAL` conforme o kind.
- `tests/unit/wallet.test.ts` prova que o débito acima do saldo é recusado **sem** consulta prévia e deixa saldo, `version` e `updatedAt` intactos.

---

## D-020 — Referência ausente em `REFUND`/`ROLLBACK`: payload inválido (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna descoberta em E-03, ao escrever a validação de `WagerTransaction.create`. RN-06 diz que `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId` e que "ausência é rejeição, não aceite". Mas D-007 fechou a taxonomia em 13 códigos e **nenhum deles descreve "a referência não veio no payload"**: `REFERENCE_NOT_FOUND` é o esgotamento do TTL de RF-26, situação em que o provedor mandou a referência e ela nunca apareceu. Uma rejeição sem código correspondente não é representável — `reject()` exige um `FailureCode`.

**Opções:**
- **Erro de payload em `create()`** → `400` por D-006; nenhuma transação nasce e o enum segue fechado em 13.
- **`REJECTED` com um 14º código** (`MISSING_REFERENCE`) — auditável no banco, mas reabre D-007.
- **`REJECTED` reusando `REFERENCE_NOT_FOUND`** — mantém 13 códigos, mas colapsa duas situações.

**Decisão:** **payload inválido.** `WagerTransaction.create` lança `MissingReferenceError`, D-006 mapeia para `400` e nenhuma transação chega a existir.

**Justificativa:** a §7.2 do enunciado define o critério de qualidade da taxonomia: o código precisa bastar para o provedor decidir entre reenviar, corrigir o payload ou desistir. Reusar `REFERENCE_NOT_FOUND` destruiria exatamente essa distinção — "você não mandou a referência" (corrigir e reenviar, resolve na hora) e "esperamos 15 minutos e ela nunca chegou" (desistir ou investigar a origem) viriam com o mesmo código. E criar um 14º código para representar um campo obrigatório ausente confundiria as duas camadas: a validação de forma do payload é o que D-006 já mapeia para `400`, junto com `Idempotency-Key` ausente (RF-13) e valor monetário malformado (RF-01). Referência ausente é o mesmo tipo de erro que esses dois, não uma decisão de negócio.

**Consequências:**
- `create()` valida a exigência de referência por kind, como a §6.3 do enunciado descreve, e lança `MissingReferenceError`.
- O enum de D-007 **continua fechado em 13**.
- E-08 mapeia `MissingReferenceError` para `400` junto com `InvalidMoneyError`.
- **Limitação conhecida para `ARCHITECTURE.md`:** uma submissão sem referência não deixa registro auditável no banco, porque nenhuma transação nasce. É o mesmo tratamento que qualquer payload malformado recebe, e o rastro fica no log estruturado (RNF-06) — não no ledger.
- `docs/requirements.md` RN-06 atualizado.

---

## D-021 — Movimentação de valor zero: recusada (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna descoberta em E-03. `Money.from({ amount: "0.00" })` é válido — a escala de D-015 aceita zero —, então um `WIN` de `0.00` chegaria a `Wallet.credit()`. RF-02 exige que `version` incremente **somente quando o saldo muda** e RF-04 diz que operações sem efeito no saldo **não geram lançamento**. Um movimento de valor zero viola uma das duas, dependendo de como for tratado.

**Opções:**
- **Exigir valor estritamente positivo** em `debit`/`credit`, lançando.
- **Aceitar zero sem incrementar `version`** — cumpre RF-02 ao pé da letra, mas cria lançamento sem mudança de saldo, contra RF-04.
- **Aceitar zero e incrementar `version`** — mais simples, mas contraria RF-02 literalmente.

**Decisão:** **`debit` e `credit` exigem valor estritamente positivo** e lançam `InvalidLedgerEntryError` em zero ou negativo. A mesma regra vale na factory de `WalletLedgerEntry`.

**Justificativa:** é a única opção que satisfaz RF-02 e RF-04 ao mesmo tempo, e satisfaz RF-02 **por construção** em vez de por ramificação: `debit`/`credit` são o único caminho que muda saldo, e nenhum deles é chamado com movimento nulo, então "incrementa somente quando o saldo muda" deixa de precisar de um `if`. Recusar negativo tem justificativa própria e independente: `LedgerDirection` já carrega o sinal do movimento, e um valor negativo com direção codificaria o sinal duas vezes — duas fontes para o mesmo fato é como divergência de sinal entra sem ninguém ver.

**Consequências:**
- Valor zero vindo de fora vira **payload inválido** (`400`) na validação de E-08, não rejeição de negócio: o enum de D-007 segue fechado em 13, pelo mesmo argumento de D-020.
- `WalletLedgerEntry.create` recusa valor não positivo, o que fecha a porta também para quem construir lançamento sem passar pela wallet.
- RT-02 ganha um teste explícito de que nenhuma operação recusada — saldo insuficiente, moeda divergente, valor zero, valor negativo — altera saldo, `version` ou `updatedAt`.
- `docs/requirements.md` RF-02 e RF-04 atualizados.

---

## D-022 — Curva de backoff da outbox: equal jitter com política injetada (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna descoberta em E-04, ao escrever `OutboxMessage.scheduleRetry`. D-008 fixou os **limites** do backoff — 10 tentativas de publicação, teto de 5 min, jitter obrigatório nos três loops — mas **não a forma da curva**: faltam o delay-base, o multiplicador e o formato do jitter. A etapa expôs junto dois impedimentos estruturais que nenhuma decisão anterior previa: a regra de fronteira de E-01 impede `src/domain/` de importar a configuração de infraestrutura, e a guarda de EL-01 bane `Math` em **todo** `src/` — portanto `Math.random()` também está fora. A entidade não tem como buscar nem os números nem a aleatoriedade sozinha.

**Opções — forma da curva:**
- **Equal jitter**: `h = min(teto, base · 2^tentativas) / 2`, `delay = h + rand·h`. Mantém um piso de espera e ainda dessincroniza instâncias.
- **Full jitter** (o que a AWS recomenda): `delay = rand(0, min(teto, base · 2^tentativas))`. Dessincroniza melhor, mas o sorteio pode dar ~0.
- **Decorrelated jitter**: `delay = min(teto, rand(base, delay_anterior · 3))`. Melhor sob contenção, mas depende do delay anterior.

**Opções — como a política chega ao domínio:**
- **Parâmetro da chamada**: `scheduleRetry(now, policy)`.
- **Injetada na construção**: `enqueue`/`rehydrate` recebem a política e a entidade a guarda.
- **Infra calcula o `nextAttemptAt`** e o domínio só incrementa.

**Decisão:** **equal jitter** com `base = 1 s` e `teto = 5 min` (os números de D-008), e a política **injetada como parâmetro da chamada**, na forma `RetryPolicy { baseDelayMs, maxDelayMs, random }`.

**Justificativa:** o piso é o ponto da decisão. Com full jitter o sorteio pode dar quase zero, e sob indisponibilidade prolongada do SQS as primeiras tentativas ficariam quase quentes — o oposto do que D-008 declara como intenção ao escolher "defaults conservadores". Decorrelated jitter exigiria persistir o delay anterior, ampliando o schema de E-05 por um ganho que a suíte não exercita.

Sobre a injeção: passar a política na chamada é a única das três que resolve as duas restrições sem custo em outro lugar. Injetá-la na construção transformaria configuração em estado da entidade, que teria de ser costurado em todo `rehydrate` do repositório de E-06 — e um `rehydrate` que precisa de configuração deixa de ser "reconstruir o que está no banco". Deixar a infra calcular o `nextAttemptAt` tiraria do domínio justamente o cálculo que RF-06 pede que esteja nele. Como efeito colateral bem-vindo, o `random` injetado torna a curva determinística sob teste **sem** substituir o mecanismo por um relógio ou gerador falso — que é o que D-008 já exigia dos testes de RT-12 e RT-20.

**Consequências:**
- `src/domain/retry-policy.ts` define `RetryPolicy`; o módulo de configuração de retry da infraestrutura (E-10) é quem o preenche a partir do ambiente, com os defaults de D-008.
- A curva vive no domínio; os números vivem na infraestrutura. `ARCHITECTURE.md` registra a divisão.
- A truncagem para milissegundo inteiro é feita por subtração da parte fracionária (`x - x % 1`), exata em IEEE-754. `Math.trunc` está banido em `src/` pela guarda de EL-01 e **não deve ser liberado**: abrir exceção para tempo abriria a mesma porta para arredondamento de dinheiro no mesmo diretório.
- O expoente é limitado antes de `2 ** n`, para que uma contagem corrompida vinda do banco não produza `Infinity` e não transforme `nextAttemptAt` em `Invalid Date` — o que travaria a linha para sempre.
- O mesmo `RetryPolicy` serve aos outros dois loops de D-008 (consumo com DLQ, worker de referências), sem uma segunda curva para manter.

---

## D-023 — Imutabilidade do ledger: trigger que lança (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna descoberta ao detalhar E-05. RI-05 proíbe sobrescrever ou excluir lançamentos, RI-09 exige que a garantia esteja **no schema** e EL-07 é eliminatória. O escopo da etapa registrava as duas vias possíveis sem escolher entre elas ("revogar `UPDATE`/`DELETE` **ou** trigger que rejeita"), e a escolha muda o que RT-08 consegue provar.

**Opções:**
- **`REVOKE UPDATE, DELETE`**: idiomático e barato, expressa a garantia no modelo de privilégios. Mas o dono da tabela e qualquer superusuário ignoram a revogação, e o usuário que o Testcontainers cria é superusuário — provar a garantia exigiria criar uma role de aplicação separada dentro da migration e reconectar o teste com ela.
- **Trigger `BEFORE UPDATE OR DELETE` com `RAISE EXCEPTION`**: vale para qualquer role, inclusive superusuário. Custo: um objeto de banco a mais, que o `down` precisa desfazer.
- **As duas**, defesa em profundidade.

**Decisão:** **trigger que lança**, sem `REVOKE`.

**Justificativa:** a garantia precisa ser **provável pela suíte**, não apenas declarada. Com `REVOKE`, o teste de RT-08 que sustenta EL-07 rodaria como superusuário e passaria por engano — um `UPDATE` bem-sucedido que ninguém veria, na exata falha eliminatória que o mecanismo deveria fechar. A trigger não depende de quem está conectado, que é a propriedade que interessa aqui.

As duas juntas foram descartadas por criarem dois mecanismos para o mesmo fato, com a role extra a manter no `down` sem nada que a suíte exercite. O modelo de privilégios continua sendo o caminho certo em produção, e entra em `ARCHITECTURE.md` como recomendação de deploy — não como código desta entrega.

**Consequências:**
- A migration inicial cria a função `reject_ledger_mutation()` e a trigger `ledger_immutable` sobre `wallet_ledger_entries`; o `down` derruba as duas.
- RT-08 tenta um `UPDATE` e um `DELETE` sobre um lançamento existente e exige erro do banco nos dois — é a prova de EL-07 no schema, complementar à imutabilidade estrutural que E-03 já garantiu no objeto.
- **Limitação conhecida para `ARCHITECTURE.md`:** a trigger custa uma chamada por linha afetada em `UPDATE`/`DELETE`. Como nenhum caminho legítimo do sistema emite qualquer um dos dois sobre o ledger, o custo real é zero — ele só aparece no caminho que deve falhar.
- `REVOKE UPDATE, DELETE` para a role de aplicação fica documentado como endurecimento recomendado em produção, fora do escopo desta entrega.

---

## D-024 — Alcance da unicidade de RN-09: índice parcial sobre `PROCESSED` (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna descoberta ao detalhar E-05. RN-09 exige que uma referência não seja revertida duas vezes pelo mesmo tipo de operação, e RI-09 manda a garantia para o banco. O que não estava registrado é **quais linhas** o índice cobre: toda transação com referência resolvida, ou só as que efetivamente reverteram.

**Opções:**
- **Índice total** sobre `(reference_transaction_id, kind)` para toda linha com referência resolvida: garantia mais forte e mais simples de explicar, mas a primeira tentativa **rejeitada** queima a referência para sempre — a segunda submissão morre com erro de banco antes de ser avaliada pela regra de negócio.
- **Índice parcial** sobre as linhas `PROCESSED`: conta apenas reversões efetivas.

**Decisão:** **índice parcial**, `WHERE status = 'PROCESSED' AND reference_transaction_id IS NOT NULL`.

**Justificativa:** RN-09 fala em **reverter** duas vezes, e uma transação `REJECTED` não reverteu nada — RN-11 é explícita em que ela não altera saldo nem gera ledger. O caso que decide é o de RN-16: um `REFUND` recusado por saldo insuficiente na reversão é uma situação operacional recuperável, e com o índice total ela viraria um bloqueio permanente daquela referência, expresso como erro de integridade em vez de `failureCode` — o oposto do que RN-17 pede da taxonomia.

O índice parcial ainda fecha a corrida real: duas reversões concorrentes da mesma referência disputam a escrita do status `PROCESSED`, e a segunda recebe violação de unicidade. A serialização por wallet de D-002 já as ordena; o índice é a garantia que não depende de o lock estar correto.

**Consequências:**
- `CREATE UNIQUE INDEX ... ON wager_transactions (reference_transaction_id, kind) WHERE status = 'PROCESSED' AND reference_transaction_id IS NOT NULL` na migration inicial.
- Linhas `PENDING` e `PENDING_REFERENCE` ficam fora do índice, o que é necessário: a referência de uma `PENDING_REFERENCE` ainda **não** foi resolvida (RF-26) e a coluna é nula.
- E-12 continua responsável por rejeitar com `ALREADY_REVERSED` (D-007) no caminho de negócio. O índice é a rede embaixo, não o caminho — a violação de unicidade é o sinal de corrida perdida, não a mensagem que o provedor lê.
- RT-08 exercita o índice nas duas direções: duas reversões `PROCESSED` da mesma referência e kind são recusadas pelo banco; uma tentativa `REJECTED` seguida de uma `PROCESSED` é aceita.

---

## D-025 — Chave primária da inbox: par `(consumer_name, message_id)` (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna descoberta ao detalhar E-05, na forma de uma divergência entre dois textos já registrados. D-014 estendeu o UUIDv7 a "todas as tabelas"; E-04 modelou `InboxMessage` **sem id próprio**, declarando que a identidade é o par `(consumerName, messageId)`. Os dois não fecham para esta tabela.

**Opções:**
- **PK composta** `(consumer_name, message_id)`: a unicidade de RF-19/EL-05 passa a ser a própria chave primária.
- **`id uuid` sintético + `UNIQUE (consumer_name, message_id)`**: mantém D-014 literal, ao custo de um id que a entidade não tem, não recebe e não usa.

**Decisão:** **PK composta**. D-014 passa a ser lida como "toda tabela **com id sintético** usa UUIDv7".

**Justificativa:** o id sintético existiria só para satisfazer a leitura literal de uma decisão cujo objetivo era outro — D-014 resolve o **cursor de RF-10**, e a inbox não é paginada por cursor nem aparece em nenhuma API. Pior, obrigaria E-06 a gerar em `rehydrate` um valor que o domínio desconhece, o que quebra a premissa de que `rehydrate` reconstrói o que está no banco e nada mais.

A PK composta também põe a garantia de EL-05 no lugar mais visível do schema: a chave primária da tabela **é** a regra de deduplicação, e não uma constraint paralela que alguém poderia remover achando que é índice redundante.

**Consequências:**
- `inbox_messages` sem coluna `id`; `PRIMARY KEY (consumer_name, message_id)`.
- **D-014 fica com o alcance corrigido**: UUIDv7 é o padrão de id nas tabelas que têm id sintético — `wallets`, `wager_transactions`, `wallet_ledger_entries` e `outbox_messages`. A inbox é a exceção registrada, e é a única.
- E-06 mapeia `InboxMessage` com chave primária composta; nenhum id é gerado para ela.
- RT-08 prova a dedupe inserindo o mesmo par duas vezes e recebendo erro do banco, e prova que o **mesmo `message_id` em consumidores diferentes** é aceito — que é o caso que uma chave global colapsaria em silêncio.

---

## D-026 — Forma do mapeamento ORM ↔ domínio: modelos de linha + mapper (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna exposta por E-06. O domínio de E-02..E-04 e o schema de E-05 existem, mas nada os liga. D-001 fixou o MikroORM v7, cujo mapeamento é `EntitySchema` — objeto de infraestrutura, sem decorators. D-004 já havia rejeitado o Custom Type do MikroORM para `Money`, o que remove o único mecanismo pelo qual o ORM saberia transformar duas colunas num value object. Faltava registrar **sobre o quê** o `EntitySchema` é declarado.

**Opções:**
- **`EntitySchema` sobre as classes de domínio**: o ORM hidrata `Wallet` e `WagerTransaction` diretamente, mapeando os campos privados (`_balance`, `_version`). Menos código, mas `Money` exigiria o Custom Type rejeitado por D-004 — ou propriedades virtuais com hooks — e o schema passaria a depender de nomes de campo privado do agregado.
- **Modelos de linha na infraestrutura + mapper explícito**: `EntitySchema` sobre tipos que espelham a tabela; um mapper por agregado converte linha → `rehydrate()` e agregado → linha.

**Decisão:** **modelos de linha + mapper.**

**Justificativa:** é a única opção que mantém D-004 de pé. Sem Custom Type, o ORM não tem como produzir um `Money` a partir de `numeric` + `varchar`; mapear o agregado direto reintroduziria o Custom Type pela porta dos fundos ou espalharia hooks de hidratação. Há um segundo motivo, mais forte: `rehydrate` só cumpre seu papel se alguém o chamar. Mapeando o agregado direto, o ORM o construiria por `Object.create`, contornando as factories que E-02..E-04 desenharam como **única** porta de entrada do estado. E o `EntitySchema` deixaria de espelhar a tabela para espelhar campos privados — o acoplamento que RF-01 e `AGENTS.md` §4 existem para evitar.

**Consequências:**
- `src/infrastructure/persistence/rows/` — cinco `EntitySchema`, espelho fiel de `m0001-initial-schema.ts`. Coluna que o schema inventar não existe no banco.
- `src/infrastructure/persistence/mappers/` — a única camada que conhece as duas representações. `rehydrate()` é chamado aqui e em nenhum outro lugar do sistema.
- O domínio segue sem import de ORM, agora por construção e não por convenção: não existe arquivo em `src/domain/` que o `EntitySchema` precise citar.
- **Custo registrado para `ARCHITECTURE.md`:** cinco tipos de linha a mais, e toda coluna nova precisa ser acrescentada em dois lugares (schema e mapper). É o preço de manter o agregado livre do ORM, e é o mesmo trade-off que D-004 já aceitou para `Money`.

---

## D-027 — Interfaces de repositório: na camada de domínio (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna exposta por E-06. O use case de E-07 consome repositórios sem conhecer o MikroORM, então a interface precisa viver fora da infraestrutura. Faltava decidir em qual das duas camadas restantes.

**Opções:**
- **`src/application/ports/`** (Clean Architecture): a aplicação declara o que precisa; a infra implementa. Alinharia com `ProviderIdentityPort` de D-012.
- **`src/domain/repositories/`** (DDD clássico): a interface do repositório pertence ao domínio, porque só fala de agregados.

**Decisão:** **`src/domain/repositories/`.**

**Justificativa:** o contrato é escrito inteiramente em vocabulário de domínio — `Wallet`, `WagerTransaction`, `WalletLedgerEntry` — e pertence a quem define esses tipos. Pôr na aplicação faria a camada de aplicação declarar uma interface em que nenhum tipo é dela. A regra de fronteira do ESLint continua satisfeita: nenhuma dessas interfaces importa de `application`, `infrastructure` ou `interface`, nem de pacote externo.

**Consequências:**
- Cinco interfaces em `src/domain/repositories/`.
- **`WalletRepository.findByIdForUpdate` nomeia a intenção, não a estratégia.** "Ler para escrever" é pergunta de domínio; `SELECT ... FOR UPDATE` é resposta da infra (D-002) e pode mudar sem tocar o contrato. É o único ponto em que persistência encosta no vocabulário do domínio, e fica registrado como tal em vez de passar despercebido.
- **`WalletLedgerRepository` não tem `update` nem `delete`.** RI-05 e EL-07 passam a ser estruturais também na porta: não existe assinatura para mutar o ledger, então o caminho que a trigger de D-023 recusa nem chega a ser expressável no código de aplicação.
- `ProviderIdentityPort` (D-012) continua na aplicação quando E-08 o criar: identidade de provedor não é agregado deste domínio.

---

## D-028 — Escrita: comandos explícitos, não Unit of Work (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna exposta por E-06. RF-23 exige transação SQL única cobrindo transação, saldo, ledger, inbox e outbox. Dentro de `em.transactional()`, o MikroORM oferece dois caminhos de escrita: `em.persist()` com flush (Unit of Work, com change tracking e identity map) ou `em.insert()` / `em.nativeUpdate()` (comandos diretos ao driver).

**Opções:**
- **Unit of Work puro** — o argumento nominal de D-001 ("Unit of Work explícito para argumentar a atomicidade de RF-23").
- **Comandos explícitos** — a ordem do SQL é a ordem do código.
- **Híbrido** — UoW no que sofre `UPDATE`, comandos no que é insert-only.

**Decisão:** **comandos explícitos.** `em.insert()` e `em.nativeUpdate()` dentro de `em.transactional()`.

**Justificativa:** com UoW, quem decide a ordem dos `INSERT` é o `CommitOrderCalculator`, que a deriva das **relações declaradas** entre entidades — e os modelos de linha de D-026 não declaram relação nenhuma, só colunas `uuid`. A FK `fk_wallet_ledger_entries_wallet` exige a wallet antes do lançamento; sem relação declarada, essa ordem viraria acidente, e o modo de falhar é um `23503` intermitente sob carga. Declarar relações `m:1` só para ensinar o ordenador traria referências e populate para dentro de um mapeamento que existe justamente para ser burro.

O segundo motivo é EL-07: sem UoW não há identity map, e sem identity map não existe caminho em que um flush emita `UPDATE` sobre uma linha do ledger — que é exatamente o cenário para o qual a trigger de D-023 foi escrita. Ter a rede **e** não ter como acioná-la é melhor que depender só da rede.

A atomicidade de RF-23 não é afetada: ela vem do `em.transactional()`, que abre e fecha a transação do PostgreSQL. O flush do UoW é agrupamento de escrita, não a garantia — verificado no código instalado: `em.insert()` e `em.nativeUpdate()` passam o mesmo `transactionContext` ao driver. **Registrado para não parecer contradição na apresentação:** D-001 citou o Unit of Work entre as razões de escolher o MikroORM; o que este projeto usa dele é o `EntityManager` e o `transactional`, não o change tracking.

**Consequências:**
- Nenhum `em.persist()` / `em.flush()` no caminho de escrita dos repositórios.
- Leituras usam `disableIdentityMap: true`, para que a decisão valha também na volta — caso contrário o identity map voltaria pela porta da leitura.
- Todo `update` escreve **lista fechada de colunas**, escrita à mão no repositório. É o que dá a D-029 um lugar natural e o que impede um campo novo de ser persistido sem alguém decidir.
- **Repositório é objeto de transação, não singleton.** Cada um recebe no construtor o `EntityManager` que `em.transactional()` entrega; E-07 os constrói dentro da transação.
- Limitação conhecida para `ARCHITECTURE.md`: escrever a lista de colunas à mão é mais verboso que `flush()`, e uma coluna esquecida não é apontada pelo compilador. O round-trip de E-06 é a contrapartida — ele compara agregado ida e volta, campo a campo.

---

## D-029 — Colunas de retry de referência: sem dono no domínio até E-13 (2026-09-01)

**Status:** DECIDIDA
**Contexto:** lacuna exposta por E-06. `wager_transactions` tem `reference_attempts` e `next_reference_attempt_at` desde E-05, porque D-013 tirou o contador de tentativas do status e o pôs em colunas próprias. Mas `WagerTransaction` não tem esses campos: RF-03 não os lista e E-03 não os modelou. São as duas únicas colunas do schema sem dono no domínio, e E-13 (RF-26) vai precisar delas.

**Opções:**
- **Levar ao domínio agora**: acrescentar os dois campos a `WagerTransactionState` e um `scheduleReferenceRetry(now, policy)` reusando o `RetryPolicy` de D-022.
- **O repositório não escreve as colunas**: `insert` deixa valer o `default 0` do banco; `update` toca só o que o domínio possui.

**Decisão:** **o repositório não escreve as colunas.**

**Justificativa:** decidir o dono agora seria decidir por E-13 sem ter lido RF-26 e RN-15 — o caso que `AGENTS.md` §0 nomeia. Não escrever é a única opção que não fecha porta: nenhuma das duas alternativas de E-13 fica mais cara por causa dela. E há um ganho concreto — D-028 já obriga lista fechada de colunas no `update`, então quando E-13 passar a manipular essas colunas, nada do que ela escrever será sobrescrito por um `update` de status vindo de outro caminho.

**Consequências:**
- Os modelos de linha declaram as duas colunas como **opcionais**, para que `em.insert()` não as inclua e o default do banco valha. O mapper não as lê nem as escreve.
- **Decisão pendente, listada na fila:** se as duas colunas viram estado do agregado ou continuam operacionais, manipuladas por `UPDATE` direto como o lease da outbox em E-10. A escolha é de E-13.
- O round-trip de E-06 asserta que as colunas seguem `0` e nulo depois de `insert` e de `update`. Sem esse teste, "o repositório não escreve" seria afirmação, não fato.

---

## D-030 — Saldo do replay: coluna `observed_balance` na transação (2026-09-02)

**Status:** DECIDIDA
**Contexto:** lacuna exposta por E-07. RN-12 exige que repetir uma operação já processada devolva **o resultado original, incluindo o saldo observado naquele momento** — explicitamente "não o saldo atual". Nenhuma coluna do schema de E-05 guarda esse valor. Para uma transação aplicada com movimento ele existe no `balance_after` do lançamento correspondente, mas **rejeição não gera lançamento** (RN-11) e **`LOSS` não gera lançamento** (RN-03): a reconstrução pelo ledger falha exatamente nos casos em que a pergunta é feita.

**Opções:**
- **Coluna própria**: `observed_balance` + `observed_balance_currency` em `wager_transactions`, escritas no desfecho.
- **Reconstrução pelo ledger, com saldo atual nos casos sem lançamento**: sem migration, ao custo de violar a letra de RN-12 em rejeição e `LOSS`.
- **Restringir o contrato**: só transação aplicada com movimento responde `balance`.

**Decisão:** **coluna própria**, em migration nova (`m0002`), com o par valor+moeda e `CHECK` de par-ou-nada.

**Justificativa:** a resposta de uma transação é parte do resultado dela; guardá-la é o que faz o replay **devolver** o resultado original em vez de tentar reconstruí-lo. A reconstrução pelo ledger é derivação indireta que se rompe justamente onde não há lançamento — e o caso sem lançamento não é exótico: é toda rejeição, que é metade do cenário obrigatório da §8. Restringir o contrato resolveria E-07 e voltaria a abrir em E-12, quando `LOSS` precisa responder saldo sem ter movido nada.

**Consequências:**
- `markProcessed` e `reject` passam a **exigir** o saldo observado. É o compilador impondo RN-12: não existe caminho que resolva uma transação sem registrar o saldo que respondeu.
- `fail` e `markPendingReference` **não** o recebem — falha de infraestrutura não é resposta de negócio, e aguardar referência não é desfecho. A coluna fica nula nos dois casos, e **a resposta do `202` de RN-15 continua a ser definida em E-13**.
- Duas colunas, não reuso de `currency`: a moeda do saldo é a **da wallet**, e as duas divergem precisamente na rejeição por `CURRENCY_MISMATCH` — o caso em que ler a coluna errada daria um valor plausível e errado.
- Migration nova em vez de edição da `m0001`: uma migration já aplicada não muda de conteúdo mantendo o nome (RNF-09).
- O par entra no `Pick` de `WagerTransactionUpdate` (D-028), porque é escrito por transição.

---

## D-031 — `WALLET_NOT_FOUND`: erro de aplicação, sem linha e sem evento (2026-09-02)

**Status:** DECIDIDA
**Contexto:** contradição entre documentos, exposta por E-07. D-007 lista `WALLET_NOT_FOUND` entre os códigos de **rejeição de negócio**, e o desenho geral persiste toda rejeição como transação terminal auditável (RN-11, RN-16). Mas a FK `fk_wager_transactions_wallet`, criada em E-05, **impede** inserir uma transação que aponta para wallet inexistente: a rejeição prevista por D-007 não tem como virar linha.

**Opções:**
- **Erro de aplicação**: nada persistido, nenhum evento.
- **Sem linha, mas com evento**: `WagerTransactionRejected` na outbox — `aggregate_id` não tem FK.
- **Relaxar a FK**: migration remove a restrição para que a rejeição fique persistida.

**Decisão:** **erro de aplicação.** `WalletNotFoundError` carrega o `failureCode` de D-007 para o filtro de E-08 responder `422` (D-006); nada é gravado e nenhum evento é publicado.

**Justificativa:** a integridade referencial que RI-09 cobra vale mais do que a uniformidade de "toda rejeição é uma linha" — uma transação apontando para wallet inexistente é dado inválido, não histórico. Publicar evento sem linha seria pior que não publicar: o consumidor receberia um fato sobre um agregado que não existe em lugar nenhum, e a consulta de RF-11 devolveria vazio para um `transactionId` que ele acabou de receber.

**Consequências:**
- `WALLET_NOT_FOUND` e `IDEMPOTENCY_CONFLICT` são os **dois códigos de D-007 que nunca aparecem na coluna `failure_code`** — o primeiro pela FK, o segundo pelo `UNIQUE (idempotency_key)`. É estrutural, imposto por constraint, e vai para `ARCHITECTURE.md` como propriedade do desenho e não como omissão.
- Os dois continuam sendo códigos legítimos do contrato: eles trafegam na resposta, e é lá que o provedor os lê.
- Para o consumidor de E-11, é erro de **negócio terminal** — ack, não retry: reenviar não faz a wallet passar a existir.
- Teste em E-07 prova que nada é gravado e que nenhum evento sai.

---

## D-032 — `payloadHash` calculado no use case, não no caller (2026-09-02)

**Status:** DECIDIDA
**Contexto:** o roteiro põe o hash canônico de D-005 em E-08 (borda HTTP), mas E-07 precisa dele para gravar a transação e para decidir replay contra conflito (RF-14). A pergunta é onde ele nasce.

**Opções:**
- **No use case**, a partir dos campos de negócio do comando.
- **No caller**, com o `payloadHash` entrando pronto no comando.

**Decisão:** **no use case** (`src/application/payload-hash.ts`), a partir do `Money` já validado.

**Justificativa:** RF-18 exige um caminho de processamento único para HTTP e SQS, e RF-14 exige que a mesma operação produza o mesmo hash pelos dois. Com o cálculo no caller, essa igualdade passaria a depender de duas implementações concordarem — e a divergência apareceria como `IDEMPOTENCY_CONFLICT` falso num reenvio legítimo, que é o pior modo de falha possível para o provedor. Antecipa um item de E-08, que passa a apenas ligar o endpoint e testar RT-05.

**Consequências:**
- A lista fechada de D-005 é montada campo a campo no use case, sem espalhar o comando: campo novo não entra no hash por acidente, e metadado de transporte não tem como entrar (§9).
- O hash é calculado do `Money` já validado, não da entrada crua — a forma canônica de D-015 é o que garante um hash por valor.
- **A rejeição de `null` que D-005 pede fica na borda de E-08**, onde o valor ainda é `unknown`. No comando tipado o `null` não tem como chegar, e o guard seria código que o compilador prova inalcançável — o lint com informação de tipos recusa.

---

## D-033 — Identidade da transação `OPENING` interna (2026-09-02)

**Status:** DECIDIDA
**Contexto:** RF-08 exige que saldo inicial maior que zero gere uma transação `OPENING` na mesma transação SQL. Mas `wager_transactions` (E-05) tem `provider_id`, `external_transaction_id`, `idempotency_key`, `payload_hash`, `round_id` e `game_id` **todos NOT NULL** — e a abertura de wallet não tem nenhum deles: não veio de provedor, não tem rodada, não tem jogo e não tem idempotency key de cliente.

**Opções:**
- **Sentinelas internas** para os seis campos, schema intacto.
- **Exigir `Idempotency-Key` em `POST /wallets`**, usando a key do cliente na `OPENING`.
- **Relaxar as colunas** por migration, tornando-as nulas para transações internas.

**Decisão:** **sentinelas internas.** `providerId = "internal"`, `externalTransactionId = walletId`, `roundId = "internal"`, `gameId = "internal"`, `idempotencyKey = "opening:{walletId}"`, e `payloadHash` calculado pelo mesmo `payloadHashOf` de D-005 sobre esses valores.

**Justificativa:** o schema é a fonte da verdade das invariantes (RI-09), e relaxar seis colunas NOT NULL para acomodar o único produtor interno enfraqueceria a garantia para os cinco kinds que vêm de fora — todo leitor, mapper e consumidor passaria a tratar `null` num campo de identidade. Exigir `Idempotency-Key` em `POST /wallets` acrescentaria ao contrato um header que RF-08 não pede, e criaria **dois significados para o `409` do mesmo endpoint**: key repetida e `playerId`+`currency` repetido. O `walletId` como `externalTransactionId` resolve de graça a unicidade de `(provider_id, external_transaction_id)` — é um id único por construção, dentro de um provedor sentinela.

**Consequências:**
- **`internal` passa a ser um `providerId` reservado.** Nada impede um provedor real de se chamar assim; a colisão seria recusada pela unicidade de `(provider_id, external_transaction_id)`, não aceita em silêncio. Vai para `ARCHITECTURE.md` como limitação conhecida.
- A `OPENING` fica consultável por RF-12 como qualquer outra transação (`GET /providers/internal/wagering/transactions/{walletId}`), o que é desejável para auditoria.
- `"opening:{walletId}"` na `idempotency_key` torna a reabertura da mesma wallet impossível por **duas** constraints independentes, não só pela de `(playerId, currency)`.
- RN-13 continua barrando `OPENING` na borda: a factory interna do use case de abertura é a única produtora deste kind.

---

## D-034 — Eventos da abertura de wallet: os dois (2026-09-02)

**Status:** DECIDIDA
**Contexto:** RF-25 lista `WagerTransactionProcessed` para "qualquer transação aplicada" e `WalletBalanceChanged` "somente quando o saldo muda". A abertura de wallet produz uma transação `OPENING` que chega a `PROCESSED` e um lançamento `CREDIT` — mas nenhum provedor a submeteu, e nenhum documento dizia se ela publica.

**Opções:**
- **Os dois eventos.**
- **Só `WalletBalanceChanged`** — o saldo mudou, mas `OPENING` não é operação de aposta.
- **Nenhum** — abertura é gestão de conta, não fluxo de apostas.

**Decisão:** **os dois eventos**, gravados na outbox dentro da mesma transação SQL da abertura.

**Justificativa:** RF-25 é uma tabela sobre **o que aconteceu com o agregado**, não sobre quem pediu. A `OPENING` é uma transação aplicada e o saldo mudou; as duas linhas se aplicam pela letra. E há um ganho estrutural além da letra: com esta decisão, "toda transação que chega a `PROCESSED` tem evento" e "toda mudança de saldo tem `WalletBalanceChanged`" passam a valer **sem exceção** — um consumidor que reconstrói saldo por eventos não precisa saber que a primeira movimentação de cada wallet é especial. Omitir criaria a única transação `PROCESSED` do sistema sem rastro na outbox, e essa exceção teria que ser lembrada por quem escreve E-10, E-11 e a reconciliação de E-14.

**Consequências:**
- Abrir wallet com saldo grava **duas** linhas na outbox, atômicas com a wallet, a transação e o lançamento (RF-23).
- O consumidor precisa tolerar `WagerTransactionProcessed` com `providerId: "internal"` e `kind: "OPENING"` (D-033).
- **Saldo inicial zero não publica nada**: não há transação (RF-08 só gera `OPENING` acima de zero), não há lançamento (RF-04) e o saldo não mudou de valor.

---

## D-035 — Duplicata de wallet: tradução no repositório (2026-09-02)

**Status:** DECIDIDA
**Contexto:** RF-08 exige que wallet duplicada para `(playerId, currency)` falhe como conflito, e D-006 mapeia para `409`. A garantia é o `uq_wallets_player_currency` de E-05 (RI-09), que chega ao código como `UniqueConstraintViolationException` do MikroORM — tipo que `src/application` não pode importar (fronteira de lint de D-028).

**Opções:**
- **Repositório traduz** a exceção do ORM num erro de aplicação.
- **Pré-checagem** por um `findByPlayerAndCurrency` novo no contrato de repositório.
- **Filtro de exceção** reconhece a exceção do ORM direto.

**Decisão:** **o repositório traduz.** `MikroWalletRepository.insert` captura a exceção, confere o nome da constraint e lança `WalletAlreadyExistsError`.

**Justificativa:** a pré-checagem seria `read → check → write` sem lock, e a corrida perdida cairia na constraint de qualquer forma — ela acrescenta uma consulta e um método ao contrato sem eliminar o caminho de tradução. Deixar o filtro reconhecer a exceção do ORM colocaria a regra a três camadas da linha que a viola, e faria a interface importar MikroORM para uma pergunta que só o repositório sabe responder: **qual** UNIQUE foi violado, dado que a mesma exceção cobre cinco constraints diferentes desta base. Traduzir onde a exceção nasce mantém a garantia no banco e o conhecimento do ORM na infraestrutura.

**Consequências:**
- O repositório passa a inspecionar `.constraint` do erro. Verificado em `node_modules`: `DriverException` copia **todas as próprias propriedades** do erro original, então o nome da constraint vindo do `pg` sobrevive à conversão — registrado em `AGENTS.md` §2.1.
- **`WalletAlreadyExistsError` não carrega `failureCode`**, pelo mesmo motivo de `UnsupportedKindError`: os 13 códigos de D-007 estão fechados e nenhum descreve "wallet já existe". Este `409` responde só mensagem, ao contrário do `409` de idempotência, que carrega `IDEMPOTENCY_CONFLICT` (D-031).
- O padrão é reusável: E-12 precisa da mesma tradução para `uq_wager_transactions_reversal_once` (RN-09), onde a corrida perdida também é sinal, e não a mensagem de negócio que o provedor lê (D-024).

---

## D-036 — Desfecho de negócio → status HTTP: função pura na borda (2026-09-02)

**Status:** DECIDIDA
**Contexto:** D-006 fecha o mapa de status e diz que ele "vive num filtro de exceção único". Mas o use case de E-07 devolve um **resultado** para rejeição (`REJECTED`) e para pendência (`PENDING_REFERENCE`) — não uma exceção. Só payload inválido, conflito e falha de infraestrutura chegam à borda como exceção.

**Opções:**
- **Função pura na borda** decide o status do resultado; o filtro cuida só das exceções.
- **Controller lança** uma exceção a partir do resultado, e o filtro único renderiza tudo.
- **Interceptor** pós-processa o retorno do controller e ajusta o status.

**Decisão:** **função pura.** `httpStatusForResult(status)` decide `200`/`202`/`422` a partir do resultado; o filtro de D-006 continua dono das exceções.

**Justificativa:** rejeitar uma aposta por saldo insuficiente é desfecho **esperado e frequente** — RN-11 manda persisti-la como transação terminal auditável. Representá-la como exceção só para atravessar o filtro usaria o mecanismo de erro da linguagem para o caminho normal do negócio, e o custo apareceria no `try/catch` de quem reusar o controller. O interceptor unificaria os dois caminhos, mas esconderia do controller qual status ele responde — o oposto do critério de "se defende em uma frase". A consistência que a §9 cobra é **entre endpoints**, não entre mecanismos: as duas funções vivem no mesmo arquivo e nenhum controller decide status por conta própria.

**Consequências:**
- **Emenda a consequência de D-006:** o mapa vive em `src/interface/http/http-status-map.ts`, com dois pontos de entrada de dono único — resultado e exceção. Endpoint que trate erro localmente continua quebrando a consistência que a §9 cobra.
- O `422` tem **duas formas de corpo**, ambas com `failureCode`: rejeição persistida responde o corpo inteiro de RF-13 (inclusive `transactionId`, que o provedor precisa para consultar); rejeição que não vira linha (D-031, RN-13) responde `{ failureCode, message }`.
- O `202` fica testável antes de existir caminho que o produza: `BET` nunca alcança `PENDING_REFERENCE`, e E-12/E-13 abrem esse caminho sem tocar no mapa.

---

## D-037 — `503` e o destino do erro não mapeado (2026-09-02)

**Status:** DECIDIDA
**Contexto:** D-006 exige `503` em falha transitória de infraestrutura, mas não diz **como** a borda reconhece uma — nem o que responder a uma exceção que não é nenhuma das cinco situações de RF-15 (o mapa não tem `500`). A mesma classificação reaparece em RF-21, onde o consumidor de E-11 escolhe entre retry, DLQ e terminal.

**Opções:**
- **Filtro reconhece** o erro do ORM por lista explícita.
- **Adaptadores encapsulam** em `TransientInfrastructureError` próprio.
- **Tudo não mapeado é `503`**, sem `500` na API.

**Decisão:** **o filtro reconhece**, por uma lista explícita de SQLSTATE transitórios. Exceção fora do mapa responde `500`.

**Justificativa:** "tudo não mapeado é `503`" diria ao provedor "pode reenviar" diante de um bug nosso — e reenviar não conserta bug, então ele gastaria as cinco tentativas de D-008 para chegar ao mesmo lugar. Encapsular nos adaptadores daria a fronteira mais limpa, mas exigiria `try/catch` em cada método de cada repositório, escrito agora para um consumidor (E-11) que ainda não existe, e todo método novo passaria a ter que lembrar do envelope. A lista explícita é curta, auditável e vive num arquivo só.

**Consequências:**
- **A lista:** classe `08` (conexão), `40001` e `40P01` (serialização e deadlock), classe `53` (recursos esgotados), `55P03` (lock indisponível), `57014` (cancelado) e `57P01` (shutdown administrativo), mais os erros de rede sem SQLSTATE (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`).
- A checagem vive em `src/infrastructure/persistence/transient-error.ts`, e **não** junto do filtro: **E-11 reusa a mesma função** para RF-21, e um worker não deve importar da camada de interface.
- Verificado em `node_modules`: o `PostgreSqlExceptionConverter` **não produz** `ConnectionException` nem `LockWaitTimeoutException` — falha de conexão chega como `DriverException` base. Por isso a lista é de SQLSTATE, e não de classes do ORM.
- **`500` passa a existir na API sem estar em D-006, e isso é deliberado:** ele não é uma das cinco situações de RF-15, é a ausência delas.

---

## D-038 — Validação de DTO: parser artesanal (2026-09-02)

**Status:** DECIDIDA
**Contexto:** os corpos de `POST /wallets` e `POST /wagering/transactions` chegam como `unknown` e precisam virar comando tipado. D-005 exige rejeitar `null` nos campos hasheados, D-015 exige recusar escala diferente de duas casas e RF-13 exige `Idempotency-Key`. Não há biblioteca de validação no projeto.

**Opções:**
- **Parser artesanal**, uma função por endpoint.
- **`class-validator` + `class-transformer`** com `ValidationPipe` global.
- **Zod** ou equivalente, com pipe próprio.

**Decisão:** **parser artesanal** — função que recebe `unknown` e devolve o comando tipado, lançando `InvalidPayloadError` (`400`).

**Justificativa:** a validação de **valor** já existe e é do domínio: `Money.from` decide escala (D-015) e forma da moeda (D-016), `WagerTransaction.create` decide a exigência de referência (D-020). O que falta na borda é estritamente forma — é objeto? o campo é string? veio `null`? Um `ValidationPipe` com decorators descreveria o dinheiro num segundo lugar, competindo com `Money.from`, e duas descrições da mesma regra divergem. Some-se que seriam duas dependências fora da stack listada em `AGENTS.md` §2, num projeto cuja orientação explícita é conferir API instalada antes de escrever (§2.1).

**Consequências:**
- Zero dependência nova; o `package.json` continua com o que a stack obrigatória pede.
- O `null` de D-005 é rejeitado num só lugar, onde o valor ainda é `unknown` — fecha o item que D-032 deixou em aberto para esta etapa.
- Um **número** JSON em `money.amount` é recusado por forma antes de chegar ao domínio, o que dá a EL-01 uma barreira na entrada além do lint e da coluna `numeric`.
- Custo assumido: mensagens de erro e cobertura de campo são escritas e testadas à mão.

---

## D-039 — `correlationId` na borda HTTP (2026-09-02)

**Status:** DECIDIDA
**Contexto:** o comando de E-07 exige `correlationId` e RNF-06 exige o campo nos logs, mas nenhum documento dizia de onde a borda HTTP o tira. O enunciado não define header de correlação.

**Opções:**
- **Header opcional com fallback** gerado na borda.
- **Sempre gerado**, header ignorado.
- **Header obrigatório**, ausência é `400`.

**Decisão:** **`X-Correlation-Id` quando o provedor manda; senão gerado na borda.** O valor usado é devolvido no mesmo header da resposta.

**Justificativa:** RNF-06 quer rastro, não um segundo header obrigatório em RF-13 — que já tem o `Idempotency-Key`. Gerar sempre por conta própria quebraria o rastro de quem já correlaciona do seu lado, que é justamente o provedor mais maduro. Ecoar o valor na resposta é o que torna o rastro utilizável sem documentação extra: o provedor descobre o id mesmo quando não mandou nenhum.

**Consequências:**
- O `correlationId` é **entrada não confiável** quando vem do header: vai para log e para o envelope do evento, nunca para consulta SQL nem para decisão de negócio.
- A geração usa o `IdGenerator` de D-014, não `crypto.randomUUID()` — um id só, uma fonte.
- E-11 preenche o mesmo campo a partir do envelope da mensagem: a correlação atravessa HTTP → outbox → SQS → consumidor sem trocar de dono.
