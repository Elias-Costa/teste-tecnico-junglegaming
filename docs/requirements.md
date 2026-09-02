# Requisitos — Distributed Wagering Processor

Extração numerada e verificável do enunciado em `docs/desafio-original.md`. Este documento existe para que cada linha de código possa ser rastreada até um requisito, e para que "pronto" tenha um critério objetivo em vez de "parece funcionando".

## 1. Como usar este documento

- **`docs/desafio-original.md` é a fonte da verdade final.** Este arquivo é uma leitura organizada dele. Em caso de divergência, o enunciado vence e a divergência deve ser reportada, não resolvida por conta própria.
- Itens marcados com **`[INTERPRETAÇÃO]`** não estão literais no enunciado — são leituras que precisam de confirmação do mantenedor antes de virar código. Cada um deve ter (ou gerar) uma entrada em `docs/decisions.md`.
- Itens marcados com **`[DECISÃO: D-XXX]`** dependem de uma decisão em aberto. Não implementar antes de a decisão estar registrada.

**Prefixos:**

| Prefixo | Significado |
|---|---|
| `RF-XX` | Requisito funcional — algo que o sistema faz |
| `RN-XX` | Regra de negócio — como uma operação se comporta |
| `RNF-XX` | Requisito não funcional — concorrência, observabilidade, operação |
| `RI-XX` | Restrição inviolável — proibição explícita do enunciado |
| `EL-XX` | Falha eliminatória — invalida a entrega inteira |
| `RT-XX` | Teste obrigatório |

---

## 2. Requisitos Funcionais

### 2.1 Domínio (§6 do enunciado)

**RF-01 — Value object `Money`**
Representa dinheiro de forma exata e imutável. Toda operação retorna nova instância.
*Aceite:*
- `amount` recebido e serializado como **string decimal com escala fixa de 2** (`"25.00"`); `currency` em ISO-4217.
- Factories `from(props)` e `zero(currency)`; construtor privado.
- Operações: `add`, `subtract`, `negate`. Consultas: `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`. Serialização: `toJSON`, `toString`.
- Operação entre moedas diferentes lança erro de domínio (`assertSameCurrency`).
- Entradas rejeitadas: `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas decimais, valores negativos em contratos de entrada.
- **Escala de entrada é exatamente 2 casas** — `[DECIDIDO: D-015]`, lacuna do enunciado resolvida. `"25"` e `"25.5"` são rejeitados, assim como zeros à esquerda (`"025.00"`). Garante representação textual única por valor, o que impede conflito falso de `payloadHash` (RF-14).
- **`currency` é validada por forma, não por tabela** — `[DECIDIDO: D-016]`, lacuna do enunciado resolvida. `from()` e `zero()` exigem exatamente três letras maiúsculas (`^[A-Z]{3}$`); `"brl"`, `"BR"`, `"BRLX"` e `""` são rejeitados. Mesmo argumento de canonicidade de D-015: uma representação textual por moeda. A existência do código na ISO-4217 **não** é verificada (limitação conhecida).
- **`equals` também lança em moeda diferente** — `[DECIDIDO: D-017]`. `assertSameCurrency` vale para as quatro operações binárias: `add`, `subtract`, `isLessThan` e `equals`.
- **Não depende de tipos monetários do ORM nem de decorators do NestJS.**
- Na persistência, valor e moeda podem ocupar colunas separadas, desde que a representação seja exata e reidratada como `Money`.

**RF-02 — Aggregate root `Wallet`**
*Aceite:*
- Construtor privado; factories `open(props)` e `rehydrate(state)`.
- Estado encapsulado: `_balance`, `_version`, `_updatedAt` expostos só por getter.
- Métodos `debit` / `credit` aplicam a movimentação mantendo saldo e ledger consistentes entre si.
- **`debit` e `credit` devolvem o `WalletLedgerEntry` que criaram** — `[DECIDIDO: D-018]`, lacuna delegada em texto pela §6.2 ("assinatura e retorno são decisão sua"). É o que torna a invariante saldo↔ledger estrutural: não existe assinatura no agregado capaz de mover saldo sem entregar o lançamento junto. `open` segue o mesmo princípio e devolve `{ wallet, openingEntry }`, com `openingEntry` `undefined` quando o saldo inicial é zero (RF-08).
- **Movimentação exige valor estritamente positivo** — `[DECIDIDO: D-021]`. Valor zero ou negativo é recusado por `debit`/`credit`; a direção do lançamento é quem carrega o sinal.
- Invariantes: no máximo **uma wallet por `playerId` + `currency`**; saldo nunca negativo; moeda da operação igual à da wallet; toda alteração de saldo tem lançamento correspondente no ledger e vice-versa.
- A unicidade por `playerId` + `currency` **não é do agregado** — é invariante entre agregados e vai para o `UNIQUE` do schema em E-05 (RI-09).
- Saldo insuficiente sai do domínio por **consulta** (`hasSufficientBalanceFor`), com `debit` lançando como guarda de último recurso — `[DECIDIDO: D-019]`. A escolha entre `INSUFFICIENT_FUNDS` e `INSUFFICIENT_FUNDS_ON_REVERSAL` (RN-16) é do use case, que é quem sabe o kind.
- `version` inicia em `1` após a criação e **incrementa somente quando o saldo muda**.

**RF-03 — Entidade `WagerTransaction`**
*Aceite:*
- Kinds: `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.
- Status: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.
- `PROCESSED`, `REJECTED` e `FAILED` são **terminais**. Transicionar a partir de um terminal lança `InvalidTransactionStateError` (erro de programação, não caminho de negócio).
- `create` nasce em `PENDING` e valida a exigência de referência por kind; `rehydrate` não revalida transições.
- Transições: `markProcessed`, `markPendingReference`, `reject(code)`, `fail(code)`.
- Consultas de domínio: `isTerminal`, `affectsBalance` (**false para `LOSS`**), `requiresReference` (**true para `REFUND` e `ROLLBACK`**), `matchesPayload(payloadHash)`, `ledgerDirectionFor(reference?)`.
- **Grafo de transições fechado** — `[DECIDIDO: D-013]`. `PENDING → {PROCESSED, REJECTED, FAILED, PENDING_REFERENCE}`; `PENDING_REFERENCE → {PROCESSED, REJECTED, FAILED}`. Sem self-loop e sem volta para `PENDING`: o contador de tentativas vive em colunas próprias, não no status.
- **`FAILED` só em erro permanente de infraestrutura ou esgotamento para DLQ** — `[DECIDIDO: D-013]`. Erro transitório não altera o status. **Quem escreve `FAILED` é E-13, não o consumidor** — `[DECIDIDO: D-047]`: uma falha no consumo faz rollback da transação inteira e não deixa linha onde marcar, porque a transação é inserida já no estado terminal. Só `PENDING_REFERENCE` deixa linha viva, e é ela que E-13 marca ao esgotar o TTL.
- **`reject` e `fail` aceitam famílias de código distintas, impostas pelo tipo** — `[DECIDIDO: D-007]`. `reject(BusinessFailureCode)` cobre os 11 códigos de negócio; `fail(InfrastructureFailureCode)` cobre os 2 de infraestrutura. A separação de D-013 vira erro de compilação, não convenção.
- **Referência ausente em `REFUND`/`ROLLBACK` é payload inválido, não rejeição** — `[DECIDIDO: D-020]`. `create` lança `MissingReferenceError` e nenhuma transação nasce; D-006 mapeia para `400`. Ver RN-06.

