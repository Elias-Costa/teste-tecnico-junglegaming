# Roteiro de Implementação

Ordem oficial de implementação. Cada etapa é pequena, tem escopo fechado, critério de conclusão verificável e aponta o que ler antes de codar. O agente trabalha **uma etapa por vez**, sem inventar escopo e sem depender de memória de sessões anteriores.

Documentos-fonte: `docs/desafio-original.md` (enunciado), `docs/requirements.md` (requisitos), `docs/decisions.md` (decisões). Este roteiro **não substitui** nenhum deles — em caso de conflito, pare e reporte (`AGENTS.md` §0).

---

## Estado atual

> **E-00 a E-17 CONCLUÍDAS** (E-17 em 2026-09-03). Stack validada de ponta a ponta, fundação de pé, núcleo de negócio fechado com teste, camada de mensageria do domínio pronta, schema no banco com as garantias de RI-09, os cinco agregados indo e voltando do PostgreSQL real, o caminho do dinheiro fechado numa transação SQL única com atomicidade provada contra falha real do banco, os dois endpoints de escrita de pé com as cinco situações de RF-15 em cinco códigos distintos, a concorrência provada por comportamento com três instâncias da aplicação em processos separados disputando a mesma wallet — **a meta do dia 1** —, o evento saindo da outbox para o SQS real com o cenário obrigatório de RF-24 provado por um processo que morre depois do commit a fila de entrada fechada — comando que chega por SQS percorre o mesmo use case do HTTP, é deduplicado pela inbox, só recebe `ack` depois do commit, e falha em três destinos distintos conforme o erro seja de negócio, transitório ou permanente — as cinco operações de negócio processadas pelo mesmo use case, com a referência de reversão resolvida por `(providerId, externalTransactionId)` e a taxonomia de D-007 completa — e, agora, **a reversão que chega antes da referência esperando em vez de ser rejeitada, sendo resolvida pelo worker quando a `BET` finalmente chega, e virando `REJECTED` com `REFERENCE_NOT_FOUND` e evento publicado quando o TTL de 15 min acaba: RT-20, o cenário fora de ordem do enunciado, provado com PostgreSQL real — e, agora, **as quatro consultas de RF-09..RF-12 e a reconciliação de RF-16 de pé: o ledger paginado por cursor opaco com a travessia provada página a página, e a divergência de saldo acusada, repetida e deliberadamente não corrigida** — e, agora, **a observabilidade fechada e, com ela, o processo: log JSON com os cinco campos de RNF-06 e os campos fechados em tipo, as oito métricas de D-010 se movendo com tráfego real em `GET /metrics`, os dois health checks separados respondendo contra PostgreSQL e SQS de verdade, e — por D-063 — `main.ts`, os três workers montados no ciclo de vida da aplicação e o comando de migration. O maior buraco estrutural do repositório fechou: um avaliador que clone e rode agora aplica o schema, sobe a API e vê o evento sair para o SQS** — e, agora, **a recuperação provada com processo morrendo de verdade: o consumidor morto entre o commit e o `ack`, cuja mensagem volta e não duplica efeito nenhum (RT-18); o serviço morto com `SIGKILL` no meio de 20 apostas e substituído por outro, que retoma fila, inbox e outbox — inclusive o lease que o primeiro levou consigo — até a consistência final (RT-21); e as três formas de trabalho pendente atravessando o reinício do `WorkersModule` (RT-13). Com isso os 21 testes obrigatórios da §13 têm arquivo, e as oito eliminatórias têm prova nomeada**.
> `bun run check` = typecheck limpo, lint limpo, **305 unitários verdes**. `bun run check:full` = mais **198 de integração** e **13 de concorrência**, autoprovisionados — **três execuções seguidas, sem flake**.
> **E-17 CONCLUÍDA** (2026-09-03), **menos um item, deliberadamente em aberto.** Os dois entregáveis de RNF-08 existem: `README.md` **validado por execução num clone limpo** — não escrito de memória — e `ARCHITECTURE.md` com as 63 decisões curadas por tema, o desenho de auth não implementada (D-012) e **21 limitações conhecidas**. A varredura das oito eliminatórias virou a §3 de `ARCHITECTURE.md`, com mecanismo e arquivo de prova para cada uma. O que fica com o mantenedor: **`/code-review high` em sessão limpa** (o item exige contexto novo) e a decisão de congelar.
> **Etapa atual: nenhuma.** O roteiro acabou. Nenhuma decisão em aberto; nenhuma etapa bloqueada.
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
> **O que E-09 deixou para as etapas seguintes:**
> - **`expectLedgerReconciles` é o único lugar que responde à invariante da §6.4.** Está em `tests/support/concurrency-harness.ts` e vale para **todo** teste, não só os de concorrência: RT-18, RT-19 e RT-21 fecham por ele. Reimplementar a reconciliação em cada arquivo é transformar um requisito em quatro requisitos parecidos.
> - **`tests/support/app-instance.ts` é o embrião do `main.ts` de E-14** e hoje é o único lugar do repositório que **sobe o processo** — `NestFactory.create(AppModule)` + `listen`. Quando E-14 escrever o bootstrap de verdade, ele não substitui este arquivo: RT-17 continua precisando de um alvo que anuncie a porta no stdout e encerre pelo stdin. O que E-14 pode fazer é o inverso — o `main.ts` passar a ser o que este arquivo importa.
> - **`Bun.spawn` + handshake por linha no stdout é o padrão de teste multi-instância deste repositório.** E-10 (dois publishers disputando a mesma outbox, RT-19) e E-11 (worker morto entre commit e ack, RT-18) precisam do mesmo formato. `sleep` não serve: a sincronização é por anúncio, não por relógio.
> - **Cada instância abre o seu pool, e o `pg` usa `max: 10` por padrão** (nenhum `pool` é configurado em `orm-config.ts`). Três instâncias mais a suíte já somam ~40 conexões. Qualquer teste que **segure** N transações abertas ao mesmo tempo tem esse teto como limite real — é por isso que a barreira de RT-16 usa 5 participantes e não 50. **Não é decisão pendente**, é um número a lembrar antes de escrever o próximo teste que segura conexão.
> - **A ordem "lock antes da consulta de idempotência" (E-07) está agora amarrada por teste.** RT-14 exige **1 aplicação e 49 replays**; se alguém inverter as duas linhas do use case, as submissões passam a disputar o `insert` e o número muda. O `UNIQUE` continuaria segurando a invariante — o teste é o que denuncia a degradação antes de ela virar `409` no caminho normal.
> - **A semeadura dos testes de concorrência não passa por `OpenWallet`**, de propósito: o use case publicaria os dois eventos de D-034 e a contagem de linhas de outbox deixaria de significar "eventos das apostas". Quem escrever teste de E-10 sobre a outbox vai querer o mesmo cuidado, ou pelo caminho oposto — semear pela API e contar a partir de uma linha de base conhecida.
> - **Nenhuma linha de `src/` mudou em E-09.** A etapa é só de teste, e isso é resultado, não coincidência: significa que o desenho de concorrência de D-002 estava certo desde E-06 e só faltava prová-lo.
>
> **O que E-10 deixou para as etapas seguintes:**
> - **O worker existe e não está montado em lugar nenhum.** `OutboxPublisher` é classe pura, exercitada pelos testes e por `tests/support/outbox-publisher-instance.ts`. **Hoje um avaliador que suba a API não publica evento nenhum** — ligar o worker a um processo é E-14/E-15, e isso agora é o maior buraco do repositório junto com a ausência de `main.ts`.
> - **`ensureQueue` é a fonte única de nome e atributos de fila (D-041).** E-11 provisiona `wager-transactions.fifo` e a DLQ **pelo mesmo módulo**, incluindo a redrive policy de D-008. Um segundo caminho de criação reabre a duplicidade que D-011 fecha.
> - **`readRetryEnv` é o módulo único de retry de D-008**, e hoje só tem os seis parâmetros da outbox. O TTL de `PENDING_REFERENCE` (E-13) e o `maxReceiveCount` do SQS (E-11) entram **nele**, não em módulo novo — D-008 pede uma curva só.
> - **`SKIP LOCKED` compra vazão, não correção — verificado por sonda, não suposto.** Quem impede a dupla reivindicação é o **lock de linha dentro da transação**: sem `lockMode`, RT-19 acusa 100 publicações para 60 mensagens; com `PESSIMISTIC_WRITE` (sem `SKIP LOCKED`) o teste **passa**, porque o PostgreSQL reavalia o predicado ao soltar o lock. A leitura intuitiva de D-009 é a oposta, e o claim de E-13 tem a mesma forma.
> - **A prova de RT-19 depende da ordem "sobe os publishers, depois semeia".** Semeando antes, o primeiro publisher drena a outbox sozinho enquanto o segundo ainda inicializa o ORM, e o teste passa **sem nunca ter havido disputa**. Foi assim que a primeira versão do teste passou com o lock removido.
> - **O lease é estado operacional, manipulado por `UPDATE` direto** (D-043), e não estado do agregado. É o precedente concreto que D-029 oferece a E-13 para `reference_attempts`/`next_reference_attempt_at`.
> - **`onCycleError` é o gancho onde o logger de E-15 entra.** Hoje é a única coisa que impede uma publicação falha e um ciclo abortado de sumirem em silêncio; RNF-06 o substitui pelo log estruturado.
> - **`lerLinha` e `comPrazo` saíram de `multi-instance.test.ts` para `concurrency-harness.ts`.** O terceiro teste multiprocesso — RT-18/RT-21, em E-16 — usa os mesmos, sem uma terceira cópia.
> - **Pendência de ambiente, não de código:** `.env.example` **não pôde ser editado** (regra de permissão do ambiente bloqueia o arquivo). `SQS_EVENTS_QUEUE` e os seis parâmetros `OUTBOX_*` precisam ser acrescentados à mão antes de E-17, sob pena de o README documentar menos do que o código lê. **E-11 acrescentou oito variáveis à mesma pendência** — `SQS_TRANSACTIONS_QUEUE`, `SQS_TRANSACTIONS_DLQ` e os seis `CONSUMER_*`.
>
> **O que E-11 deixou para as etapas seguintes:**
> - **A curva de backoff de D-022 agora é `backoffDelayMs`, em `src/domain/retry-policy.ts`.** Saiu de dentro de `OutboxMessage.scheduleRetry` porque o consumidor precisa dela para calcular o `ChangeMessageVisibility`. **E-13 é o terceiro consumidor e usa a mesma função** — reescrever a fórmula lá seria a terceira curva que D-008 proíbe. `tests/unit/outbox-message.test.ts` passou sem alteração, e é isso que prova que a extração não mudou matemática nenhuma.
> - **`ReceivedMessage` deliberadamente não carrega o `receiveCount`.** A conversão de `ApproximateReceiveCount` (texto) para inteiro exige `Number()`, que a guarda de EL-01 só libera em `src/infrastructure/config/` — daí `consumerBackoffSeconds` morar lá. Quem quiser expor a contagem ao handler precisa resolver isso primeiro, e ampliar a exceção do lint **não** é a saída.
> - **`runOnce()` e `stop()` usam bandeiras diferentes, e isso é cicatriz de bug.** A primeira versão lia "o laço não está rodando" como "alguém pediu para parar", e todo ciclo avulso devolvia o lote inteiro à fila em vez de processá-lo — os testes acusaram `released` onde esperavam `acked`. O worker de E-13 tem a mesma forma: **`draining` é pedido explícito, nunca a ausência de laço.**
> - **Espiar fila FIFO sem apagar bloqueia o `MessageGroupId` inteiro.** Uma mensagem recebida e não deletada fica em voo pelo visibility timeout, e o teste seguinte não vê nem a própria mensagem. `drenar` (recebe **e** apaga) é o helper certo onde o teste espera encontrar algo; `espiar` só serve para afirmar que a fila está vazia. Foi assim que três testes falharam sem ter defeito nenhum no código de produção.
> - **O `aggregateId` de `WagerTransactionRejected` é a transação, não a wallet** — o saldo não mudou, então não há agregado de wallet a anunciar. Um teste de E-12 que procure o evento de rejeição pela wallet vai encontrar lista vazia.
> - **`ensureQueue` não corrige atributos de fila que já existe.** Se a fila de entrada foi criada antes desta versão, sem redrive policy, o provisionamento devolve a URL existente em silêncio e RT-12 falha sem explicação. É consequência assumida de D-041 (não recriar fila alheia); a saída é apagar a fila à mão.
> - **O consumidor existe e não está montado em lugar nenhum** — exatamente como `OutboxPublisher` desde E-10. `SqsWagerConsumer.fromEnv()` monta tudo, mas ninguém a chama: hoje um avaliador que suba a API não consome mensagem nenhuma. Junto com a ausência de `main.ts` e do comando de migration, é o buraco que E-14/E-15 precisam fechar.
> - **`InfrastructureFailureCode` continua sem uso** (D-047). É E-13 que ganha o emissor de `FAILED`, ao esgotar o TTL de uma transação em `PENDING_REFERENCE`. Quem procurar por `fail(` hoje não encontra chamada nenhuma, e isso é resultado, não esquecimento.
>
> **O que E-12 deixou para as etapas seguintes:**
> - **E-13 já tem o que reprocessar, e as linhas chegam com as colunas de retry no default.** `decideReversal` grava `PENDING_REFERENCE` com `reference_attempts = 0` e `next_reference_attempt_at` nulo — o mapper as omite por D-029, e continua omitindo. **A consulta de varredura de E-13 precisa tratar o nulo**, senão a primeira leva de transações pendentes fica invisível para o worker que existe para resolvê-las. É o efeito prático de D-029 ainda estar em aberto.
> - **Uma reversão entra em `PENDING_REFERENCE` por dois motivos** (D-050): a referência não existe, ou existe e está ela própria aguardando. Para o provedor é o mesmo desfecho e o mesmo evento; para E-13 **também** deve ser, porque a segunda vira resolvível assim que a primeira resolver. Uma varredura que só procure referência ausente deixa a cadeia encalhada.
> - **`REFERENCE_NOT_FOUND` continua sem emissor, e é de E-13.** Os outros dez códigos de negócio de D-007 têm teste; este é o esgotamento do TTL de RF-26 e não tem como ser produzido antes do worker existir. Junto com os dois de infraestrutura (D-047), são os três que faltam para a taxonomia inteira estar exercida.
> - **A ordem dos `if` de `decideReversal` é contrato (D-051), com teste que a fixa.** Reordená-los muda qual `failureCode` o provedor recebe quando duas regras são violadas — é mudança de contrato de integração, não refatoração.
> - **`applyMovement` é o ponto único de movimentação do use case**, e o `insufficientFundsCode` vem por parâmetro. Um kind novo que mova saldo entra por ali; um que chame `wallet.debit` direto perde a consulta de D-019 e troca um `422` legível por uma guarda de último recurso, que é `500`.
> - **`findByProviderExternalId` já é o finder de RF-12**, que E-14 vai expor em `GET /providers/:providerId/wagering/transactions/:externalTransactionId`. Está pronto e testado pelo caminho da reversão — E-14 não precisa de finder novo, só do controller.
> - **A ordem de consumo de ids mudou para os kinds novos, e os testes de RT-09 continuam sobre `BET`.** As constantes `ID_TRANSACAO`/`ID_LANCAMENTO`/`ID_OUTBOX_*` descrevem a sequência de um `BET`; `LOSS` consome menos (não há lançamento) e a reversão consome o mesmo que o `BET`. Quem escrever injeção de falha para um kind novo precisa recontar.
> - **Não existe mais `501` em lugar nenhum.** O mapa de RF-15 voltou a ter exatamente as cinco situações da §9 mais o `500` de ausência. Endpoint novo em E-14 continua sem tratar erro localmente.
> - **`KindNotSubmittableError` mudou de camada** (`src/interface/http/errors/` → `src/application/errors/`). Quem procurar por RN-13 encontra **um** tipo, lançado no parser das duas bordas e no use case.
>
> **O que E-13 deixou para as etapas seguintes:**
> - **`resolvePendingReference` é a terceira entrada do use case, e a fronteira de RF-18 continua valendo para ela.** HTTP, SQS e worker chamam o mesmo objeto; `decideReversal` continua sendo o único lugar que implementa RN-04..RN-10 na ordem de D-051. Um quarto caminho de processamento — se E-14 quiser "reprocessar manualmente" alguma coisa — entra por aqui, não por regra própria.
> - **`decideReversal` não transiciona mais.** As duas chamadas de `markPendingReference()` foram para `process()`, porque a pendente relida pelo worker já **está** em `PENDING_REFERENCE` e D-013 não tem self-loop. Quem mexer naquele método precisa manter a separação: ele decide, o chamador transiciona.
> - **A ordem dos locks é contrato, e não convenção.** Wallet primeiro, transação depois — a mesma do caminho de submissão. Invertê-la no worker abriria deadlock contra o `insert` de uma reversão nova, que toma `FOR KEY SHARE` na linha referenciada pela FK. Vale para qualquer código futuro que trave as duas tabelas.
> - **`correlation_id` existe agora (D-055, `m0003`) e o log estruturado de E-15 deve usá-la.** RNF-06 pede `correlationId` no log; com a coluna, um `correlationId` visto no log vira consulta à transação em vez de correlação por horário. É também o que dá a E-14 um campo de auditoria que não estava previsto em RF-11/RF-12.
> - **`PendingReferenceWorker` não está montado em lugar nenhum** — o terceiro na fila, junto de `OutboxPublisher` (E-10) e `SqsWagerConsumer` (E-11). Hoje um avaliador que suba a API não resolve pendente nenhuma. Somado à ausência de `main.ts` e do comando de migration, **é o buraco que E-14/E-15 precisam fechar**, e agora ele custa três workers, não dois.
> - **A varredura de RF-26 é global, e isso tem consequência para todo teste novo.** `findDue` é a fila de trabalho do sistema inteiro, não a de uma wallet: um teste que conte `scanned` precisa isolar as pendentes deixadas por cenários anteriores. `pending-reference-worker.test.ts` faz isso adiando-as um ano no `beforeEach` — apagar não dá, porque o ledger e as FKs apontam para elas.
> - **O relógio ajustável é o padrão para provar prazo neste repositório.** A porta `Clock` existe desde E-07; adiantá-la é o que permite exercer um TTL de 15 min numa suíte de segundos **sem** substituir infraestrutura (EL-08). E-16 (RT-13, RT-21) vai querer o mesmo.
> - **Os três loops de D-008 estão fechados em `readRetryEnv`**, com dezessete parâmetros e **uma** curva (`backoffDelayMs`). Não há quarto loop previsto; se aparecer, ele entra no mesmo módulo.
> - **`REFERENCE_NOT_FOUND` ganhou emissor e teste.** Faltam só os **dois de infraestrutura** de D-047 (`PERMANENT_INFRASTRUCTURE_ERROR` e `MAX_RETRIES_EXHAUSTED`) para os 13 códigos de D-007 estarem todos exercidos. `fail()` continua sem nenhuma chamada no código de produção — e continua sendo resultado, não esquecimento.
>
> **O que E-14 deixou para as etapas seguintes:**
> - **O mapa de status tem seis respostas agora, não cinco** (D-056). As cinco situações da §9 continuam sendo da **submissão**; o `404` é da leitura e sai sem `failureCode`. `WalletNotFoundError` (422, D-031) e `ResourceNotFoundError` (404) coexistem de propósito, e há teste unitário que falha se alguém "simplificar" fundindo os dois — porque fundi-los devolveria código de negócio a um `GET`.
> - **`uuidParam` existe na borda, e o caminho de escrita não o usa.** Sonda verificada nesta etapa: `POST /wagering/transactions` com `walletId` malformado responde **`500`** hoje, porque a string chega à coluna `uuid` e o `22P02` não está na lista de D-037. É gap **pré-existente de E-08**, não introduzido aqui, e ficou fora por escopo — a correção é uma linha em `parse-submit-transaction-request.ts`, e é decisão do mantenedor.
> - **`isUuid` mora no domínio** (`src/domain/identifier.ts`) e é a fonte única da forma de um id (D-014). A borda e o codec de cursor a compartilham; uma segunda regex é como as duas divergem.
> - **`findPage` serve aos dois leitores do ledger**, com tamanhos de página diferentes: RF-10 pagina para o cliente, RF-16 dobra o ledger inteiro. Uma consulta "que lê tudo" para a reconciliação faria o endpoint deixar de caber na memória no dia em que um ledger crescer.
> - **`ReconcileWallet` é o primeiro caminho de leitura que trava wallet** (D-057), e é o **mesmo** `findByIdForUpdate` de D-002 — RI-06 continua com um ponto de aquisição só. Quem escrever consulta nova em E-15 ou E-16 deve entrar por `findById`: travar para responder um `GET` põe contenção no caminho do dinheiro.
> - **O gancho `onDivergence` está injetável e ninguém o injeta** — exatamente como `onCycleError` em E-10. É onde E-15 liga o log de RNF-06 e a métrica de **D-060, que continua EM ABERTO**: a tabela de D-010 não nomeia nenhuma métrica de reconciliação, e ela é declarada contrato de observabilidade.
> - **`expectLedgerReconciles` ganhou um irmão em produção.** A invariante da §6.4 agora tem duas implementações — a do teste, que lê as tabelas direto, e a do endpoint de RF-16. Elas concordam por construção (o teste de reconciliação consistente chama as duas), e isso é proposital: se divergirem, uma delas está errada e o teste denuncia qual.
> - **Continua sem `main.ts` e sem comando de migration**, e agora isso é o único buraco estrutural que sobrou: quatro workers e cinco endpoints existem e ninguém sobe o processo. Nenhuma das listas de escopo de E-14 e E-15 os traz, embora o "Estado atual" venha dizendo desde E-08 que são "de E-14/E-15". **É item para o mantenedor decidir antes de E-17**, que valida o README executando-o do zero. — **resolvido em E-15 por D-063.**
>
> **O que E-15 deixou para as etapas seguintes:**
> - **O buraco estrutural fechou.** `bun run migration:up` aplica o schema, `bun run start` sobe um processo que serve HTTP **e** roda os três laços, e `bun run migration:down` reverte um lote. Verificado ponta a ponta contra o Compose: aposta pelo HTTP → 39 linhas de outbox publicadas, 0 pendentes, 39 mensagens em `wagering-events.fifo`. É o que E-17 vai documentar no README.
> - **`AppModule` continua HTTP puro e montável sozinho, de propósito.** Quem soma os workers é `WorkersModule` (o raiz de `main.ts`). Quem inverter isso quebra RT-17: `tests/support/app-instance.ts` sobe o `AppModule` três vezes, e três consumidores SQS no meio da prova de concorrência não é a prova que RI-08 pede.
> - **O registro de métricas é singleton de módulo (D-062).** Contador é por processo, como D-010 sempre disse. Teste que exercita borda ou worker mexe em contador global — os testes de E-15 medem sempre de forma **relativa** por causa disso, e quem escrever teste novo de métrica deve fazer o mesmo em vez de zerar o registro.
> - **`outbox_lag_seconds` é ligado no `AppModule`, não junto dos workers** — achado desta etapa, encontrado por teste que falhou. O lag é estado do **banco**, e ligá-lo pelo `WorkersModule` faria um processo só-HTTP expor `0`, que se lê como "outbox em dia" quando significa "ninguém mediu". Métrica que mente para o lado saudável é pior que métrica ausente.
> - **`LogContext` tem campos fechados, e isso é o mecanismo de RNF-06** (D-061), não estilo. Quem acrescentar campo ao log precisa acrescentá-lo ao tipo — e é aí que a pergunta "isso é dado financeiro?" acontece, em vez de não acontecer.
> - **`WagerMessageHandler` agora exige `Logger` no construtor, antes do `consumerName`.** Deliberado: um logger opcional viraria, na primeira composição distraída, um consumidor mandando mensagem à DLQ sem rastro.
> - **RF-22 tem prova repetível, mas por `close()`, não por sinal.** `tests/integration/workers-module.test.ts` exercita o `onApplicationShutdown` diretamente; o Windows não entrega `SIGTERM` a processo nativo, então a outra metade — o SO entregar o sinal ao `enableShutdownHooks()` — é do container. **Vale para E-16**, que vai matar processo de propósito: no Windows isso é morte abrupta, que é justamente o cenário de RT-18.
> - **O encerramento ordenado custa, no pior caso, o `waitTimeSec` do consumidor** (20 s por default). Não é lentidão: é `stop()` esperando o `ReceiveMessage` em voo, como RF-22 manda. Teste que suba os workers precisa encurtar `CONSUMER_WAIT_TIME_SEC` — pelo parâmetro de D-008, nunca trocando o mecanismo.
> - **`GET /health/ready` usa `ListQueues`, não `GetQueueUrl`.** RF-17 pede *alcançável*; exigir a fila existente faria um processo só-HTTP se declarar indisponível por não ter provisionado uma fila que não é dele.
>
> **O que E-16 deixou para as etapas seguintes:**
> - **Nenhuma linha de `src/` mudou.** Como em E-09, isso é resultado e não coincidência: os três cenários de recuperação passaram contra o código que já existia — o outbox com lease de D-009/D-043, a inbox de RF-19 e o `ack`-depois-do-commit de RF-20 estavam certos desde que foram escritos, e só faltava matar um processo para prová-lo.
> - **Processo filho órfão é o flake deste repositório, e agora tem antídoto.** Um caso que falha no meio deixa a instância viva, e ela continua consumindo a fila e reivindicando a outbox do **mesmo** PostgreSQL enquanto o arquivo de teste seguinte roda — na primeira execução isso derrubou quatro suítes que ninguém tinha tocado (RT-11 ×3, RT-20, `workers-module`). Os dois arquivos novos guardam os filhos numa lista de módulo e os matam **incondicionalmente** no `afterAll`. **Todo teste multiprocesso novo deve fazer o mesmo**; `multi-instance.test.ts` e `outbox-publishers.test.ts` encerram os seus no caminho feliz e ficaram como estão, mas herdam o mesmo risco.
> - **O handshake por stdout não serve para quem sobe o `WorkersModule`.** O `JsonLogger` de D-061 escreve em stdout, e `workers.started` sai antes de qualquer anúncio: `tests/support/service-instance.ts` publica o seu num **arquivo** apontado por `SERVICE_ANNOUNCE_FILE`, escrito em duas etapas e movido por `rename` (o arquivo existe vazio por um instante se escrito direto, e o pai o lê antes de haver conteúdo — falha observada). `app-instance.ts` e `outbox-publisher-instance.ts` continuam no stdout porque neles o stdout é só do protocolo.
> - **`Bun.file(...).exists()` cacheia o `stat`.** Um `BunFile` içado para fora do laço de espera responde `false` para sempre, e o sintoma é um prazo de 60 s estourando enquanto o arquivo está lá. Quem esperar por arquivo precisa reconstruir o handle a cada checagem.
> - **`aguardar` está em `tests/support/concurrency-harness.ts`**, ao lado de `lerLinha` e `comPrazo`. É a espera por estado observado com prazo que **rejeita** em vez de travar. `tests/integration/workers-module.test.ts` ainda tem a cópia local dele, de E-15, e ficou intocada por escopo — é candidata óbvia a unificação em E-17, se o mantenedor quiser.
> - **`tests/support/service-instance.ts` é o `main.ts` de teste, e a diferença para `app-instance.ts` é o módulo raiz.** Aquele sobe o `AppModule` (HTTP puro, exigência de RT-17); este sobe o `WorkersModule`, que é o que o enunciado chama de "serviço". Quem escrever teste multiprocesso novo escolhe entre os dois pela pergunta "isto precisa dos laços?".
> - **A morte é `SIGKILL` (`kill(9)`), e é o que fecha a metade que E-15 deixou aberta.** `workers-module.test.ts` prova o encerramento **ordenado** de RF-22 por `close()`; RT-21 prova o oposto — o processo que não encerra coisa nenhuma. As duas metades juntas cobrem RF-22 e o crash recovery da §14.
>
> **Decisões em vigor:** D-001 MikroORM **sem plano B** · D-003 `Money` sobre **`bigint` de centavos** · D-004 coluna **`numeric(19,2)`** + mapper próprio · D-007 (13 `failureCode` fechados) · D-009 (outbox por claim com lease) · D-011 infra de teste **híbrida** · D-012 auth **não implementada** · D-013 (grafo sem self-loop; `FAILED` só em erro permanente ou DLQ) · D-014 (ids UUIDv7, cursor keyset de coluna única) · D-015 (escala de entrada exatamente 2 casas) · D-016 (`currency` validada por forma `[A-Z]{3}`, sem tabela ISO) · D-017 (`equals` lança em moeda diferente) · **D-018** (`debit`/`credit` devolvem o lançamento) · **D-019** (saldo insuficiente: consulta + guarda) · **D-020** (referência ausente é payload inválido) · **D-021** (movimentação exige valor estritamente positivo) · **D-022** (backoff equal jitter, política injetada na chamada) · **D-023** (imutabilidade do ledger por trigger) · **D-024** (unicidade de reversão parcial sobre `PROCESSED`) · **D-025** (PK composta na inbox; alcance de D-014 corrigido) · **D-026** (mapeamento por modelos de linha + mapper, não sobre as classes de domínio) · **D-027** (interfaces de repositório no domínio) · **D-028** (escrita por comando explícito, sem Unit of Work) · **D-029** (colunas de retry de referência sem dono até E-13) · **D-030** (saldo observado em coluna própria) · **D-031** (`WALLET_NOT_FOUND` é erro de aplicação, sem linha e sem evento) · **D-032** (`payloadHash` calculado no use case) · **D-033** (sentinelas internas na `OPENING`) · **D-034** (abertura publica os dois eventos) · **D-035** (duplicata de wallet traduzida no repositório) · **D-036** (desfecho é resultado, não exceção — emenda D-006) · **D-037** (`503` por lista de SQLSTATE; não mapeado é `500`) · **D-038** (parser artesanal, sem biblioteca de validação) · **D-039** (`correlationId` por header com fallback) · **D-040** (fila FIFO dedicada de eventos, grupo por `aggregateId`) · **D-041** (provisionamento por módulo idempotente compartilhado) · **D-042** (as 10 tentativas limitam a curva, não a entrega — emenda D-008) · **D-043** (o `UPDATE` de publicação limpa o par do lease) · **D-044** (a inbox dedupa pelo `messageId` do **corpo**) · **D-045** (`consumerName` constante no código) · **D-046** (erro permanente vai à DLQ por envio explícito) · **D-047** (`FAILED` não tem emissor em E-11) · **D-048** (erro de negócio sem rastro vai à DLQ) · **D-049** (a referência de `WIN` é informativa, não resolvida) · **D-050** (referência não-`PROCESSED`: espera quem ainda pode, rejeita quem não pode mais) · **D-051** (ordem dos códigos pela ação do provedor) · **D-052** (colunas de retry de referência são estado operacional, por `UPDATE` direto — fecha D-029) · **D-053** (o `202` de RN-15 responde o saldo corrente da wallet travada) · **D-054** (a re-resolução é segunda entrada do mesmo use case) · **D-055** (`correlationId` persistido na transação, `m0003`) · **D-056** (consulta de recurso inexistente é `404`, fora das cinco situações) · **D-057** (a reconciliação lê sob o lock da wallet) · **D-058** (o `limit` de RF-10 é convertido em `infrastructure/config`) · **D-059** (forma da resposta das consultas) · **D-060** (`wallet_reconciliation_checks_total{consistent}`, oitava linha da tabela de D-010) · **D-061** (logger JSON próprio, campos fechados em tipo) · **D-062** (instrumentação nas bordas e no repositório, sobre registry singleton) · **D-063** (E-15 sobe o processo: `main.ts`, workers montados e comando de migration).
>
> Também decidido: D-002 (pessimistic `FOR UPDATE` por wallet) · D-005 (SHA-256 sobre lista fechada de 10 campos) · D-006 (`400`/`409`/`422`/`202`/`503`) · D-008 (defaults conservadores e configuráveis por ambiente).
>
> D-010 (`prom-client` em `GET /metrics`).
>
> **Fila vazia.** `D-060` — o nome da métrica de divergência de reconciliação, que bloqueava esta etapa — foi fechado em 2026-09-03, e com ele as três decisões que E-15 expôs ao ser detalhada (**D-061**, **D-062**, **D-063**): todas resolvidas **antes** de a primeira linha de observabilidade ser escrita. O item anterior — o dono de `reference_attempts`/`next_reference_attempt_at`, aberto por D-029 — foi fechado por **D-052**, com D-043 como precedente, antes de o worker ser escrito. As 15 decisões que o enunciado delegava estão fechadas e registradas, mais D-016 e D-017 (expostas por E-02), D-018 a D-021 (expostas por E-03), D-022 (exposta por E-04), D-023 a D-025 (expostas por E-05), D-026 a D-029 (expostas por E-06), D-040 a D-043 (expostas por E-10), D-044 a D-048 (expostas por E-11) D-049 a D-051 (expostas por E-12) D-052 a D-055 (expostas por E-13), D-056 a D-059 (expostas por E-14) e D-060 a D-063 (expostas por E-14/E-15), todas fechadas pelo mantenedor antes de o código ser escrito. **E-16 não expôs nenhuma** — era esperado, porque é etapa só de teste e todo mecanismo que ela exercita já tinha decisão registrada. Se a implementação expuser uma decisão não prevista, ela **para a etapa** e vai para `docs/decisions.md` (`AGENTS.md` §0).

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
- [x] RT-15 — cenário obrigatório da §8: `100.00`, duas apostas de `80.00` simultâneas → uma `PROCESSED`, uma `REJECTED`, saldo `20.00`, **exatamente um** débito no ledger. — `tests/concurrency/same-wallet-contention.test.ts`, **10 rodadas** por execução, com wallet nova em cada uma.
- [x] RT-14 — a mesma aposta 50 vezes em paralelo → um único débito. — mesmo arquivo; 50 respostas com o mesmo `transactionId`, **uma** aplicação e 49 replays.
- [x] RT-16 — wallets distintas em paralelo, sem contenção mútua. — `tests/concurrency/distinct-wallets.test.ts`, por barreira de 5 participantes, **com controle negativo**.
- [x] RT-17 — **≥ 3 processos** simultâneos, com paralelismo real (não mocks sequenciais). — `tests/concurrency/multi-instance.test.ts`: três `Bun.spawn` de `tests/support/app-instance.ts`, cada um subindo o `AppModule` de produção em porta própria.
- [x] Invariante final verificada em todos: `wallet.balance == saldo reconstruído pelo ledger`. — `expectLedgerReconciles` em `tests/support/concurrency-harness.ts`, o único ponto que responde a essa pergunta.
- [x] **Fora do previsto:** um **controle negativo** para a barreira de RT-16. Sem ele, a prova de ausência de lock global passaria mesmo se a barreira fosse decorativa.

