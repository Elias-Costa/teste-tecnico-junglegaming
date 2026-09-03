# Distributed Wagering Processor

Serviço de processamento de apostas com **saldo transacional, idempotência persistente e mensageria confiável**. Cada operação de um provedor de jogos — `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` — chega por HTTP ou por SQS, percorre o **mesmo** caso de uso, e move o saldo de uma wallet dentro de **uma única transação SQL** que grava, junto: a transação, o lançamento do ledger, a linha de inbox (quando a origem é a fila) e o evento de integração na outbox. O evento só vai para a fila **depois** do commit.

As decisões que sustentam isso, os trade-offs de cada uma e as limitações conhecidas estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Requisitos

| Ferramenta | Versão | Por quê |
|---|---|---|
| [Bun](https://bun.sh) | **1.4.x** | runtime, gerenciador de pacotes e test runner — os três |
| Docker + Compose | qualquer recente | PostgreSQL e LocalStack (SQS) |

Nada mais. Não há Node, npm, `tsc` de build nem CLI da AWS a instalar.

---

## Subir do zero

Os cinco comandos abaixo foram executados nesta ordem, num clone limpo, contra Docker de verdade. Não são de memória.

```bash
git clone <url-do-repositorio> wagering-processor && cd wagering-processor
```

```bash
bun install
```

```bash
cp .env.example .env
```

Os defaults do `.env.example` já batem com o `docker-compose.yml` — a cópia existe para você poder **mudar** algo (a porta do Postgres, os prazos de retry), não porque o serviço não suba sem ela. Cada variável está comentada por extenso no próprio arquivo.

```bash
docker compose up -d --wait
```

`--wait` segura o terminal até os dois containers passarem no healthcheck. Sem ele, o `migration:up` seguinte pode encontrar o PostgreSQL ainda subindo.

```bash
bun run migration:up
```

```
[migrator] Processing 'M0001InitialSchema'
[migrator] Applied 'M0001InitialSchema'
[migrator] Processing 'M0002ObservedBalance'
[migrator] Applied 'M0002ObservedBalance'
[migrator] Processing 'M0003CorrelationId'
[migrator] Applied 'M0003CorrelationId'
migration up concluída
```

O schema é passo de operação, **não** efeito colateral do boot: a aplicação não aplica migration ao subir. Duas instâncias subindo juntas disputariam o `up`, e um `up` automático transforma deploy em migração silenciosa.

```bash
bun run start
```

Sobe **um** processo que serve o HTTP na porta `3000` **e** roda os três laços de mensageria (publicador da outbox, consumidor da fila de comandos, resolvedor de referências fora de ordem). As três filas SQS são criadas automaticamente na primeira publicação — não há fila para criar à mão.

---

## Conferir que está de pé

### Os dois health checks

```bash
curl -s localhost:3000/health/live
```
```json
{"status":"live"}
```

```bash
curl -s localhost:3000/health/ready
```
```json
{"status":"ready","checks":{"postgres":true,"sqs":true}}
```

`live` não toca dependência nenhuma de propósito — ele responde "o processo está vivo", e um `live` que falha porque o banco caiu faz o orquestrador reiniciar um processo saudável. `ready` faz um `select 1` real e um `ListQueues` real, e devolve `503` dizendo **qual** sonda falhou.

### Abrir uma wallet

```bash
curl -s -X POST localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"player-2","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```
```json
{"id":"01a0659b-54d1-74df-a19d-3a9adbe56bdb","playerId":"player-2","balance":{"amount":"100.00","currency":"BRL"},"version":1}
```

Guarde o `id` — ele é o `walletId` das chamadas seguintes.

### Uma aposta

```bash
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: bet-0002' \
  -d '{"providerId":"acme","externalTransactionId":"tx-0002","playerId":"player-2",
       "walletId":"<walletId>","roundId":"round-1","gameId":"game-1","kind":"BET",
       "money":{"amount":"30.00","currency":"BRL"}}'
```
```json
{"transactionId":"01a0659b-56ea-7049-ba56-807c0a02fe90","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}
```

### As três respostas que mais dizem sobre o sistema

**Replay** — mesma `Idempotency-Key`, mesmo payload. Nenhum débito novo; o saldo devolvido é o que a operação original observou:

```json
{"transactionId":"01a0659b-56ea-7049-ba56-807c0a02fe90","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":true}
```
`HTTP 200`

**Conflito** — mesma `Idempotency-Key`, payload divergente. Não é replay, é erro do provedor:

```json
{"message":"idempotency key bet-0002 já registrada com outro payload na transação 01a0659b-56ea-7049-ba56-807c0a02fe90 (RN-14).","failureCode":"IDEMPOTENCY_CONFLICT"}
```
`HTTP 409`

**Saldo insuficiente** — uma aposta de `5000.00` sobre `70.00`. A transação **existe** e fica registrada como `REJECTED`, com evento publicado; ela não é um erro de protocolo:

```json
{"transactionId":"01a0659b-8173-761a-a6fb-734aaa5ef1c8","status":"REJECTED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false,"failureCode":"INSUFFICIENT_FUNDS"}
```
`HTTP 422`

### O ledger e a reconciliação

```bash
curl -s "localhost:3000/wallets/<walletId>/ledger?limit=2"
```
```json
{"entries":[
  {"id":"01a0659b-54d1-74e1-a3c8-61a0253419ab","transactionId":"01a0659b-54d1-74e0-933d-9dedd250393c","direction":"CREDIT","money":{"amount":"100.00","currency":"BRL"},"balanceBefore":{"amount":"0.00","currency":"BRL"},"balanceAfter":{"amount":"100.00","currency":"BRL"},"createdAt":"2026-09-03T04:51:13.745Z"},
  {"id":"01a0659b-56ea-704a-b09d-abf7535bb4db","transactionId":"01a0659b-56ea-7049-ba56-807c0a02fe90","direction":"DEBIT","money":{"amount":"30.00","currency":"BRL"},"balanceBefore":{"amount":"100.00","currency":"BRL"},"balanceAfter":{"amount":"70.00","currency":"BRL"},"createdAt":"2026-09-03T04:51:14.277Z"}
],"nextCursor":null}
```

```bash
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation
```
```json
{"walletId":"01a0659b-54d1-74df-a19d-3a9adbe56bdb","storedBalance":{"amount":"70.00","currency":"BRL"},"calculatedBalance":{"amount":"70.00","currency":"BRL"},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":2}
```

A reconciliação **acusa** divergência e não a corrige. Corrigir em silêncio destrói a evidência de que houve um defeito.

### A mesma operação, pela fila

O caminho por SQS não é um segundo caso de uso — é a **mesma** `ProcessWagerTransaction`, com a inbox entrando na mesma transação:

```bash
QURL=$(docker exec wagering-localstack awslocal sqs get-queue-url \
  --queue-name wager-transactions.fifo --output text)

docker exec wagering-localstack awslocal sqs send-message --queue-url "$QURL" \
  --message-group-id "<walletId>" --message-deduplication-id "msg-0001" \
  --message-body '{"messageId":"msg-0001","type":"WagerTransactionRequested","correlationId":"corr-0001","data":{"idempotencyKey":"bet-sqs-0001","providerId":"acme","externalTransactionId":"tx-sqs-0001","playerId":"player-2","walletId":"<walletId>","roundId":"round-2","gameId":"game-1","kind":"BET","money":{"amount":"20.00","currency":"BRL"}}}'
```

Um segundo depois, o saldo caiu de `70.00` para `50.00` e o `correlationId` do envelope atravessou até a transação persistida:

```json
{"id":"01a0659c-20f0-7547-b74e-86b0a408d8e7","providerId":"acme","externalTransactionId":"tx-sqs-0001","kind":"BET","money":{"amount":"20.00","currency":"BRL"},"status":"PROCESSED","observedBalance":{"amount":"50.00","currency":"BRL"},"correlationId":"corr-0001", ...}
```

### As métricas se movendo

```bash
curl -s localhost:3000/metrics | grep -E '^wager_|^wallet_|^outbox_'
```
```
wager_transactions_total{status="PROCESSED",kind="BET"} 2
wager_transactions_total{status="REJECTED",kind="BET"} 1
wager_duplicates_total{source="http"} 1
wager_dlq_messages_total 0
wallet_lock_wait_seconds_count 5
wager_processing_seconds_count{source="http"} 4
wallet_reconciliation_checks_total{consistent="true"} 1
outbox_lag_seconds 0
```

### O evento chegando ao SQS

As três filas são provisionadas pelo próprio serviço, de forma idempotente:

```bash
docker exec wagering-localstack awslocal sqs list-queues
```
```
wager-transactions.fifo
wager-transactions-dlq.fifo
wagering-events.fifo
```

E a outbox drenou para a fila de saída de verdade:

```bash
docker exec wagering-localstack awslocal sqs get-queue-attributes \
  --queue-url "$(docker exec wagering-localstack awslocal sqs get-queue-url --queue-name wagering-events.fifo --output text)" \
  --attribute-names ApproximateNumberOfMessages
```
```json
{"Attributes": {"ApproximateNumberOfMessages": "7"}}
```

---

## Comandos

| Comando | O que faz | Precisa de infraestrutura? |
|---|---|---|
| `bun run start` | sobe HTTP (`:3000`) + os três laços de mensageria | PostgreSQL e SQS de pé |
| `bun run migration:up` | aplica todas as migrations pendentes | PostgreSQL de pé |
| `bun run migration:down` | reverte **um** lote | PostgreSQL de pé |
| `bun run check` | `typecheck` + `lint` + testes de unidade | **não** |
| `bun run check:full` | o `check` acima **mais** integração e concorrência | Docker (autoprovisiona) |
| `bun run typecheck` | `tsc --noEmit` | não |
| `bun run lint` | ESLint, incluindo as guardas de dinheiro e de fronteira de camada | não |
| `bun run test:unit` | só a suíte de unidade | não |
| `bun run test:integration` | só integração | PostgreSQL e SQS de pé |
| `bun run test:concurrency` | só concorrência (sobe processos de verdade) | PostgreSQL e SQS de pé |

---

## Superfície HTTP

| Método | Rota | Status possíveis |
|---|---|---|
| `POST` | `/wallets` | `201` · `400` · `409` · `503` |
| `GET` | `/wallets/:walletId` | `200` · `400` · `404` |
| `GET` | `/wallets/:walletId/ledger` | `200` · `400` · `404` |
| `POST` | `/wallets/:walletId/reconciliation` | `200` · `400` · `404` |
| `POST` | `/wagering/transactions` | `200` · `202` · `400` · `409` · `422` · `503` |
| `GET` | `/wagering/transactions/:transactionId` | `200` · `400` · `404` |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | `200` · `404` |
| `GET` | `/health/live` | `200` |
| `GET` | `/health/ready` | `200` · `503` |
| `GET` | `/metrics` | `200` (texto Prometheus) |

Os cinco desfechos de `POST /wagering/transactions` são códigos **distintos** por decisão, e cada um diz ao provedor o que fazer em seguida:

| Código | Significado | O provedor deve |
|---|---|---|
| `200` | aplicada (ou replay idempotente) | seguir |
| `202` | aceita, aguardando a referência chegar | consultar depois |
| `400` | payload malformado | corrigir e reenviar |
| `409` | mesma chave de idempotência com payload divergente | **não** reenviar; investigar |
| `422` | recusada por regra de negócio, com `failureCode` | corrigir; reenviar não muda nada |
| `503` | indisponibilidade transitória | reenviar |

`Idempotency-Key` é header obrigatório na submissão, e **não** entra no hash do payload — é isso que permite a mesma operação chegar por HTTP e por fila produzindo o mesmo hash. `X-Correlation-Id` é opcional: quando ausente, o serviço gera um e o devolve no header da resposta.

---

## Mensageria

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada — comandos de operação |
| `wager-transactions-dlq.fifo` | erro permanente, por envio explícito **ou** por redrive policy |
| `wagering-events.fifo` | saída — eventos de integração publicados pela outbox |

Todas FIFO, todas provisionadas pelo próprio serviço na primeira publicação. Envelope aceito na fila de entrada:

```json
{
  "messageId": "msg-0001",
  "type": "WagerTransactionRequested",
  "correlationId": "corr-0001",
  "data": {
    "idempotencyKey": "bet-sqs-0001",
    "providerId": "acme",
    "externalTransactionId": "tx-sqs-0001",
    "playerId": "player-2",
    "walletId": "<walletId>",
    "roundId": "round-2",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "20.00", "currency": "BRL" },
    "referenceExternalTransactionId": "<obrigatório em REFUND e ROLLBACK>"
  }
}
```

O `messageId` do **corpo** é a chave da inbox, não o id de transporte do SQS: é o único dos dois que sobrevive a um reenvio do produtor. `correlationId` é opcional e cai no `messageId` quando ausente. `MessageGroupId` deve ser o `walletId` — é o que faz o FIFO ordenar por wallet sem serializar wallets sem relação entre si.

---

## Logs

O boot usa o logger do NestJS; tudo que é de domínio sai em **JSON de uma linha**, com os campos de correlação e **sem payload financeiro**:

```json
{"timestamp":"2026-09-03T04:51:14.291Z","level":"info","event":"wager.transaction.processed","correlationId":"01a0659b-56e3-74dd-80bc-7e90d597a0ef","transactionId":"01a0659b-56ea-7049-ba56-807c0a02fe90","walletId":"01a0659b-54d1-74df-a19d-3a9adbe56bdb","providerId":"acme","kind":"BET","status":"PROCESSED"}
```

O conjunto de campos é **fechado em tipo**: acrescentar um campo ao log exige acrescentá-lo ao tipo, e é aí que a pergunta "isso é dado financeiro?" acontece — em vez de não acontecer.

---

## Testes

A infraestrutura de teste é **híbrida**, e os dois caminhos populam exatamente as mesmas variáveis de ambiente:

```bash
bun run check
```
Typecheck, lint e testes de unidade. **Não precisa de Docker** — roda em qualquer máquina, em segundos. É o comando do loop de desenvolvimento.

```bash
bun run check:full
```
O `check` acima mais as suítes de integração e de concorrência. **Sobe PostgreSQL e LocalStack sozinho, via Testcontainers** — não use o Compose para isto; os containers são efêmeros e em portas aleatórias, então rodar com o Compose de pé não conflita.

Nenhum teste substitui PostgreSQL ou SQS por mock. Os testes de concorrência sobem **processos de sistema operacional** de verdade e os matam com `SIGKILL` no meio do trabalho — é a única forma de provar recuperação de crash.

---

## Solução de problemas

**`28P01` (autenticação falhou) com o container saudável e as credenciais certas.**
Uma instalação nativa de PostgreSQL na máquina está ocupando a `5432` e respondendo antes do proxy do Docker. Por isso o Compose publica em **`55432`**, e `PGPORT` é lido pelo Compose *e* pela aplicação — uma fonte de verdade só. Se a `55432` também estiver ocupada, troque **apenas** essa linha do `.env`.

**LocalStack encerra com exit 55 / "License activation failed".**
A linha `2026.x` exige token de licença. A imagem está fixada em **`localstack/localstack:4.14.0`**, o último release community. Não atualize a tag.

**`ECONNREFUSED` no `migration:up` logo depois do `up -d`.**
O container subiu mas o PostgreSQL ainda não aceita conexões. Use `docker compose up -d --wait`, que espera o healthcheck.

**A porta `3000` está ocupada.**
Mude `PORT` no `.env`. Valor inválido cai no padrão em vez de derrubar o boot.

**`check:full` falha sem sair do lugar.**
Ele precisa de Docker rodando para os Testcontainers. Confirme com `docker ps`.

---

## Documentação

| Arquivo | Conteúdo |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | decisões, trade-offs, limitações conhecidas e o desenho de auth não implementada |
| [docs/desafio-original.md](docs/desafio-original.md) | enunciado íntegro — fonte da verdade final |
| [docs/requirements.md](docs/requirements.md) | requisitos numerados, restrições invioláveis, falhas eliminatórias e testes obrigatórios |
| [docs/decisions.md](docs/decisions.md) | as 63 decisões registradas, com contexto e alternativas descartadas |
| [docs/implementation-plan.md](docs/implementation-plan.md) | roteiro de implementação e o que cada etapa deixou para a seguinte |