**RF-04 — Entidade imutável `WalletLedgerEntry`**
*Aceite:*
- Campos apenas `readonly`; **sem métodos de transição**. A imutabilidade é estrutural, não convenção.
- `create` valida a aritmética: `balanceBefore ± money === balanceAfter` (`isBalanced()`).
- Direções: `DEBIT` / `CREDIT`.
- Uma transação financeira produz **no máximo um lançamento por wallet**.
- Operações sem efeito no saldo (`LOSS` e qualquer transação `REJECTED`) **não geram lançamento**.
- **O valor do lançamento é estritamente positivo** — `[DECIDIDO: D-021]`. `create` recusa zero e negativo: a direção `DEBIT`/`CREDIT` é quem carrega o sinal, e codificá-lo duas vezes criaria duas fontes para o mesmo fato.

**RF-05 — `InboxMessage`**
Deduplicação persistente de mensagens consumidas, por `(consumerName, messageId)`.
*Aceite:* factories `receive` / `rehydrate`; `payloadHash`; `isProcessed()` e `markProcessed(at)`.

**RF-06 — `OutboxMessage`**
Fila persistente de eventos de integração pendentes de publicação.
*Aceite:* factories `enqueue(event)` / `rehydrate`; `attempts`, `nextAttemptAt`, `publishedAt`; `isPending()`, `isDue(now)`, `markPublished(at)`, `scheduleRetry(now)` incrementando tentativas e calculando o próximo `nextAttemptAt` com backoff.