**Critério de conclusão:** os quatro testes verdes, executados repetidamente (mínimo 10 execuções) sem flake. — **atendido**: 8 testes, **10 execuções seguidas** de `bun test tests/concurrency` contra o Compose, `8 pass / 0 fail` em todas, mais a execução autoprovisionada de `bun run check:full`.

**A prova tem dentes, e isso foi verificado por sonda.** Removido o `LockMode.PESSIMISTIC_WRITE` de `findByIdForUpdate` (D-002) e nada mais, **5 dos 8 testes falham**: RT-15 nas duas formas, RT-14, o controle negativo de RT-16 e RT-17 — este último aceitando **as 30 apostas** de `20.00` sobre `100.00` de saldo, com o `CHECK (balance >= 0)` intacto, porque *lost update* deixa a coluna em `80.00` e a mentira inteira no ledger. É o desenho de EL-02 e EL-03 acontecendo, e a razão de a invariante da §6.4 não ser opcional: sem ela, o saldo sozinho não denuncia nada. `src/` voltou byte a byte ao que era.

---

# DIA 2 — Mensageria, operações restantes e recuperação

## E-10 — Worker da outbox

**Ler antes:** RF-24, RF-25, RI-04, RT-11, RT-19; D-009.
**Escopo:**
- [x] **Claim com lease** (D-009): `UPDATE ... SET locked_by, locked_until` com `SKIP LOCKED` no subselect, **commit imediato do claim**, publish **fora** da transação, segundo `UPDATE` marcando `published_at`. — `OutboxClaimStore`; o `SKIP LOCKED` vem de `LockMode.PESSIMISTIC_PARTIAL_WRITE`, sem SQL cru.
- [x] Backoff e `nextAttemptAt` respeitados. — a curva continua sendo a do domínio (D-022); o worker só persiste o resultado e **solta o lease**, para que o agendamento decida a próxima tentativa.
- [x] Cenário de crash: commit → processo morre antes de publicar → outra instância assume → evento publicado. — provado com `process.exit(1)` **depois** do commit do claim, em processo de verdade.
- [x] Testes RT-11 e RT-19, com RT-19 cobrindo **dois casos**: dois publishers simultâneos não pegam a mesma mensagem, e **lease expirado é reivindicado por outra instância**. Sem o segundo, o cenário obrigatório de RF-24 não está provado. — os dois casos mais o cenário de RF-24 inteiro, em três `it` distintos.
- [x] **Fora do previsto:** quatro decisões que a etapa expôs — **D-040** (destino da publicação), **D-041** (quem cria a fila), **D-042** (o que acontece na 11ª tentativa; emenda D-008) e **D-043** (o `UPDATE` de publicação limpa o lease). As quatro foram fechadas pelo mantenedor **antes** de o worker ser escrito.

