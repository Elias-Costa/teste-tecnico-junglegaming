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

**Vazia.** As 15 decisões que o enunciado delegava ao candidato foram fechadas em 2026-09-01, antes de existir código de produção, e a elas se somam **D-016** e **D-017** — expostas por E-02 e resolvidas antes de o `Money` ser escrito. **Nenhuma etapa do `implementation-plan.md` está bloqueada.**

A fila continua valendo daqui em diante: se a implementação expuser uma decisão não prevista — como aconteceu com D-015 (escala de entrada) e com os códigos de infraestrutura de D-007, ambos descobertos ao detalhar outra decisão, e como voltou a acontecer em E-02 com a validação de `currency` (D-016) e o comportamento de `equals` (D-017) — ela entra aqui e **para a etapa**, conforme `AGENTS.md` §0. Fila vazia não significa que não vão surgir mais.

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
- O mapeamento vive num **filtro de exceção único**, aplicado a todos os endpoints. Endpoint que trate erro localmente quebra a consistência que a §9 cobra explicitamente.
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
- **UUIDv7 passa a ser o padrão de id em todas as tabelas**, não só no ledger. Esta decisão extrapola RF-10 e precisa valer em E-05 inteira.
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