**RF-07 — Envelope `IntegrationEvent`**
*Aceite:*
- **Classe abstrata** com uma **subclasse concreta por evento**. `eventType` e `version` ficam **no tipo**, nunca como string no call site.
- Campos: `eventId`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt`, `data`.
- `toJSON()` produz o envelope gravado no `payload` da outbox, com `occurredAt` em ISO-8601.
- `data` carrega `MoneyProps` (string decimal), **nunca a instância de `Money`** — o payload precisa ser JSON estável e versionável.

### 2.2 API HTTP (§9 do enunciado)

**RF-08 — `POST /wallets`**
Cria wallet para `playerId` + `initialBalance`.
*Aceite:*
- Saldo inicial maior que zero gera transação interna `OPENING` **na mesma transação SQL**, com lançamento `CREDIT` correspondente.
- Resposta: `{ id, playerId, balance, version }` com `version: 1`. Status `201`.
- Wallet duplicada para o mesmo `playerId` + `currency` falha como **conflito**.
- **A `OPENING` interna usa sentinelas nas seis colunas NOT NULL que a abertura não tem** — `[DECIDIDO: D-033]`, lacuna exposta por E-08: `provider_id`, `external_transaction_id`, `idempotency_key`, `payload_hash`, `round_id` e `game_id` são NOT NULL no schema de E-05 e não têm valor natural aqui. `providerId = "internal"` (identificador reservado), `externalTransactionId = walletId`, `idempotencyKey = "opening:{walletId}"`.
- **A abertura publica os dois eventos** — `[DECIDIDO: D-034]`. `WagerTransactionProcessed` (a `OPENING` é transação aplicada) e `WalletBalanceChanged` (o saldo mudou), pela letra de RF-25. Saldo inicial zero não gera transação, lançamento nem evento.
- **A duplicata é traduzida no repositório** — `[DECIDIDO: D-035]`. `uq_wallets_player_currency` continua sendo a garantia (RI-09); o repositório converte a exceção do ORM em `WalletAlreadyExistsError`, que D-006 mapeia para `409`. **Sem `failureCode`**: os 13 códigos de D-007 estão fechados e nenhum descreve "wallet já existe".

**RF-09 — `GET /wallets/:walletId`** — retorna estado atual da wallet.

**RF-10 — `GET /wallets/:walletId/ledger?cursor=...&limit=50`**
*Aceite:* paginação por **cursor estável e opaco** (não offset, não id exposto em claro). O critério de ordenação deve ser total e determinístico. `[DECIDIDO: D-014]` — keyset de coluna única sobre o id em UUIDv7, cursor = base64url do id. UUIDv7 passa a ser o padrão de id em todas as tabelas.

**RF-11 — `GET /wagering/transactions/:transactionId`** — consulta por id interno.

**RF-12 — `GET /providers/:providerId/wagering/transactions/:externalTransactionId`** — consulta por identidade do provedor.

**RF-13 — `POST /wagering/transactions`**
Submete uma operação de aposta.
*Aceite:*
- Header `Idempotency-Key` **obrigatório**; ausência é erro de payload inválido.
- Body: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`.
- Resposta: `{ transactionId, status, balance, idempotentReplay }`, com `failureCode` quando há. Status `200` para aplicada — não `201`, porque um replay não cria nada (RN-12).
- `kind: "OPENING"` submetido pela API é **rejeitado** (RN-13) com `422` e `KIND_NOT_SUBMITTABLE`. Kind **inexistente** é `400`: contrato errado, não regra de negócio.
- **A validação de entrada é um parser artesanal, sem biblioteca** — `[DECIDIDO: D-038]`. A borda checa só forma; valor é do domínio (`Money.from`, `WagerTransaction.create`). É onde o `null` que D-005 manda rejeitar é barrado, e onde um número JSON em `money.amount` morre antes de encostar em ponto flutuante (EL-01).
- **`correlationId` vem do header `X-Correlation-Id`, com fallback gerado** — `[DECIDIDO: D-039]`. Ecoado na resposta, inclusive nas de erro. Header malformado é substituído, não recusado: correlação é observabilidade e não derruba operação válida.

**RF-14 — Idempotência da submissão**
*Aceite:*
- O header `Idempotency-Key` é **a fonte da verdade**. Default recomendado: `"{providerId}:{externalTransactionId}"`.
- `payloadHash` = hash de um **JSON canônico (chaves ordenadas)** do subconjunto de **campos de negócio**. Header e metadados de transporte **não entram no hash**. `[DECIDIDO: D-005]` — SHA-256 sobre lista fechada de 10 campos; `undefined` omitido, `null` rejeitado. A lista é contrato: alterá-la invalida hashes gravados.
- Requisição idêntica → mesma resposta, `idempotentReplay: true`.
- Mesma key com payload diferente → **conflito**, não replay (RN-14).
- A garantia é **persistente**, imposta por constraint no banco (EL-04, RI-09).