**Critério de conclusão:** RT-11 e RT-19 verdes, com o cenário obrigatório de RF-24 provado por processo real. — **atendido**.

## E-11 — Consumidor SQS

**Ler antes:** RF-18..RF-22, RT-10, RT-12; D-008.
**Escopo:**
- [x] Consumidor reutilizando o use case de E-07 (RF-18). — `WagerMessageHandler` traduz o envelope da §10 no **mesmo** `ProcessWagerTransactionCommand` do controller; nenhuma regra vive só do lado da fila, e `parseSubmittableKind` é compartilhada para que RN-13 continue sendo uma regra só.
- [x] Inbox persistente por `(consumerName, messageId)` (RF-19). — chave é o `messageId` do **corpo** (D-044) e `consumerName` é constante (D-045); pré-checagem por `InboxLookup` no caminho normal, `pk_inbox_messages` como rede sob corrida.
- [x] `ack` **somente após o commit** (RF-20). — o `DeleteMessage` está no passo de desfecho, depois de o handler ter retornado; não existe caminho no consumidor que apague antes.
- [x] Classificação negócio / transitório / permanente, com DLQ (RF-21). — três desfechos (`ack`/`retry`/`dead-letter`), com **envio explícito** à DLQ na primeira entrega (D-046) e o critério "deixou rastro ou não deixou" (D-048).
- [x] **`FAILED` só em erro permanente ou esgotamento para DLQ** (D-013). Erro transitório **não toca o status** — e, neste sistema, **não há status a tocar**: E-07 insere a transação já no estado terminal, então o rollback não deixa linha nenhuma. **O texto anterior desta linha dizia "deixa a transação em `PENDING`", estado que este desenho não produz; corrigido em D-047.** A prova é por ausência, e é mais forte: com o Postgres de fato inalcançável, zero linhas.
- [x] `SIGTERM` conclui em andamento ou devolve visibilidade (RF-22). — `stop()` conclui a mensagem em andamento e devolve `ChangeMessageVisibility(0)` para as intocadas do lote; o teste fixa "linhas + mensagens na fila = mensagens enviadas".
- [x] Testes RT-10 e RT-12. — RT-10 nos **dois** sentidos (reentrega genuína e reenvio do produtor, que é o caso que D-044 comprou) e RT-12 pelos dois caminhos da DLQ.
- [x] **Fora do previsto:** cinco decisões que a etapa expôs — **D-044** (qual `messageId` deduplica), **D-045** (`consumerName`), **D-046** (como o permanente chega à DLQ), **D-047** (quem escreve `FAILED`) e **D-048** (o erro de negócio sem rastro). As cinco foram fechadas pelo mantenedor **antes** de o consumidor ser escrito.
- [x] **Fora do previsto:** a curva de backoff de D-022 saiu de dentro de `OutboxMessage` para `backoffDelayMs`, em `retry-policy.ts`. O consumidor precisa dela para o `ChangeMessageVisibility`, e D-008 pede **uma** curva para os três loops.

