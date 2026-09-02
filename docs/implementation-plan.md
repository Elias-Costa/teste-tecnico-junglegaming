# Roteiro de Implementação

Ordem oficial de implementação. Cada etapa é pequena, tem escopo fechado, critério de conclusão verificável e aponta o que ler antes de codar. O agente trabalha **uma etapa por vez**, sem inventar escopo e sem depender de memória de sessões anteriores.

Documentos-fonte: `docs/desafio-original.md` (enunciado), `docs/requirements.md` (requisitos), `docs/decisions.md` (decisões). Este roteiro **não substitui** nenhum deles — em caso de conflito, pare e reporte (`AGENTS.md` §0).

---

## Estado atual

> **E-00 a E-08 CONCLUÍDAS** (E-08 em 2026-09-02). Stack validada de ponta a ponta, fundação de pé, núcleo de negócio fechado com teste, camada de mensageria do domínio pronta, schema no banco com as garantias de RI-09, os cinco agregados indo e voltando do PostgreSQL real, o caminho do dinheiro fechado numa transação SQL única com atomicidade provada contra falha real do banco, e **os dois endpoints de escrita de pé, com as cinco situações de RF-15 em cinco códigos distintos**.
> `bun run check` = typecheck limpo, lint limpo, **236 unitários verdes**. `bun run check:full` = mais **102 de integração**, autoprovisionados.
> **Etapa atual: E-09 — PROVA DE CONCORRÊNCIA (meta do dia 1).**
>
> **Achados do spike que valem para todas as etapas seguintes:**
> - MikroORM v7 **não tem decorators** — mapeamento por `EntitySchema`. Isso torna a fronteira domínio/ORM estrutural em vez de convencional.
> - `Bun.randomUUIDv7()` é nativo — D-014 não precisa de biblioteca.
> - LocalStack a partir da linha 2026.x **exige token de licença**; fixado em `4.14.0`, o último community.
> - PostgreSQL nativo do Windows ocupa a 5432 — o Compose publica em **55432**.
>
> **O que E-02 deixou para as etapas seguintes:**
> - `Money` é o único caminho de dinheiro no domínio: `from()` (contrato de entrada, valida) e construtor privado (aritmética e `negate`, não revalida). Nada além disso constrói valor monetário.
> - As quatro operações binárias — `add`, `subtract`, `isLessThan`, `equals` — lançam `CurrencyMismatchError` entre moedas diferentes (D-017). O check de moeda precisa vir **antes** do de valor nas regras de RN-10.
> - `InvalidMoneyError` cobre valor e moeda malformados; D-006 mapeia os dois para `400`.
> - A guarda de lint de EL-01 foi reverificada com sonda: dispara em `src/domain/`.
>
> **O que E-03 deixou para as etapas seguintes:**
> - **`Wallet.debit`/`credit` devolvem o `WalletLedgerEntry` (D-018)** e `Wallet.open` devolve `{ wallet, openingEntry }`. E-06 persiste o lançamento devolvido; E-07 e E-08 o gravam na **mesma** transação SQL da wallet (RF-23). Descartar o retorno é descartar o ledger.
> - **Ids e instantes são injetados**, nunca gerados no domínio: `entryId`, `transactionId`, `openingEntryId`, `at`. Quem chama `Bun.randomUUIDv7()` (D-014) é a camada de aplicação.
> - **Saldo insuficiente tem dois caminhos por decisão (D-019):** `hasSufficientBalanceFor()` é o caminho de negócio de E-12, que escolhe entre `INSUFFICIENT_FUNDS` e `INSUFFICIENT_FUNDS_ON_REVERSAL` (RN-16); a exceção de `debit` é guarda, não fluxo.
> - **`reject` e `fail` têm tipos de código diferentes.** `reject(BusinessFailureCode)` e `fail(InfrastructureFailureCode)` — a separação de D-013 é imposta pelo compilador, então o consumidor de E-11 não consegue marcar `FAILED` com código de negócio.
> - **Dois erros novos vão para o mapa de `400` em E-08:** `MissingReferenceError` (D-020) e `InvalidLedgerEntryError` quando o valor da movimentação é zero (D-021). Somam-se a `InvalidMoneyError`.
> - `NoLedgerDirectionError` marca uso indevido: `ledgerDirectionFor()` em `LOSS`, ou em `ROLLBACK` sem a referência resolvida. E-12 consulta `affectsBalance()` antes e resolve a referência antes.
> - A unicidade `(playerId, currency)` **não está no agregado** — é invariante entre agregados e depende do `UNIQUE` de E-05 (RI-09).
>
> **O que E-04 deixou para as etapas seguintes:**
> - **E-05 cria as colunas que as entidades já esperam:** na outbox, `attempts`, `next_attempt_at`, `published_at`, `locked_by` e `locked_until` (D-009); na inbox, o `UNIQUE (consumer_name, message_id)` — a entidade **não tem id próprio** de propósito, a identidade é o par.
> - **O `payload` da outbox é o `toJSON()` do evento, já serializado.** A linha precisa sobreviver a mudanças de código: republicar reidratando a classe de evento de seis meses atrás acoplaria a fila ao código vigente. A coluna é `jsonb`.
> - **`scheduleRetry(now, policy)` recebe a política (D-022).** A curva é do domínio, os números são da infra. E-10 preenche `RetryPolicy` a partir do ambiente com os defaults de D-008, e o mesmo tipo serve aos outros dois loops (DLQ de E-11, referências de E-13) — não criar uma segunda curva.
> - **`markPublished` e `markProcessed` não guardam contra remarcação.** É deliberado: D-009 assume entrega at-least-once e RF-19 resolve reentrega por `isProcessed()` no início do consumo, não por exceção. Quem transformar isso em transição guardada quebra o caminho normal de E-10 e E-11.
> - **`isDue` olha só `nextAttemptAt`; a disputa pelo lease é do banco.** E-10 usa `SKIP LOCKED` no subselect do claim; `isClaimed(now)` existe para leitura e teste, não para decidir quem publica.
> - **Ficou em aberto para E-10, por não ser do domínio:** se o `UPDATE` que marca `published_at` também limpa `locked_by`/`locked_until`. A entidade não limpa, para não divergir do SQL que ainda não existe.
> - **`WagerTransactionRejected.from` recebe o `BusinessFailureCode` por parâmetro**, não lê `transaction.failureCode` — o getter é a união com os códigos de infraestrutura, e o parâmetro tipado é o que faz o compilador impor RF-25.
>
> **O que E-05 deixou para as etapas seguintes:**
> - **O schema já existe e é a fonte da verdade das invariantes.** E-06 mapeia contra tabelas prontas; qualquer coluna que o `EntitySchema` inventar não existe no banco. Nomes: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`.
> - **Ids não têm `DEFAULT` no banco (D-014).** Todo `insert` precisa trazer o `Bun.randomUUIDv7()` da camada de aplicação. Um id ausente vira `23502`, não um UUID gerado pelo banco — e isso é deliberado: `gen_random_uuid()` é v4 e quebraria o cursor de RF-10 sem ninguém ver.
> - **`inbox_messages` tem chave primária composta** `(consumer_name, message_id)` e nenhuma coluna `id` (D-025). O mapeamento de E-06 precisa declarar PK composta.
> - **O ledger é imutável no banco por trigger (D-023).** Qualquer `UPDATE`/`DELETE` que E-06 ou E-12 emitirem sobre `wallet_ledger_entries` — inclusive um flush do ORM tentando "atualizar" uma entidade suja — morre com `P0001`. O ledger só aceita `insert`.
> - **A unicidade de reversão é parcial sobre `PROCESSED` (D-024).** E-12 continua responsável por rejeitar com `ALREADY_REVERSED` no caminho de negócio; a violação de unicidade é sinal de corrida perdida, não a mensagem que o provedor lê.
> - **O lease da outbox é par-ou-nada.** O `UPDATE` de claim de E-10 escreve `locked_by` e `locked_until` juntos, e quem limpar um precisa limpar o outro — inclusive o `UPDATE` que marca `published_at`, cuja forma continua em aberto para E-10.
> - **`numeric` volta como string do driver**, travado por teste em E-05. O mapper de E-06 recebe string e não pode assumir `number` em ponto nenhum (D-004, EL-01).
> - **`payload` da outbox é `jsonb`** e é consultável por `->>`. O `attempts` e o `reference_attempts` têm `CHECK >= 0`.
> - **Ficou de fora de propósito, por não ser escopo desta etapa:** nenhum comando de linha de comando para rodar migration. Hoje o `up` só acontece dentro do teste de RT-08 e nos dois testes novos de E-06. A etapa que sobe a aplicação (E-14/E-15) precisa expor isso, senão o avaliador não tem como aplicar o schema do zero — e o README é entregável avaliado.
>
> **O que E-06 deixou para as etapas seguintes:**
> - **Repositório é objeto de transação, não singleton (D-028).** Cada um recebe o `EntityManager` no construtor, e o que vale é o **forkado** que `em.transactional()` entrega. E-07 constrói os cinco dentro do callback da transação; construí-los fora faria as escritas acontecerem em autocommit, que é a forma silenciosa de quebrar RF-23. O padrão está em `repositoriesOn()` no teste de round-trip.
> - **A ordem dos `INSERT` é a ordem do código.** Sem Unit of Work não há commit order calculado, então quem escreve o use case é quem garante wallet → transação → ledger. Inverter dá `23503`, não erro silencioso — mas dá em runtime, não em compilação.
> - **`findByIdForUpdate` é o único ponto que trava wallet (D-002, RI-06).** Toda operação que vai mexer em saldo entra por ele; `findById` é leitura de RF-09 e não bloqueia ninguém. Um segundo lugar que emita `FOR UPDATE` sobre `wallets` é violação de RI-06 por dispersão — é o que uma revisão de E-07/E-09 precisa procurar.
> - **`WalletLedgerRepository` não tem `update` nem `delete`, e não é esquecimento.** É a terceira camada de EL-07, junto da entidade imutável e da trigger de D-023. Acrescentar um método de mutação ali é desfazer a decisão, não completar a interface.
> - **Toda leitura desliga o identity map.** Consequência de D-028: nenhuma linha lida fica gerenciada, então `flush()` não tem o que emitir. Quem introduzir `em.persist()` no caminho de escrita reintroduz o rastreamento e volta a expor o ledger ao `P0001`.
> - **`update` escreve lista fechada de colunas**, tipada por `Pick<...>` em cada mapper. Campo novo no agregado **não** é persistido automaticamente: precisa entrar no `Pick`. O round-trip é o que denuncia o esquecimento.
> - **`reference_attempts` e `next_reference_attempt_at` continuam sem dono (D-029).** O repositório não as escreve, e há teste provando. **A decisão é de E-13** e está na fila de `docs/decisions.md`.
> - **`WagerTransaction` não tem finder por `idempotencyKey` nem por `(providerId, externalTransactionId)`.** Ficou de fora por escopo: E-06 entrega o round-trip, e esses dois caminhos de leitura são de RF-12/RF-14, que E-07 e E-08 implementam. As constraints únicas já existem no schema.
>
> **O que E-07 deixou para as etapas seguintes:**
> - **O use case é a fronteira de validação, e E-08 é só a borda.** `Money.from`, a lista fechada do `payloadHash` (D-032) e a guarda de kind acontecem **antes** de abrir a transação. E-08 monta o comando a partir do corpo HTTP e traduz exceção em status (D-006) — não revalida nada, e revalidar criaria duas regras para a mesma coisa.
> - **O `null` de D-005 ainda não é rejeitado em lugar nenhum.** No comando tipado ele não chega, e o guard seria código inalcançável. **É item de E-08**, na validação de DTO, onde o valor ainda é `unknown`.
> - **A ordem de consumo de ids é contrato de teste.** `RT-09` injeta falha pela posição da chamada (`transação → lançamento → evento → outbox`). Mudar a ordem das escritas quebra os testes de propósito: a ordem **é** a garantia de FK de RF-23.
> - **`recordInbox` grava, mas não pergunta.** Uma reentrega do mesmo `messageId` hoje colide com a PK de D-025 e aborta a transação inteira — o efeito no dinheiro continua único (EL-03), mas **quem transforma isso em "pular e dar ack" é E-11** (RF-19). O teste que prova o rollback já existe.
> - **`WagerTransactionPendingReference` não é publicado por este use case.** `BET` nunca vai para `PENDING_REFERENCE`; o evento existe desde E-04 e ganha emissor em E-12/E-13.
> - **O saldo da resposta de `202` (RN-15) continua em aberto.** `markPendingReference` não observa saldo (D-030), então a coluna fica nula e o replay cai no saldo corrente da wallet travada. **É decisão de E-13**, junto com D-029.
> - **`UnsupportedKindError` é limite de etapa, não regra.** E-12 abre `WIN`/`LOSS`/`REFUND`/`ROLLBACK` no mesmo use case; `OPENING` vira `KIND_NOT_SUBMITTABLE` na borda de E-08 (RN-13). Ele **não** carrega `failureCode` — nenhum dos 13 códigos descreve "ainda não implementado".
> - **O lock vem antes da consulta de idempotência**, e E-09 depende disso: é o `FOR UPDATE` da wallet que serializa a decisão de replay, e é por isso que RT-14 (50 apostas iguais em paralelo) deve ver replays limpos em vez de violação de unicidade no caminho normal.
>
> **O que E-08 deixou para as etapas seguintes:**
> - **O mapa de status é um arquivo só, e mexer nele é mexer em RF-15.** `httpStatusForResult` (resultado) e `httpProblemFor` (exceção) vivem lado a lado de propósito: as cinco situações da §9 só se conferem lendo as duas metades juntas. Endpoint novo em E-14 **não** trata erro localmente — quem quebrar isso quebra a consistência que o enunciado cobra explicitamente.
> - **`isTransientDatabaseError` é de E-11 tanto quanto é de E-08.** Está em `src/infrastructure/persistence/transient-error.ts`, e não junto do filtro, porque RF-21 precisa exatamente da mesma classificação para decidir retry contra DLQ. **Não criar uma segunda lista** — é o mesmo erro de duas curvas de backoff que D-022 evitou.
> - **`UnsupportedKindError → 501` é temporário e E-12 o remove.** Quando `WIN`/`LOSS`/`REFUND`/`ROLLBACK` passarem a ser processados, o erro deixa de ser lançado e o ramo do mapa vira código morto. O teste que hoje espera `501` num `WIN` é o lembrete.
> - **`internal` é um `providerId` reservado (D-033)** e aparece em `GET /providers/internal/...` quando E-14 ligar RF-12. A consulta funciona e devolve a `OPENING`; é auditoria legítima, não vazamento.
> - **O consumidor de E-11 vai ver `WagerTransactionProcessed` com `kind: "OPENING"`** e `providerId: "internal"` (D-034). Quem escrever o consumidor precisa tolerar isso — é o preço de a invariante "toda transação aplicada tem evento" não ter exceção.
> - **`POST /wallets` não exige `Idempotency-Key`, e isso foi decisão (D-033).** A proteção contra reabertura são as duas constraints — `uq_wallets_player_currency` e a `idempotency_key` derivada do `walletId`. Uma retentativa de rede sobre `POST /wallets` responde `409`, não abre wallet duplicada.
> - **Não existe `main.ts`.** O `AppModule` está de pé e é exercitado pelos testes numa porta efêmera, mas **ninguém sobe o processo ainda** — nem há comando de linha para aplicar migration. Isso é de E-14/E-15, e o README é entregável avaliado: um avaliador que clone o repositório hoje não tem como subir a API.
> - **A fronteira de lint agora cobre `src/interface/**`** (veto a `@aws-sdk/*`). O MikroORM continua permitido lá, porque é a camada que monta o grafo de dependências.
> - **`registerRequestContext: false`** no `MikroOrmModule`: o middleware de identity map por requisição é justamente o que D-028 removeu. Ligá-lo reexporia o ledger ao `P0001` da trigger de D-023.
> - **RN-11 tem prova de ponta a ponta agora:** rejeição por saldo insuficiente responde `422` com corpo de RF-13 e **zero** lançamentos no ledger.
>
> **Decisões em vigor:** D-001 MikroORM **sem plano B** · D-003 `Money` sobre **`bigint` de centavos** · D-004 coluna **`numeric(19,2)`** + mapper próprio · D-007 (13 `failureCode` fechados) · D-009 (outbox por claim com lease) · D-011 infra de teste **híbrida** · D-012 auth **não implementada** · D-013 (grafo sem self-loop; `FAILED` só em erro permanente ou DLQ) · D-014 (ids UUIDv7, cursor keyset de coluna única) · D-015 (escala de entrada exatamente 2 casas) · D-016 (`currency` validada por forma `[A-Z]{3}`, sem tabela ISO) · D-017 (`equals` lança em moeda diferente) · **D-018** (`debit`/`credit` devolvem o lançamento) · **D-019** (saldo insuficiente: consulta + guarda) · **D-020** (referência ausente é payload inválido) · **D-021** (movimentação exige valor estritamente positivo) · **D-022** (backoff equal jitter, política injetada na chamada) · **D-023** (imutabilidade do ledger por trigger) · **D-024** (unicidade de reversão parcial sobre `PROCESSED`) · **D-025** (PK composta na inbox; alcance de D-014 corrigido) · **D-026** (mapeamento por modelos de linha + mapper, não sobre as classes de domínio) · **D-027** (interfaces de repositório no domínio) · **D-028** (escrita por comando explícito, sem Unit of Work) · **D-029** (colunas de retry de referência sem dono até E-13) · **D-030** (saldo observado em coluna própria) · **D-031** (`WALLET_NOT_FOUND` é erro de aplicação, sem linha e sem evento) · **D-032** (`payloadHash` calculado no use case) · **D-033** (sentinelas internas na `OPENING`) · **D-034** (abertura publica os dois eventos) · **D-035** (duplicata de wallet traduzida no repositório) · **D-036** (desfecho é resultado, não exceção — emenda D-006) · **D-037** (`503` por lista de SQLSTATE; não mapeado é `500`) · **D-038** (parser artesanal, sem biblioteca de validação) · **D-039** (`correlationId` por header com fallback).
>
> Também decidido: D-002 (pessimistic `FOR UPDATE` por wallet) · D-005 (SHA-256 sobre lista fechada de 10 campos) · D-006 (`400`/`409`/`422`/`202`/`503`) · D-008 (defaults conservadores e configuráveis por ambiente).
>
> D-010 (`prom-client` em `GET /metrics`).
>
> **Fila com um item, que só bloqueia E-13** — o dono de `reference_attempts`/`next_reference_attempt_at`, aberto por D-029. **Nenhuma etapa até E-12 está bloqueada.** As 15 decisões que o enunciado delegava estão fechadas e registradas, mais D-016 e D-017 (expostas por E-02), D-018 a D-021 (expostas por E-03), D-022 (exposta por E-04), D-023 a D-025 (expostas por E-05) e D-026 a D-029 (expostas por E-06), todas fechadas pelo mantenedor antes de o código ser escrito. Se a implementação expuser uma decisão não prevista, ela **para a etapa** e vai para `docs/decisions.md` (`AGENTS.md` §0).

---

## Como usar este roteiro (regras para o agente)

1. **Uma etapa por vez, na ordem.** Não iniciar a próxima com a atual incompleta ou com `bun run check` falhando.
2. **Releia antes de codar.** No início de cada etapa, leia os requisitos listados em "Ler antes" no repositório atual. Não implemente de memória.
3. **Escopo estrito.** Implemente só o que a etapa descreve. Se notar algo faltando, registre a sugestão e pergunte — não "aproveite para" adicionar.
4. **Não escreva API de biblioteca de memória.** `AGENTS.md` §2.1. Confira a versão em `package.json` e consulte a doc oficial daquela versão.
5. **Decisão em aberto = parar.** Se a etapa depende de um `[DECISÃO: D-XXX]` não resolvido, pare e pergunte.
6. **Bloqueio externo = parar.** Container que não sobe, porta ocupada, imagem que não baixa. Nunca criar mock para destravar (EL-08).
7. **Ao concluir:** rodar o check, colar a saída, marcar o checkbox, atualizar o "Estado atual", citar os RF/RN atendidos e sugerir os commits da etapa — uma mudança ou várias, conforme os três testes de `AGENTS.md` §5.1.

---

# DIA 1 — Fundação, domínio e prova de concorrência

O objetivo do dia 1 não é "ter muita coisa pronta". É **fechar as falhas eliminatórias mais caras (EL-01, EL-02, EL-03, EL-05) com teste verde**. Tudo que vem depois é adição sobre uma base provada.

## E-00 — Spike de compatibilidade `[timebox: 2h — não estender]`

Não é arquitetura. É descobrir, na hora 2 e não na hora 40, se a stack fecha.

**Ler antes:** `docs/decisions.md` D-001, D-011.
**Escopo:**
- [x] Bun 1.x + NestJS bootando. — Bun 1.4.0; DI por construtor resolvendo com `experimentalDecorators` + `emitDecoratorMetadata`.
- [x] Docker Compose com PostgreSQL + LocalStack (SQS) de pé.
- [x] **MikroORM** conectando ao Postgres real, com uma entidade descartável. Versões `@mikro-orm/*` fixadas exatas, sem `^` (D-001). — v7.1.14.
- [x] **Confirmar no SQL efetivamente emitido** que `LockMode.PESSIMISTIC_WRITE` produz `SELECT ... FOR UPDATE`. — confirmado; `PESSIMISTIC_PARTIAL_WRITE` produz `FOR UPDATE SKIP LOCKED`, que serve a D-009.
- [x] **Testcontainers subindo Postgres sob `bun test`** — principal risco técnico remanescente do spike (D-011). — funciona; a metade Testcontainers de D-011 está viável.
- [x] Módulo único de configuração de conexão, lido do ambiente, servindo tanto ao Compose quanto ao Testcontainers (D-011). — `src/spike/db-env.ts`, a ser promovido para `src/infrastructure` em E-01.
- [x] **Verificar se o runtime tem gerador nativo de UUIDv7.** — `Bun.randomUUIDv7()` existe; **nenhuma biblioteca necessária** para D-014.
- [x] Uma fila FIFO criada no LocalStack e uma mensagem enviada/recebida. — via `@aws-sdk/client-sqs`, com `MessageGroupId`/`MessageDeduplicationId`.
- [x] **Um** teste de integração verde sob `bun test`, contra o banco real. — 8 testes em 3 arquivos, `tsc --noEmit` limpo.

**Critério de conclusão:** o teste roda do zero, autoprovisionado, sem nenhum mock envolvido.

**Se falhar:**
- **Se o bloqueio for o MikroORM:** D-001 não tem plano B. **Não trocar de ORM.** Registrar o erro concreto em `docs/decisions.md` e escalar para o mantenedor.
- **Se o bloqueio for o Testcontainers:** o fallback aceito é rodar a suíte contra o Compose fixo e registrar a redução de escopo de D-011 em `ARCHITECTURE.md`. Esta é a única metade de D-011 que pode ceder.

## E-01 — Fundação do repositório

**Ler antes:** `AGENTS.md` §2, §4; `docs/requirements.md` §5.
**Escopo:**
- [x] `tsconfig.json` estrito, sem `any` permitido. — `strict` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` e `noImplicitOverride`; lint em `strictTypeChecked`, com informação de tipos, o que habilita `no-floating-promises`.
- [x] ESLint com **regra `no-restricted-syntax`** banindo `Number()`, `parseFloat`/`parseInt`, `.toFixed()` e `Math` — torna EL-01 inintroduzível por lint. Escopo: **todo `src/`**, com exceção estreita apenas em `src/infrastructure/config/`, onde porta e limite de retry são inteiros de configuração e não dinheiro. Cada mensagem cita a decisão de origem.
- [x] **Regra de fronteira** (`no-restricted-imports`) proibindo `@mikro-orm/*`, `@nestjs/*`, `@aws-sdk/*`, `pg` e `prom-client` em `src/domain/`, mais imports das camadas de fora. Não estava previsto na etapa; adicionado porque a v7 sem decorators cobre metade de RF-01 e esta regra cobre a outra metade.
- [x] Scripts: `check` (typecheck + lint + unit) e `check:full` (`check` + integração + concorrência, com o preload do Testcontainers). **São o gate de toda etapa seguinte.**
- [x] Estrutura de pastas com fronteira explícita: `src/domain`, `src/application`, `src/infrastructure`, `src/interface`.
- [x] `docker-compose.yml` versionado com Postgres + LocalStack, para o loop de desenvolvimento. — feito em E-00.
- [x] Setup de Testcontainers usado por `check:full`, apoiado no **módulo único de configuração de conexão** (D-011). — `tests/support/testcontainers-setup.ts`, carregado por `--preload`; popula as mesmas variáveis que o Compose popula.
- [x] Código do spike removido; `db-env.ts` promovido para `src/infrastructure/config/database-env.ts`, com `sqs-env.ts` no mesmo padrão.

**Critério de conclusão — atendido:**
- `bun run check` passa: `tsc --noEmit` limpo, `eslint .` limpo, 4 testes unitários verdes.
- A regra reprova de fato: um arquivo de prova em `src/domain/` com `parseFloat`, `Number(bigint)`, `Math.round`, `.toFixed()` e import de `@mikro-orm/postgresql` produziu **5 erros**, um por violação, cada um citando a decisão. O arquivo foi removido depois da verificação.
- `bun run check:full` roda com o Compose **derrubado**: o preload provisiona PostgreSQL e LocalStack e os testes de integração passam sem saber quem provisionou — que é o critério de D-011.

## E-02 — Domínio: `Money`

**Ler antes:** RF-01, RI-01, EL-01, RT-01; D-003, D-004, D-015, D-016, D-017.
**Escopo:**
- [x] Value object imutável sobre `bigint` de centavos, com factories, operações, comparações e serialização (RF-01, D-003). **Zero dependência externa para dinheiro.** — `src/domain/money.ts`.
- [x] Escala 2 numa constante única (`SCALE_FACTOR = 100n`), com comentário citando §6.1 do enunciado como origem da premissa.
- [x] **Parse por regex é a única porta de entrada.** `Money.from()` exige exatamente 2 casas decimais, sem zeros à esquerda, no máximo 17 dígitos inteiros (D-015) e só então monta o `bigint`.
- [x] **`negate()` não passa por `from()`** — constrói pelo construtor privado, sem revalidar, para o lançamento invertido do `ROLLBACK` (RN-05). Mesma justificativa se aplica a `add` e `subtract`: aritmética exata pode dar negativo legítimo.
- [x] **Formatação sem `Number` em ponto nenhum**: divisão e resto sobre `bigint`, sinal por comparação (`< 0n`, não `Math.abs`) e `padStart(2, "0")`.
- [x] O `bigint` nunca sai do domínio: `toJSON()` devolve `MoneyProps` com string, e um teste garante que `JSON.stringify(money)` não lança.
- [x] Erro de domínio para conflito de moeda. — `CurrencyMismatchError`, carregando as duas moedas; mais `InvalidMoneyError` para entrada rejeitada, um tipo só para valor e moeda porque D-006 mapeia ambos para `400`.
- [x] Testes unitários RT-01 e RT-04. — 54 testes em `tests/unit/money.test.ts`.
- [x] **Duas decisões novas, expostas pela etapa e fechadas antes do código:** D-016 (validação de `currency` por forma `[A-Z]{3}`) e D-017 (`equals` lança em moeda diferente). Não estavam previstas no escopo original desta etapa.

**Critério de conclusão — atendido:**
- `bun run check` passa: `tsc --noEmit` limpo, `eslint .` limpo, **58 testes unitários verdes** (4 de E-01 + 54 de `Money`).
- RT-01 cobre `"NaN"`, `"Infinity"`, `"2.5e1"`, `""`, `"1.005"`, `"-5.00"`, `"25"`, `"25.5"` e `"025.00"` como rejeitados em `from()`, mais `.50`, `1.`, `+1.00`, `1,00`, `0x19`, espaço nas pontas e 18 dígitos inteiros (o teto de `numeric(19,2)` é 17), e `negate()` produzindo negativo válido.
- RT-04 exercita as quatro operações binárias entre `BRL` e `USD`, mais o caso simétrico de não lançar dentro da mesma moeda.
- Zero import de ORM, NestJS ou biblioteca decimal no arquivo — a regra de fronteira de E-01 vale sobre ele.
- **EL-01 provada, não afirmada:** uma sonda com `Number(1n)`, `.toFixed()`, `Math.round()` e `parseFloat()` em `src/domain/` produziu 4 erros de lint, um por violação; a sonda foi removida depois da verificação. Do lado do teste, `"0.10" + "0.20"` dá exatamente `"0.30"` e `"99999999999999.99" + "0.01"` atravessa 2^53 centavos sem perda.

## E-03 — Domínio: `Wallet`, `WagerTransaction`, `WalletLedgerEntry`

**Ler antes:** RF-02, RF-03, RF-04, RN-01..RN-17, RT-02, RT-03, RT-06, RT-07; D-013.
**Escopo:**
- [x] `Wallet` com construtor privado, `open`/`rehydrate`, `debit`/`credit`, invariantes (RF-02). — `src/domain/wallet.ts`.
- [x] `WagerTransaction` com o grafo fechado de D-013 — **sem self-loop e sem volta para `PENDING`** — e as consultas de domínio (RF-03). — `ALLOWED_TRANSITIONS` é fonte única: `isTerminal()` é "não tem transição de saída", não uma segunda lista.
- [x] `markPendingReference()` válida **apenas** a partir de `PENDING`; chamá-la sobre `PENDING_REFERENCE` lança `InvalidTransactionStateError`. O reagendamento é `UPDATE` de colunas, não transição (D-013).
- [x] `WalletLedgerEntry` estruturalmente imutável, com `isBalanced()` validado na factory (RF-04).
- [x] Enum fechado `FailureCode` com os **13 códigos** de D-007: 11 de rejeição por regra de negócio + `PERMANENT_INFRASTRUCTURE_ERROR` e `MAX_RETRIES_EXHAUSTED` para o status `FAILED`. — dois enums (`BusinessFailureCode`, `InfrastructureFailureCode`) unidos por `type FailureCode`, o que faz o compilador impor a separação de D-013 em `reject`/`fail`.
- [x] Testes RT-02, RT-03, RT-06, RT-07. — 69 testes em 3 arquivos.
- [x] **Quatro decisões novas, expostas pela etapa e fechadas antes do código:** D-018 (retorno de `debit`/`credit`, delegado em texto pela §6.2), D-019 (saldo insuficiente: consulta + guarda), D-020 (referência ausente é payload inválido) e D-021 (movimentação exige valor estritamente positivo). Não estavam previstas no escopo original desta etapa.

**Critério de conclusão — atendido:**
- `bun run check` passa: `tsc --noEmit` limpo, `eslint .` limpo, **127 testes unitários verdes** (58 de E-01/E-02 + 69 de E-03).
- **RT-02**: `version` nasce em `1`, não muda em nenhuma leitura de estado e incrementa a cada `debit`/`credit`. O teste que fecha a regra é o das quatro recusas — saldo insuficiente, moeda divergente, valor zero e valor negativo —, que verifica saldo, `version` e `updatedAt` intactos em todas: é no caminho de erro que "incrementa só quando o saldo muda" costuma quebrar sem ninguém ver.
- **RT-07**: matriz completa 5 status × 4 transições, montada a partir do grafo transcrito de D-013 e não do código sob teste; os três terminais recusam as quatro transições, e `markPendingReference()` sobre `PENDING_REFERENCE` lança com `from`/`to` corretos.
- **RT-06**: `isBalanced()` nas duas direções, recusa de lançamento desbalanceado, de direção invertida sobre valores válidos, de valor zero, de valor negativo e de moedas divergentes. Mais um teste estrutural: `WalletLedgerEntry.prototype` não expõe nenhum método além de `isBalanced` — falha no dia em que alguém acrescentar um mutador, que é o dia em que RI-05 seria violada.
- **RT-03** na parte que é de domínio: `affectsBalance` falso só para `LOSS`, `requiresReference` verdadeiro só para `REFUND`/`ROLLBACK`, e `ledgerDirectionFor` com `ROLLBACK` invertendo `BET`, `WIN` e `REFUND` (RN-05).
- **Invariante final de §6.4 dos requisitos**: uma sequência `OPENING → BET → WIN → REFUND` reconstrói o saldo a partir dos lançamentos devolvidos e compara com `wallet.balance`.
- **EL-02 provada, não afirmada:** `debit` recusa débito acima do saldo **sem consulta prévia** e deixa a wallet intacta — o agregado não tem caminho permissivo, independentemente do que o use case fizer. A prova sob concorrência real é de E-09; esta é a prova de que não há brecha na unidade.
- **EL-07:** lançamento imutável por estrutura, aritmética validada na factory e saldo reconstruível pelo ledger.
- **EL-01:** nenhum `Number`/`toFixed`/`Math`/`parseFloat` entrou — toda aritmética passa por `Money`, e `bun run lint` roda a regra de E-01 sobre os três arquivos novos.

## E-04 — Domínio: mensageria e eventos

**Ler antes:** RF-05, RF-06, RF-07, RF-25.
**Escopo:**
- [x] `InboxMessage` e `OutboxMessage` (RF-05, RF-06), incluindo `scheduleRetry` com a curva de D-008 e os campos de lease (`lockedBy`, `lockedUntil`) exigidos por D-009. — `src/domain/inbox-message.ts`, `src/domain/outbox-message.ts`.
- [x] `IntegrationEvent` **abstrata** + as quatro subclasses concretas de RF-25, com `eventType` e `version` no tipo. — `src/domain/events/`.
- [x] `toJSON()` com envelope estável; `data` carregando `MoneyProps`, nunca `Money`.
- [x] **Uma decisão nova, exposta pela etapa e fechada antes do código:** D-022 (forma da curva de backoff e como a política chega ao domínio). D-008 fixava os limites, não a curva. Não estava prevista no escopo original desta etapa.

**Critério de conclusão — atendido:**
- `bun run check` passa: `tsc --noEmit` limpo, `eslint .` limpo, **174 testes unitários verdes** (127 de E-01/E-02/E-03 + 47 de E-04).
- **Critério literal da etapa:** os quatro eventos de RF-25 são montados e serializados, e o envelope é conferido campo a campo — `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId` (nos dois estados), `occurredAt` em ISO-8601, `version` e `data` inteiro. Mais quatro testes que valem para os quatro de uma vez: `eventType`/`version` vindos do tipo, `occurredAt` como string, `causationId` ausente como **chave omitida** e round-trip `JSON.parse(JSON.stringify(...))` idêntico ao original.
- **Curva de D-022:** com `random` fixo em `0` e `1`, as faixas conferem degrau a degrau — `[500, 1000]` na primeira falha, dobrando até saturar em `[150000, 300000]` no teto de 5 min de D-008. Mais o piso (`mínimo = máximo / 2`, que é o que separa equal jitter de full jitter), o agendamento sempre em milissegundo inteiro e uma contagem de 5.000 tentativas vinda do banco que **não** produz `Infinity` — sem o limite de expoente, `nextAttemptAt` viraria `Invalid Date` e travaria a linha para sempre.
- **Lease de D-009:** `isClaimed` distingue lease em vigor de lease vencido, e o teste do vencido é o cenário obrigatório de RF-24 — a instância morreu depois do commit e outra precisa poder assumir. `isDue` ignora o lease de propósito: a disputa é do `SKIP LOCKED` do banco em E-10, não de uma instância em memória.
- **EL-01 provada, não afirmada:** o payload de cada um dos quatro eventos sobrevive a `JSON.stringify` — um `Money` no `data` faria a serialização lançar por causa do `bigint` privado, que é como EL-01 vazaria sem ninguém ver. Um teste varre todo campo monetário do `data` e exige `MoneyProps` com string de exatamente 2 casas. `bun run lint` roda a guarda de E-01 sobre os oito arquivos novos.
- **EL-05:** `InboxMessage` é registro persistente por `(consumerName, messageId)`, sem id próprio e sem estrutura em memória — a unicidade é o `UNIQUE` de E-05 (RI-09), e um teste fixa que a mesma mensagem em consumidores diferentes são dois registros legítimos.
- **EL-06:** nenhum import de `@aws-sdk` entrou; `OutboxMessage` é dado, não publicação. A regra de fronteira de E-01 reprovaria.

## E-05 — Schema e migrations

**Ler antes:** RI-09, RNF-09, RT-08, EL-02, EL-03, EL-07; D-004.
**Escopo — as garantias vão para o schema, não para o código (RI-09):**
- [x] Colunas monetárias como `numeric(19,2)` para valor + `varchar(3)` para moeda, em wallets e no ledger (D-004). — também em `wager_transactions`, mais `CHECK` de forma `^[A-Z]{3}$` na moeda, alinhado a D-016.
- [x] Colunas `reference_attempts` e `next_reference_attempt_at` na tabela de transações (D-013) — o contador de retry vive fora do status.
- [x] `UNIQUE (player_id, currency)` em wallets.
- [x] `CHECK (balance >= 0)` em wallets.
- [x] `UNIQUE (idempotency_key)` em transações.
- [x] `UNIQUE (provider_id, external_transaction_id)` em transações.
- [x] Unicidade que impede reverter a mesma referência duas vezes pelo mesmo tipo (RN-09). — índice **parcial** sobre `PROCESSED` (D-024).
- [x] `UNIQUE (consumer_name, message_id)` na inbox. — é a **chave primária** da tabela (D-025); a inbox não tem id próprio.
- [x] Imutabilidade do ledger imposta no banco (revogar `UPDATE`/`DELETE` ou trigger que rejeita). — **trigger** (D-023): `REVOKE` seria ignorado pelo superusuário do container e a prova de EL-07 passaria por engano.
- [x] **UUIDv7 como padrão de id em todas as tabelas** (D-014), não só no ledger. — `uuid` **sem `DEFAULT`**: o id é injetado pela aplicação, e `gen_random_uuid()` produz v4, que quebraria o cursor de RF-10 em silêncio.
- [x] Colunas `locked_by` e `locked_until` na outbox, além de `attempts`, `next_attempt_at` e `published_at` (D-009). — mais `CHECK` de lease par-ou-nada: metade preenchida seria linha reivindicada sem prazo, presa para sempre.
- [x] Índice `(wallet_id, id)` no ledger para a paginação keyset de RF-10 (D-014).
- [x] Índice **parcial** `WHERE published_at IS NULL` sobre `(next_attempt_at, locked_until)` na outbox — é o caminho quente do worker (D-009).
- [x] Todo `up` com `down` que funciona.
- [x] **Três decisões novas, expostas pela etapa e fechadas antes do código:** D-023 (mecanismo de imutabilidade do ledger), D-024 (alcance da unicidade de RN-09) e D-025 (chave primária da inbox, que era uma **divergência entre dois documentos já registrados** — D-014 e a nota de E-04). Não estavam previstas no escopo original desta etapa.

**Critério de conclusão — atendido:**
- `bun run check` passa: `tsc --noEmit` limpo, `eslint .` limpo, **174 testes unitários verdes** (a etapa não acrescenta unitário — o que ela cria é schema, e schema só se prova contra o banco). `bun run check:full` roda mais **40 de integração**, autoprovisionados pelo Testcontainers.
- **Critério literal da etapa:** cada constraint tem um teste que tenta violá-la e recebe erro do banco — 38 testes em `tests/integration/schema-constraints.test.ts`. As asserções são sobre **SQLSTATE e nome da constraint**, nunca sobre a mensagem: mensagem do PostgreSQL é texto livre e muda entre versões menores, e sem o nome um `23505` qualquer passaria por prova de outra unicidade.
- **EL-02 provada, não afirmada:** `CHECK (balance >= 0)` recusa tanto o `insert` quanto o `update` — e é o `update` que importa, porque é o caminho da race de RNF-03. O teste confirma que o saldo fica intacto depois da recusa.
- **EL-03/EL-04:** as duas unicidades de transação recusam do banco, sem nenhuma estrutura em processo participando da decisão (RI-02).
- **EL-05:** a mesma `(consumer_name, message_id)` é recusada pela PK, e a mesma `message_id` em consumidores diferentes é aceita — o caso que uma chave global colapsaria em silêncio.
- **EL-07:** `UPDATE` e `DELETE` sobre um lançamento existente recebem `P0001` da trigger, e o teste confere depois que a linha continua intacta.
- **EL-01 na borda do driver:** um teste afirma que `numeric` volta como **string**, não `number`. É a guarda que D-004 pediu, aqui contra o driver cru — antes de existir mapeamento. O teste do mapper continua sendo de E-06.
- **RNF-09:** `down({ to: 0 })` derruba o schema inteiro e um `up()` seguinte reconstrói, com uma constraint de amostra voltando a valer. O teste também verifica que a **função** da trigger não ficou órfã — ela sobrevive ao `drop table`, e um `down` incompleto só quebraria na execução seguinte.
- **Duas correções que a execução expôs**, nenhuma delas de memória: os placeholders do MikroORM são `?`, não `$1`; e o PostgreSQL avalia `CHECK` em ordem alfabética de nome, então o `CHECK` de aritmética do ledger foi reescrito com `case ... else true` para não reportar "balanced" num erro que é de direção. Constraint que aponta a regra errada é pior que constraint nenhuma.

## E-06 — Persistência e repositórios

**Ler antes:** RF-01 (mapeamento), RF-02; D-002, D-004.
**Escopo:**
- [x] Mapeamento `Money` ↔ colunas num **mapper explícito da infra** (D-004), com `rehydrate` reconstruindo o value object. O domínio não importa nada do ORM. — `money-mapper.ts`, com guarda de tipo contra o driver; um mapper por agregado em `mappers/`, e `rehydrate` chamado só ali.
- [x] **Teste que prova que o driver devolve `numeric` como `string`, não `number`.** É o padrão do node-postgres, mas um type parser registrado por engano converteria para float em silêncio — a forma mais difícil de enxergar de introduzir EL-01. O teste trava o comportamento (D-004). — três asserções: SQL cru, leitura mapeada, e round-trip exato no teto de `numeric(19,2)`, onde um `double` perderia dígitos.
- [x] Repositórios de wallet, transação, ledger, inbox e outbox. — escrita por comando explícito dentro de `em.transactional()` (D-028); ports no domínio (D-027); mapeamento por `EntitySchema` sobre modelos de linha (D-026).
- [x] Aquisição de lock por wallet conforme D-002, isolada num único ponto do código. — `MikroWalletRepository.findByIdForUpdate`, com o SQL emitido verificado em teste.

**Critério de conclusão:** round-trip de cada agregado (persistir → reidratar → comparar) verde contra o Postgres real. — **atingido**; 19 testes em `persistence-round-trip.test.ts` e 3 em `wallet-lock.test.ts`.

## E-07 — Use case de processamento (`BET`)

**Ler antes:** RF-18, RF-23, RN-01, RN-12, RI-04, RI-07, EL-06; D-002.
**Escopo:**
- [x] `ProcessWagerTransaction` — **um único** use case, compartilhado por HTTP e SQS (RF-18). — a entrada por fila é o campo `inbox` do comando, não um segundo caminho.
- [x] Transação SQL única cobrindo: transação + saldo + ledger + inbox (quando aplicável) + outbox (RF-23). — pela porta `UnitOfWork`, com os repositórios construídos dentro do callback (D-028).
- [x] Publicação **exclusivamente** via outbox. Nenhum `publish` direto no use case (RI-04, EL-06). — reforçado por `no-restricted-imports` em `src/application/**`.
- [x] Replay retorna o resultado original, com o saldo observado à época (RN-12). — **D-030**: o saldo é guardado na transação, porque rejeição e `LOSS` não deixam lançamento de onde reconstruí-lo.
- [x] **Fora do previsto:** `observed_balance` (migration `m0002`), `findByIdempotencyKey` e a fronteira de lint da aplicação. As três saíram de decisões que a etapa expôs (D-030, D-032) ou do critério de conclusão.

**Critério de conclusão:** RT-09 verde. Grep no `src/application` não encontra nenhuma chamada de cliente SQS. — **atendido**: 17 testes de integração novos, com as falhas injetadas pelo `IdGenerator` (colisão de id → `23505` real), sem nenhum mock.

## E-08 — API HTTP: escrita

**Ler antes:** RF-08, RF-13, RF-14, RF-15, RN-13, RN-14, RT-05; D-005, D-006.
**Escopo:**
- [x] `POST /wallets` com `OPENING` na mesma transação SQL e conflito em duplicata (RF-08). — use case `OpenWallet`; as seis colunas NOT NULL que a abertura não tem receberam sentinelas (**D-033**), e a duplicata é traduzida no repositório (**D-035**).
- [x] `POST /wagering/transactions` com `Idempotency-Key` obrigatório (RF-13).
- [x] `payloadHash` canônico conforme D-005. — já vinha de E-07 por D-032; a borda fechou o item que faltava, a **rejeição de `null`**.
- [x] Filtro de exceções aplicando o mapa de D-006 **uniformemente em todos os endpoints** (RF-15). — com a emenda de **D-036**: desfecho de negócio é resultado, não exceção.
- [x] `OPENING` submetido externamente é rejeitado (RN-13). — `422` com `KIND_NOT_SUBMITTABLE`; kind inexistente é `400`.
- [x] `ProviderIdentityPort` + `AuthGuard` no-op registrados como ponto de extensão, sem verificação (D-012). A identidade do provedor continua sujeita às validações de domínio (RN-07). — a porta está **no caminho de toda submissão**, e é o `providerId` resolvido que segue para o use case.
- [x] **Fora do previsto:** `OpenWallet` como use case próprio, `isTransientDatabaseError` (**D-037**), parser artesanal (**D-038**), correlação por header (**D-039**) e a fronteira de lint de `src/interface/**`. As cinco saíram de decisões que a etapa expôs ou do critério de conclusão.

**Critério de conclusão:** RT-05 verde; teste que exercita as cinco situações de RF-15 e confere cinco códigos distintos. — **atendido**: 39 unitários novos (mapa de status e parser) e 23 de integração contra a aplicação NestJS de verdade, com `fetch` HTTP real e sem mock em ponto nenhum. RT-05 é provado na borda: replay devolve o mesmo `transactionId` com **um único débito** no ledger, e payload divergente é `409`.

## E-09 — PROVA DE CONCORRÊNCIA `[meta do dia 1]`

Esta é a etapa mais importante do desafio. Quatro das oito eliminatórias morrem aqui.

**Ler antes:** RNF-01..RNF-05, EL-02, EL-03, EL-05, RT-14..RT-17.
**Escopo:**
- [ ] RT-15 — cenário obrigatório da §8: `100.00`, duas apostas de `80.00` simultâneas → uma `PROCESSED`, uma `REJECTED`, saldo `20.00`, **exatamente um** débito no ledger.
- [ ] RT-14 — a mesma aposta 50 vezes em paralelo → um único débito.
- [ ] RT-16 — wallets distintas em paralelo, sem contenção mútua.
- [ ] RT-17 — **≥ 3 processos** simultâneos, com paralelismo real (não mocks sequenciais).
- [ ] Invariante final verificada em todos: `wallet.balance == saldo reconstruído pelo ledger`.

**Critério de conclusão:** os quatro testes verdes, executados repetidamente (mínimo 10 execuções) sem flake.

---

# DIA 2 — Mensageria, operações restantes e recuperação

## E-10 — Worker da outbox

**Ler antes:** RF-24, RF-25, RI-04, RT-11, RT-19; D-009.
**Escopo:**
- [ ] **Claim com lease** (D-009): `UPDATE ... SET locked_by, locked_until` com `SKIP LOCKED` no subselect, **commit imediato do claim**, publish **fora** da transação, segundo `UPDATE` marcando `published_at`.
- [ ] Backoff e `nextAttemptAt` respeitados.
- [ ] Cenário de crash: commit → processo morre antes de publicar → outra instância assume → evento publicado.
- [ ] Testes RT-11 e RT-19, com RT-19 cobrindo **dois casos**: dois publishers simultâneos não pegam a mesma mensagem, e **lease expirado é reivindicado por outra instância**. Sem o segundo, o cenário obrigatório de RF-24 não está provado.

## E-11 — Consumidor SQS

**Ler antes:** RF-18..RF-22, RT-10, RT-12; D-008.
**Escopo:**
- [ ] Consumidor reutilizando o use case de E-07 (RF-18).
- [ ] Inbox persistente por `(consumerName, messageId)` (RF-19).
- [ ] `ack` **somente após o commit** (RF-20).
- [ ] Classificação negócio / transitório / permanente, com DLQ (RF-21).
- [ ] **`FAILED` só em erro permanente ou esgotamento para DLQ** (D-013). Erro transitório **não toca o status**: devolve a mensagem para retry e deixa a transação em `PENDING`. Teste que prova que um Postgres momentaneamente indisponível não queima a transação.
- [ ] `SIGTERM` conclui em andamento ou devolve visibilidade (RF-22).
- [ ] Testes RT-10 e RT-12.

## E-12 — Operações restantes

**Ler antes:** RN-02..RN-11, RN-16, RN-17, RT-03; D-007.
**Escopo:**
- [ ] `WIN` (crédito), `LOSS` (sem saldo, sem ledger, **mas com evento** — RF-25).
- [ ] `REFUND` e `ROLLBACK` com resolução de referência por `(providerId, referenceExternalTransactionId)` (RN-07).
- [ ] Validação de kind da referência (RN-08), valor igual (RN-10), reversão única (RN-09).
- [ ] `INSUFFICIENT_FUNDS_ON_REVERSAL` distinto de `INSUFFICIENT_FUNDS` (RN-16).
- [ ] Taxonomia de `failureCode` completa conforme D-007.

## E-13 — Worker de referências fora de ordem

**Ler antes:** RF-26, RN-15, RT-20; D-008.
**Escopo:**
- [ ] Worker agendado reprocessando `PENDING_REFERENCE` com backoff exponencial.
- [ ] TTL/limite de D-008; esgotado → `REJECTED` com `REFERENCE_NOT_FOUND` **e evento publicado**.
- [ ] RT-20 — `ROLLBACK`/`REFUND` entregue antes da referência, resolvido depois.

## E-14 — Consultas e reconciliação

**Ler antes:** RF-09..RF-12, RF-16; D-014.
**Escopo:**
- [ ] `GET /wallets/:walletId`, `GET /wagering/transactions/:id`, `GET /providers/:providerId/...`.
- [ ] `GET /wallets/:walletId/ledger` com cursor keyset opaco (D-014).
- [ ] `POST /wallets/:walletId/reconciliation` — divergência logada, contabilizada em métrica e sinalizada na resposta, **nunca corrigida silenciosamente** (RF-16).

---

# DIA 3 — Observabilidade, recuperação e entrega

> **Regra do dia 3: não codar depois das 18h.** O tempo restante é para documentação, revisão e congelamento.

## E-15 — Observabilidade

**Ler antes:** RF-17, RNF-06, RNF-07; D-010.
**Escopo:**
- [ ] Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` — **sem payload financeiro completo** (RNF-06).
- [ ] Métricas de RNF-07 via `prom-client@15.1.3` em `GET /metrics`, com a nomenclatura fechada na tabela de D-010 — incluindo **`outbox_lag_seconds`**, que precisa de collect callback consultando o banco.
- [ ] `GET /health/live` e `GET /health/ready` separados, sem auth (RF-17).

## E-16 — Testes de recuperação e invariante final

**Ler antes:** RT-13, RT-18, RT-21, §13.4 do enunciado.
**Escopo:**
- [ ] RT-18 — worker morto **depois do commit, antes do ack**; redelivery não duplica efeito.
- [ ] RT-13 e RT-21 — reinício do serviço com consistência final comprovada.
- [ ] Rodar `bun run check:full` inteiro, repetidamente, caçando flake.

## E-17 — Entrega

**Escopo:**
- [ ] `README.md` — setup do zero e comandos. **Validar executando num diretório limpo**, não de memória.
- [ ] `ARCHITECTURE.md` — curadoria de `docs/decisions.md`: decisões, trade-offs, **limitações conhecidas** e o desenho de auth não implementado (D-012).
- [ ] Revisão adversarial do diff acumulado em contexto novo (`/code-review high`).
- [ ] Varredura final das oito eliminatórias: para cada EL-XX, apontar o teste que prova sua ausência.
- [ ] Congelar. Nenhuma feature nova.

---

## Se o tempo apertar — ordem de corte

Cortar de baixo para cima, e **registrar cada corte em `ARCHITECTURE.md` como limitação conhecida**. Um corte documentado é engenharia; um corte silencioso é lacuna.

1. Diferenciais opcionais (teste de carga, double-entry, OpenTelemetry) — já fora do plano.
2. Autenticação — já cortada por decisão em D-012, não é corte disponível de novo.
3. Métricas além do mínimo de RNF-07 (5 pts no total da área).
4. Consultas de leitura de E-14, exceto reconciliação.
5. Testcontainers em `check:full` — cair para o Compose fixo e documentar a redução (D-011).

**Nunca cortar:** E-05 (constraints no schema), E-07 (atomicidade), E-09 (prova de concorrência), E-16 (recuperação). São as áreas eliminatórias.