**RF-15 — Mapeamento de status HTTP**
*Aceite:* a API distingue com clareza — e **de forma consistente entre todos os endpoints** — cinco situações: (a) payload inválido, (b) conflito de idempotência, (c) rejeição por regra de negócio, (d) aceite com processamento pendente, (e) falha transitória de infraestrutura. Colapsar duas delas no mesmo código é falha de requisito. `[DECIDIDO: D-006]` — `400` / `409` / `422` / `202` / `503`, aplicados por um filtro de exceção único.
- **O desfecho de negócio chega à borda como resultado, não como exceção** — `[DECIDIDO: D-036]`, emenda a D-006. Uma função pura decide `200`/`202`/`422` a partir do resultado; o filtro decide o resto. Os dois pontos vivem no mesmo arquivo e nenhum controller decide status por conta própria. O `422` tem duas formas de corpo, ambas com `failureCode`: rejeição persistida responde o corpo de RF-13 (com `transactionId`); rejeição que não vira linha (D-031, RN-13) responde `{ failureCode, message }`.
- **`503` é reconhecido por lista explícita de SQLSTATE; o que não é nenhuma das cinco situações é `500`** — `[DECIDIDO: D-037]`. Classe `08`, `40001`/`40P01`, classe `53`, `55P03`, `57014`, `57P01` e erros de rede sem SQLSTATE. Violação de constraint e erro de sintaxe **não** entram: reenviar não conserta bug. A mesma função classifica o consumo em RF-21 (E-11).

**RF-16 — `POST /wallets/:walletId/reconciliation`**
*Aceite:*
- Resposta: `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`.
- `calculatedBalance` é reconstruído a partir do ledger, não lido do saldo materializado.
- Divergências **não são corrigidas silenciosamente**: são logadas, contabilizadas em métrica e sinalizadas na resposta.

**RF-17 — Health checks**
*Aceite:* `GET /health/live` (processo vivo) e `GET /health/ready` (PostgreSQL **e** SQS alcançáveis), separados e **sem autenticação**.

### 2.3 Mensageria e workers (§10 e §11 do enunciado)

**RF-18 — Consumidor SQS reutiliza o mesmo use case da entrada HTTP.** Não pode existir um caminho de processamento paralelo com regras próprias.

**RF-19 — Deduplicação por inbox persistente** em `(consumerName, messageId)`, imposta por constraint única no banco.
*Aceite:*
- **O `messageId` é o do corpo da mensagem**, não o `MessageId` de transporte do SQS — `[DECIDIDO: D-044]`. É o campo que a §10 do enunciado escreve, e o único dos dois estável quando o **produtor** reenvia a mesma operação lógica.
- **O `consumerName` é constante no código**, não variável de ambiente — `[DECIDIDO: D-045]`. Instâncias com valores divergentes não dariam erro: dariam efeito duplicado em silêncio, que é EL-03.
- A pré-checagem é o caminho normal da reentrega; quem fecha a janela entre a leitura e o commit é a chave primária `pk_inbox_messages` (RI-09), que aborta a transação perdedora inteira.

**RF-20 — `ack` somente após o commit** da transação financeira.

**RF-21 — Classificação de erro no consumo**
*Aceite:* erros de **negócio** (terminal → ack), **transitórios** (retry com backoff) e **permanentes** (DLQ) são distinguidos e tratados diferente. `[DECIDIDO: D-008]` — `maxReceiveCount` 5, alinhado à redrive policy; backoff exponencial com jitter; valores sobrescrevíveis por ambiente.
- **Erro permanente vai à DLQ por envio explícito, na primeira entrega** — `[DECIDIDO: D-046]`. A redrive policy só age depois de 5 entregas; numa fila FIFO, gastá-las com um payload que nunca vai passar bloqueia o `MessageGroupId` inteiro e atrasa agregados sem relação. A redrive policy continua ativa como rede do transitório que não cede — a DLQ tem, portanto, **dois** caminhos de entrada, e os dois são esperados.
- **O critério não é "negócio vs. infraestrutura", é "deixou rastro ou não deixou"** — `[DECIDIDO: D-048]`. `ack` só para a rejeição que commitou linha `REJECTED` e evento, porque aí o provedor **é** notificado. `WALLET_NOT_FOUND` (D-031), `IDEMPOTENCY_CONFLICT` e `KIND_NOT_SUBMITTABLE` fazem rollback e não deixam linha, evento nem resposta — pela fila não existe o `422` do HTTP —, então vão à DLQ. É desvio deliberado da leitura literal deste requisito, que supõe desfecho sempre observável.

**RF-22 — Shutdown gracioso**: em `SIGTERM`, concluir mensagens em andamento ou devolver a visibilidade. Nenhuma mensagem pode ficar "presa" nem ser perdida.

**RF-23 — Transactional Outbox atômico**
*Aceite:* persistência da transação, alteração de saldo, lançamento no ledger, registro de inbox (quando a entrada for SQS) e evento de integração participam da **mesma transação SQL** — ou tudo é confirmado junto, ou nada é.