**Critério de conclusão:** RT-10 e RT-12 verdes contra PostgreSQL e LocalStack reais, com as três classificações de RF-21 tendo três destinos observáveis. — **atendido**.

## E-12 — Operações restantes

**Ler antes:** RN-02..RN-11, RN-16, RN-17, RT-03; D-007.
**Escopo:**
- [x] `WIN` (crédito), `LOSS` (sem saldo, sem ledger, **mas com evento** — RF-25). — a ausência de lançamento **é** o que faz `WalletBalanceChanged` não sair, sem nenhum teste de kind em `enqueueEvents` (D-018).
- [x] `REFUND` e `ROLLBACK` com resolução de referência por `(providerId, referenceExternalTransactionId)` (RN-07). — `findByProviderExternalId`, sem lock: RN-07 obriga a referência a ser da **mesma** wallet, que o use case já travou (RI-06).
- [x] Validação de kind da referência (RN-08), valor igual (RN-10), reversão única (RN-09). — RN-08 por tabela (`REVERSIBLE_REFERENCE_KINDS`), e é ela que protege `ledgerDirectionFor` de ser chamada com um `LOSS`.
- [x] `INSUFFICIENT_FUNDS_ON_REVERSAL` distinto de `INSUFFICIENT_FUNDS` (RN-16). — o código vem por parâmetro de `applyMovement`, então o ponto único de movimentação serve aos quatro kinds sem misturar as duas situações.
- [x] Taxonomia de `failureCode` completa conforme D-007. — um teste por código, como D-007 pede; `REFERENCE_NOT_FOUND` e os dois de infraestrutura continuam sem emissor, e isso é E-13 (D-047).
- [x] **Fora do previsto:** três decisões que a etapa expôs — **D-049** (a referência de `WIN` é informativa), **D-050** (referência não-`PROCESSED`) e **D-051** (ordem dos códigos quando há mais de uma violação). As três foram fechadas pelo mantenedor **antes** de o código ser escrito.
- [x] **Fora do previsto:** `UnsupportedKindError` e o ramo `501` do mapa foram removidos, como E-08 previu, e `KindNotSubmittableError` **subiu de `src/interface/http/errors/` para `src/application/errors/`** — RN-13 diz "nem pela API nem pela fila", então é regra das duas entradas, e o use case não pode importar da borda.
- [x] **Fora do previsto:** guarda de valor estritamente positivo no use case (D-021). `LOSS` não move saldo, então não passa por `Wallet.debit`/`credit` e um `LOSS` de `0.00` morria no `ck_wager_transactions_amount_positive` como `500` — para o que é payload inválido.