**RF-24 — Worker de publicação da outbox**
*Aceite:*
- Funciona com **múltiplos publishers concorrentes**, sem perder nem duplicar indefinidamente. `[DECIDIDO: D-009]` — claim com lease (`locked_by`/`locked_until`) e commit imediato; o publish acontece fora da transação, nunca segurando conexão durante I/O de rede.
- Cenário obrigatório: (1) Postgres confirma o commit; (2) o processo morre antes de publicar; (3) outra instância assume; (4) o evento é publicado; (5) publicação duplicada continua segura para o consumidor.
- **O destino da publicação é decisão do candidato** — `[DECIDIDO: D-040]`, lacuna exposta por E-10: o enunciado (§10) nomeia só as filas de **entrada**. Fila FIFO dedicada `wagering-events.fifo`, com `MessageGroupId = aggregateId` (ordem por agregado, sem serializar agregados sem relação) e `MessageDeduplicationId` = id da linha da outbox. O dedup do SQS é **reforço** ao item 5, nunca a garantia dele — por RI-03, quem garante é a inbox do consumidor.
- **Quem cria a fila** — `[DECIDIDO: D-041]`. Módulo idempotente compartilhado (`ensureQueue`), chamado pelo worker e pelo preload de teste, para que nome e atributos tenham uma fonte de verdade só (mesmo princípio de D-011).
- **O `UPDATE` que marca `published_at` limpa o par do lease** — `[DECIDIDO: D-043]`, questão adiada por E-04/E-05. Lease é sobre trabalho em andamento; trabalho concluído não tem lease. Falha de publicação também solta o lease, junto com o reagendamento.
- **Não há desistência** — `[DECIDIDO: D-042]`, emenda a D-008: as 10 tentativas limitam a **curva** do backoff e servem de limiar de alerta. A linha pendente continua sendo reivindicada até publicar, porque todo evento gravado na mesma transação do dinheiro precisa sair (D-034).

**RF-25 — Eventos mínimos**

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, **inclusive `LOSS`** |
| `WagerTransactionRejected` | transação rejeitada por regra de negócio |
| `WalletBalanceChanged` | **somente** quando o saldo muda |
| `WagerTransactionPendingReference` | referência ausente |

**RF-26 — Worker de referências fora de ordem**
*Aceite:*
- Transações `PENDING_REFERENCE` são reprocessadas por um **worker agendado** com backoff exponencial.
- Limite de tentativas ou TTL definido e justificado. `[DECIDIDO: D-008]` — **TTL de 15 min**, expresso em tempo e não em contagem de tentativas: a pergunta de negócio é quanto tempo se espera a referência chegar.
- Esgotado o limite: `REJECTED` com `failureCode` que identifique a referência inexistente, e **evento correspondente publicado**.

`[DECIDIDO: D-052]` — **o contador e o agendamento são estado operacional**, escritos por `UPDATE` direto no `PendingReferenceStore` e fora do `Pick` do repositório do agregado. É o que faz um `update` de status e um reagendamento tocarem a mesma linha sem um apagar o outro. Lacuna que D-029 deixou explicitamente em aberto para esta etapa.

`[DECIDIDO: D-054]` — **a re-resolução reusa o mesmo use case** (`ProcessWagerTransaction.resolvePendingReference`), pelo argumento de RF-18: duas implementações da decisão de reversão divergiriam justamente onde a divergência move dinheiro. O worker varre, chama e reagenda — não tem regra de negócio.

---

## 3. Regras de Negócio (§7 do enunciado)

| ID | Operação | Efeito no saldo | Ledger | Regra |
|---|---|---|---|---|
| **RN-01** | `BET` | débito | 1 entrada `DEBIT` | rejeitar se saldo insuficiente |
| **RN-02** | `WIN` | crédito | 1 entrada `CREDIT` | pode referenciar a `BET` da mesma rodada |
| **RN-03** | `LOSS` | nenhum | nenhuma | registra o resultado sem mover saldo |
| **RN-04** | `REFUND` | crédito | 1 entrada `CREDIT` | reverte uma `BET` `PROCESSED`, **uma única vez** |
| **RN-05** | `ROLLBACK` | inverso da referência | 1 entrada invertida | reverte uma transação `PROCESSED`, **uma única vez** |

`[DECIDIDO: D-049]` — **a referência opcional de `WIN` é informativa, não resolvida.** RN-07..RN-10 valem **apenas** para `REFUND` e `ROLLBACK`. Lacuna exposta por E-12: resolver a referência do `WIN` faria o índice `uq_wager_transactions_reversal_once` (D-024) impor unicidade sobre um kind que RN-09 nem menciona — dois `WIN` sobre a mesma `BET` colidiriam —, e um `WIN` cuja `BET` ainda não chegou esperaria o TTL de D-008 por um crédito que não depende dela. O campo é gravado em `reference_external_transaction_id` e `reference_transaction_id` fica nulo.