**Critério de conclusão:** RT-03 verde com os cinco kinds e cada `failureCode` de reversão provado pela situação que o produz, contra PostgreSQL real. — **atendido**.

## E-13 — Worker de referências fora de ordem

**Ler antes:** RF-26, RN-15, RT-20; D-008.
**Escopo:**
- [x] Worker agendado reprocessando `PENDING_REFERENCE` com backoff exponencial. — `PendingReferenceWorker` + `PendingReferenceStore`; as duas colunas de retry viraram estado operacional por `UPDATE` direto (D-052, fechando D-029), e a curva é a **mesma** `backoffDelayMs` dos outros dois loops.
- [x] TTL/limite de D-008; esgotado → `REJECTED` com `REFERENCE_NOT_FOUND` **e evento publicado**. — TTL de 15 min medido a partir do `createdAt` da reversão, injetado por parâmetro como manda D-022.
- [x] RT-20 — `ROLLBACK`/`REFUND` entregue antes da referência, resolvido depois. — os dois kinds, mais a cadeia de D-050 (`ROLLBACK` esperando um `REFUND` que também espera) desencalhando no mesmo ciclo.
- [x] **Não previsto na etapa:** `correlation_id` persistido na transação (`m0003`, D-055). Não era escopo, mas RNF-06 exige `correlationId` no rastro e o desfecho publicado pelo worker acontece **fora** da requisição que o originou — sem a coluna, o evento mais difícil de correlacionar seria o único sem correlação real.

## E-14 — Consultas e reconciliação

**Ler antes:** RF-09..RF-12, RF-16; D-014.
**Escopo:**
- [x] `GET /wallets/:walletId`, `GET /wagering/transactions/:id`, `GET /providers/:providerId/...`. — três controllers, um mapa de status só; os dois finders de transação já existiam desde E-06 e E-12, a etapa só abriu o caminho de leitura.
- [x] `GET /wallets/:walletId/ledger` com cursor keyset opaco (D-014). — `findPage` na porta do ledger, codec base64url na camada de aplicação, `limit` convertido em `infrastructure/config` por causa da guarda de EL-01 (D-058).
- [x] `POST /wallets/:walletId/reconciliation` — divergência sinalizada na resposta e **nunca corrigida silenciosamente** (RF-16), lida sob o lock da wallet (D-057). **A métrica não:** D-010 não nomeia nenhuma métrica de reconciliação, então `D-060` ficou EM ABERTO e endereçada a E-15; o que E-14 entrega é o gancho `onDivergence`, na forma do `onCycleError` de E-10.
- [x] **Fora do previsto:** `uuidParam` na borda. Id malformado na rota chegaria à coluna `uuid` e o `22P02` — que D-037 não mapeia — viraria `500` para o que é payload inválido.

**Critério de conclusão:** as quatro consultas e a reconciliação de pé contra PostgreSQL real, com a paginação provada por travessia e a divergência provada por não ser corrigida. — **atendido**.