`[DECIDIDO: D-050]` — **referência que existe mas não está `PROCESSED`:** em `PENDING_REFERENCE` a reversão **espera** (RN-15), porque a referência ainda pode virar `PROCESSED`; em `REJECTED`/`FAILED` é `REFERENCE_MISMATCH` imediato, porque D-013 os define como terminais e esperar seria esperar por nada. Lacuna exposta por E-12: RN-04/RN-05 exigem a referência `PROCESSED` sem dizer o que fazer com os outros status.

**RN-06** — `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. Ausência é rejeição, não aceite. **A ausência é tratada como payload inválido (`400`), não como transação `REJECTED`** — `[DECIDIDO: D-020]`, lacuna do enunciado resolvida: a taxonomia de D-007 está fechada em 13 códigos e nenhum descreve "a referência não veio no payload" (`REFERENCE_NOT_FOUND` é o esgotamento do TTL de RF-26). `WagerTransaction.create` lança `MissingReferenceError` e nenhuma transação chega a existir.

**RN-07** — A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve pertencer ao **mesmo provider, player, wallet, moeda e rodada**. Qualquer divergência é rejeição.

**RN-08** — `REFUND` só referencia `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.

**RN-09** — Uma referência **não pode ser revertida duas vezes pelo mesmo tipo de operação**. A garantia é de banco, não de aplicação (RI-09).

**RN-10** — O valor de `REFUND`/`ROLLBACK` deve ser **igual** ao valor da referência. Reversão parcial está fora de escopo.

**RN-11** — Transação `REJECTED` não altera saldo nem gera ledger.

**RN-12** — Repetir uma operação já processada retorna **o resultado original**, incluindo o **saldo observado naquele momento** — não o saldo atual. `[DECIDIDO: D-030]` — o saldo é **guardado** na transação (`observed_balance`), não reconstruído pelo ledger: rejeição (RN-11) e `LOSS` (RN-03) não geram lançamento, e são justamente eles que a reconstrução não alcançaria.

**RN-13** — `OPENING` é **interno**: não pode ser submetido pela API nem pela fila.

**RN-14** — A mesma idempotency key com payload diferente é **conflito**, não replay.

**RN-15** — Referência ausente → persistir como `PENDING_REFERENCE` e reprocessar depois (RF-26). Não é rejeição imediata. `[DECIDIDO: D-053]` — o `balance` da resposta `202` é o **saldo corrente da wallet travada**, e `observed_balance` continua nulo: RN-12 fala do saldo do **desfecho**, e aguardar referência não é desfecho. Pendência que D-030 abriu e adiou para esta etapa.

**RN-16** — Reversão que produziria saldo negativo é **rejeitada explicitamente**, com um `failureCode` **distinto** do de uma aposta sem saldo — são situações operacionalmente diferentes — e permanece auditável.

**RN-17 — Taxonomia de `failureCode`**
Toda rejeição carrega um `failureCode` estável e legível por máquina, suficiente para o provedor decidir se **reenvia**, **corrige o payload** ou **desiste**. `[DECIDIDO: D-007]` — enum fechado de 11 códigos de negócio, com a ação esperada documentada por código em `ARCHITECTURE.md` (documentada, não transmitida). Os **2 códigos de infraestrutura** para o status `FAILED` (`PERMANENT_INFRASTRUCTURE_ERROR` e `MAX_RETRIES_EXHAUSTED`) foram aprovados em D-007, fechando o enum em **13**.

`[DECIDIDO: D-051]` — **quando uma reversão viola mais de uma regra, prevalece o código sobre o qual o provedor consegue agir:** `CURRENCY_MISMATCH` → `REFERENCE_MISMATCH` → `INVALID_REFERENCE_KIND` → `AMOUNT_MISMATCH` → `ALREADY_REVERSED` → `INSUFFICIENT_FUNDS_ON_REVERSAL`. É a coluna "Ação do provedor" de D-007 lida como ordem — *corrigir payload* antes de *desistir*, que vem antes de *escalar*. A resposta carrega **um** `failureCode`, e dizer "desista" a quem também errou o valor faria o provedor abandonar uma operação que ele conseguiria consertar.

`[DECIDIDO: D-031]` — **`WALLET_NOT_FOUND` e `IDEMPOTENCY_CONFLICT` nunca aparecem na coluna `failure_code`.** Os dois são rejeições que o schema impede de virar linha: a FK `fk_wager_transactions_wallet` recusa transação para wallet inexistente, e o `UNIQUE (idempotency_key)` recusa uma segunda linha sob a mesma key. Ambos trafegam na resposta (`422` e `409` por D-006) sem nada ser persistido e sem evento publicado.

---

## 4. Requisitos Não Funcionais