---

# DIA 3 — Observabilidade, recuperação e entrega

> **Regra do dia 3: não codar depois das 18h.** O tempo restante é para documentação, revisão e congelamento.

## E-15 — Observabilidade

**Ler antes:** RF-17, RNF-06, RNF-07; D-010.
**Escopo:**
- [x] Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` — **sem payload financeiro completo** (RNF-06). — `JsonLogger` atrás da porta `Logger` (D-061), com o conjunto de campos **fechado em tipo**: a proibição de payload financeiro virou erro de compilação, não disciplina. Os quatro ganchos que esperavam desde E-10 — três `onCycleError` e o `onDivergence` — finalmente têm alguém do outro lado.
- [x] Métricas de RNF-07 via `prom-client@15.1.3` em `GET /metrics`, com a nomenclatura fechada na tabela de D-010 — incluindo **`outbox_lag_seconds`**, que precisa de collect callback consultando o banco. — as oito da tabela (sete de D-010 + a de D-060), incrementadas nas bordas e nos laços (D-062); `outbox_lag_seconds` por collect callback sobre `OutboxLagStore`.
- [x] `GET /health/live` e `GET /health/ready` separados, sem auth (RF-17). — `live` não toca dependência nenhuma de propósito; `ready` faz `select 1` real (o flag de D-001 é preguiçoso) e `ListQueues`, e responde `503` dizendo **qual** sonda falhou.
- [x] **Fora do previsto, por decisão do mantenedor (D-063):** `src/main.ts`, os três workers montados no ciclo de vida da aplicação (`WorkersModule`) e o comando de migration (`bun run migration:up` / `migration:down`). Fecha o buraco que o "Estado atual" vinha anunciando desde E-08 — e sem ele três das oito métricas não teriam `/metrics` onde aparecer.
- [x] **Fora do previsto:** três decisões que a etapa expôs — **D-061** (implementação do log), **D-062** (onde a instrumentação é ligada) e **D-063** (a ampliação de escopo acima). As três foram fechadas pelo mantenedor **antes** de o código ser escrito, junto com **D-060**, que bloqueava a etapa.

**Critério de conclusão:** os três endpoints de pé e as oito métricas se movendo com tráfego real contra PostgreSQL e SQS, mais o processo subindo de verdade. — **atendido**.

## E-16 — Testes de recuperação e invariante final

**Ler antes:** RT-13, RT-18, RT-21, §13.4 do enunciado.
**Escopo:**
- [x] RT-18 — worker morto **depois do commit, antes do ack**; redelivery não duplica efeito. — `tests/concurrency/consumer-crash-before-ack.test.ts` com dois processos: o primeiro commita a transação e morre com `process.exit(1)` **de dentro do handler**, antes de o consumidor chegar ao `DeleteMessage`; o segundo pega a reentrega e a inbox a absorve. Um débito, uma linha de inbox, um evento.
- [x] RT-13 e RT-21 — reinício do serviço com consistência final comprovada. — **RT-21** em `tests/concurrency/service-restart.test.ts`: 20 apostas pela fila, a instância morta com `SIGKILL` no meio do consumo, a segunda retomando fila, inbox e outbox — inclusive o lease que a primeira levou consigo. **RT-13** em `tests/integration/recovery-after-restart.test.ts`, com o `WorkersModule` real subido e derrubado em volta de três formas de trabalho pendente: outbox com lease de instância que não volta, `PENDING_REFERENCE` criada antes do boot, e a inbox atravessando o restart.
- [x] Rodar `bun run check:full` inteiro, repetidamente, caçando flake. — três execuções seguidas, todas verdes. **O flake foi encontrado e era do próprio teste novo**, não do código de produção: um filho órfão de um caso que falhou continuou consumindo a fila e reivindicando a outbox do mesmo banco, e derrubou quatro suítes que ninguém tinha tocado.

**Critério de conclusão:** os três cenários de recuperação verdes contra PostgreSQL e SQS reais, com a invariante da §6.4 fechando cada um. — **atendido**.

## E-17 — Entrega

**Escopo:**
- [x] `README.md` — setup do zero e comandos. **Validar executando num diretório limpo**, não de memória. — validado por `git clone` para um diretório novo, com os seis passos executados **na ordem escrita**: `bun install` (384 pacotes), `.env`, `docker compose up -d --wait`, `migration:up` (três migrations), `start`, e as dez rotas exercitadas por `curl`. **Toda saída no README é a saída real dessa execução**, incluindo o percurso pela fila e as métricas se movendo. Dois achados que só a execução dava: o corpo de `POST /wallets` devolve `id`, não `walletId` (um README escrito de memória teria errado o exemplo), e `docker compose up -d --wait` é o comando certo — sem `--wait`, o `migration:up` seguinte pode encontrar o PostgreSQL ainda subindo.
- [x] `ARCHITECTURE.md` — curadoria de `docs/decisions.md`: decisões, trade-offs, **limitações conhecidas** e o desenho de auth não implementado (D-012). — oito seções: camadas e as fronteiras que são **impostas** e não convencionadas; o caminho do dinheiro; as oito eliminatórias; as 63 decisões curadas por tema (não copiadas); o desenho de auth com IdP externo, onde o guard entraria e o que mudaria no contrato; **21 limitações conhecidas** em cinco grupos; e a rastreabilidade RT-01..RT-21 → arquivo.
- [ ] Revisão adversarial do diff acumulado em contexto novo (`/code-review high`). — **em aberto, e deliberadamente com o mantenedor.** O item exige contexto novo; a sessão que escreveu esta etapa está carregada com a exploração inteira do repositório, e rodar a revisão nela produziria exatamente o viés que a exigência existe para evitar. Rodar após `/clear`.
- [x] Varredura final das oito eliminatórias: para cada EL-XX, apontar o teste que prova sua ausência. — §3 de `ARCHITECTURE.md`, com mecanismo **e** arquivo para cada uma. Mora no arquivo em vez de só na resposta: quem avalia lê o repositório.
- [x] **Fora do previsto, por decisão do mantenedor:** unificar `aguardar`, a duplicação que E-16 deixou registrada em `tests/integration/workers-module.test.ts`. As duas cópias **não eram equivalentes** — a local devolvia `boolean`, a canônica lança —, então o caso negativo não podia virar `aguardar`: não se prova ausência procurando presença. Ele passou a janela de graça + leitura direta, e o positivo passou à `aguardar` de `tests/support/concurrency-harness.ts`.
- [ ] Congelar. Nenhuma feature nova. — do mantenedor, na leitura do diff.

---

## Se o tempo apertar — ordem de corte

Cortar de baixo para cima, e **registrar cada corte em `ARCHITECTURE.md` como limitação conhecida**. Um corte documentado é engenharia; um corte silencioso é lacuna.

1. Diferenciais opcionais (teste de carga, double-entry, OpenTelemetry) — já fora do plano.
2. Autenticação — já cortada por decisão em D-012, não é corte disponível de novo.
3. Métricas além do mínimo de RNF-07 (5 pts no total da área).
4. Consultas de leitura de E-14, exceto reconciliação.
5. Testcontainers em `check:full` — cair para o Compose fixo e documentar a redução (D-011).

**Nunca cortar:** E-05 (constraints no schema), E-07 (atomicidade), E-09 (prova de concorrência), E-16 (recuperação). São as áreas eliminatórias.