**RNF-01 — Unidade de concorrência é a `walletId`** (§8). Wallets diferentes processam em paralelo sem contenção mútua. Lock global compartilhado por todas as wallets é proibido (RI-06).

**RNF-02 — Correção sob concorrência.** O sistema mantém a correção quando: duas apostas disputam o mesmo saldo; múltiplos workers recebem operações da mesma wallet; wallets diferentes são processadas em paralelo; **três ou mais instâncias** rodam simultaneamente.

**RNF-03 — Cenário obrigatório de concorrência** (§8): saldo inicial `100.00 BRL`, duas apostas de `80.00 BRL` simultâneas. Resultado exigido: exatamente uma `PROCESSED`; a outra `REJECTED` por saldo insuficiente; saldo final `20.00 BRL`; **exatamente um** lançamento de débito no ledger; nenhum retry duplica o débito.

**RNF-04 — Estratégia de concorrência justificada** em `ARCHITECTURE.md`. `[DECIDIDO: D-002]` — pessimistic locking por wallet (`LockMode.PESSIMISTIC_WRITE` dentro de `transactional`). `version` é mantido por exigência de RF-02, mas não é o mecanismo de controle.

**RNF-05 — Ordenação e dedup do broker são otimização, não garantia.** O banco continua responsável pelas invariantes (RI-03).

**RNF-06 — Logs estruturados** (§12): JSON, com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. **Sem dados sensíveis ou payloads financeiros completos nos logs.**

**RNF-07 — Métricas** cobrindo no mínimo: transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, **outbox lag** e latência de processamento. `[DECIDIDO: D-010]` — `prom-client` em `GET /metrics`, com a nomenclatura fechada na tabela de D-010.

**RNF-08 — Entregáveis de documentação** (§14): `README.md` com setup e comandos executáveis do zero; `ARCHITECTURE.md` com decisões, trade-offs e **limitações conhecidas**.

**RNF-09 — Migrations versionadas e reversíveis.** Todo `up` tem `down` que funciona.

---

## 5. Restrições Invioláveis e Falhas Eliminatórias

### 5.1 Restrições invioláveis (§5 do enunciado)

| ID | Restrição |
|---|---|
| **RI-01** | Não usar `number`, `float` ou `double` para dinheiro |
| **RI-02** | Não usar cache em memória como garantia de idempotência |
| **RI-03** | Não confiar apenas em SQS FIFO para garantir consistência |
| **RI-04** | Não publicar eventos antes do commit da transação financeira |
| **RI-05** | Não sobrescrever nem excluir lançamentos do ledger |
| **RI-06** | Não usar lock global compartilhado por todas as wallets |
| **RI-07** | Não implementar saldo como `read → calculate → update` sem controle de concorrência |
| **RI-08** | A solução deve estar correta com **múltiplas instâncias** da aplicação |
| **RI-09** | Unicidade, imutabilidade e não-negatividade aplicadas **no schema do banco**, não apenas em código de aplicação. O desenho de schema, constraints e índices é parte da avaliação |

### 5.2 Falhas eliminatórias (§14 do enunciado)

Cada uma invalida a entrega inteira. **Cada uma precisa de um mecanismo que a torne difícil de introduzir e de um teste que prove sua ausência.**

| ID | Falha | Mecanismo de prevenção | Prova |
|---|---|---|---|
| **EL-01** | `number` para dinheiro | Regra de ESLint (`no-restricted-syntax`) banindo `parseFloat`, `Number(`, `.toFixed(` e aritmética nativa em `src/domain/`; coluna `numeric(19,2)` no schema | RT-01, `bun run lint` |
| **EL-02** | Saldo negativo causado por race | `CHECK (balance >= 0)` no schema + estratégia de lock (D-002) | RT-13, RT-14 |
| **EL-03** | Débito ou crédito duplicado | Constraint única de idempotência + inbox persistente | RT-12, RT-15 |
| **EL-04** | Idempotência apenas em memória | Nenhuma estrutura em processo participa da decisão de replay | RT-08, RT-12 |
| **EL-05** | Solução correta somente com uma instância | Nenhum estado compartilhado em processo; locks no banco | RT-15, RT-16 |
| **EL-06** | Publicação de evento antes do commit | Outbox é a **única** via de publicação; nenhum publish direto no use case | RT-11, RT-17 |
| **EL-07** | Ausência de ledger auditável | Ledger imutável (sem `UPDATE`/`DELETE` concedidos) + reconciliação | RT-06, RT-19 |
| **EL-08** | Testes que substituem completamente PostgreSQL e SQS por mocks | Suíte de integração roda contra containers reais | RT-09..RT-19 |

---

## 6. Testes Obrigatórios (§13 do enunciado)

### 6.1 Unidade

| ID | Cobertura |
|---|---|
| **RT-01** | `Money`: escala, arredondamento, entradas inválidas (`NaN`, `Infinity`, notação científica, string vazia, >2 casas, negativos) |
| **RT-02** | Invariantes da `Wallet`: saldo não negativo, moeda, `version` incrementa só quando o saldo muda |
| **RT-03** | Regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` (RN-01..RN-05) |
| **RT-04** | Conflito de moeda entre operação e wallet |
| **RT-05** | Idempotency key com payload divergente → conflito, não replay (RN-14) |
| **RT-06** | `WalletLedgerEntry.isBalanced()` e recusa de lançamento aritmeticamente inválido |
| **RT-07** | Transições de `WagerTransaction`: terminal não transiciona (RF-03) |

### 6.2 Integração (PostgreSQL e LocalStack/MiniStack **reais em containers**)

| ID | Cobertura |
|---|---|
| **RT-08** | Migrations e constraints: `up`/`down`, unicidade, `CHECK` de não-negatividade, imutabilidade do ledger |
| **RT-09** | Atomicidade entre wallet, ledger, inbox e outbox — falha em qualquer ponto não deixa estado parcial |
| **RT-10** | Inbox e redelivery: mesma `messageId` entregue duas vezes não duplica efeito |
| **RT-11** | Publishers concorrentes sobre a mesma outbox |
| **RT-12** | Retry e DLQ: limite de tentativas respeitado, mensagem chega à DLQ |
| **RT-13** | Recuperação após reinicialização |

### 6.3 Concorrência (paralelismo real, **não mocks sequenciais**)

| ID | Cenário |
|---|---|
| **RT-14** | A mesma aposta enviada **50 vezes em paralelo** → um único débito |
| **RT-15** | Cenário obrigatório da §8: `100.00`, duas apostas de `80.00` (RNF-03) |
| **RT-16** | Wallets distintas processadas em paralelo |
| **RT-17** | **≥ 3 processos/instâncias** simultâneos |
| **RT-18** | Worker morto **depois do commit e antes do ack** |
| **RT-19** | Dois publishers sobre a mesma outbox |
| **RT-20** | `ROLLBACK` ou `REFUND` entregue **antes** da referência |
| **RT-21** | Reinício do serviço com comprovação da consistência final |

### 6.4 Invariante final de todos os testes

```
wallet.balance == saldo reconstruído pelo ledger
```

Nenhum teste é considerado verde sem que essa igualdade valha ao final.

---

## 7. Fora de Escopo

Lista canônica. **Não implementar**, mesmo que pareça trivial de adicionar.

| Item | Origem |
|---|---|
| Reversão parcial de `REFUND`/`ROLLBACK` | §7.5 — "reversão parcial está fora de escopo" |
| Tabela própria de usuários com hash de senha / autenticação artesanal | §2 — se houver auth, é via IdP externo |
| Autenticação em geral | §2 — vale **0 ponto**. **D-012: não implementar**, entregando o desenho documentado + `ProviderIdentityPort` e `AuthGuard` no-op |
| Prisma ou qualquer ORM fora de MikroORM/TypeORM | §4 |
| Conversão entre moedas | §6.1 — o modelo continua multi-moeda, mas o desafio assume `BRL` |
| Playwright/UI, frontend | não mencionado no enunciado |

**Diferenciais opcionais** (só depois do núcleo completo e verde):

- Teste de carga exposto como `bun run test:load`, com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag registrados.
- Ledger de partidas dobradas (*double-entry bookkeeping*).
- OpenTelemetry e dashboard.

---

## 8. Mapa de Pontuação

Ordem de prioridade quando o tempo apertar: **eliminatórias primeiro, depois densidade de pontos.**

| Área | Pts | Requisitos que a sustentam |
|---|---|---|
| Correção financeira | 20 | RF-01, RF-02, RF-04, RF-08, RF-16, RN-01..RN-17, RT-01..RT-06 |
| Concorrência | 20 | RNF-01..RNF-05, EL-02, EL-05, RT-14..RT-17 |
| Idempotência | 15 | RF-14, RF-19, RN-12, RN-14, EL-03, EL-04, RT-05, RT-10 |
| Mensageria e falhas | 15 | RF-18..RF-26, EL-06, RT-09..RT-13, RT-18..RT-21 |
| Modelagem e arquitetura | 10 | RF-01..RF-07, RI-09 |
| Testes | 10 | RT-01..RT-21, EL-08 |
| Observabilidade | 5 | RF-17, RNF-06, RNF-07 |
| Documentação | 5 | RNF-08 |

**70 dos 100 pontos estão nas quatro primeiras linhas.** Autenticação vale 0. Qualquer hora gasta fora do núcleo antes de o núcleo estar verde é hora mal alocada.
