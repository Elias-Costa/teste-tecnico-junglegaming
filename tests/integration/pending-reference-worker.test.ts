/**
 * E-13 — o worker de referências fora de ordem contra o PostgreSQL real: **RT-20**.
 *
 * O cenário que dá nome à etapa é o da §10 do enunciado: a fila entrega um
 * `ROLLBACK` **antes** da `BET` que ele estorna. Rejeitar seria errado — a `BET`
 * quase sempre vem no lote seguinte —, então a reversão espera (RN-15) e este
 * worker volta nela até resolver ou até o TTL de D-008 acabar (RF-26).
 *
 * O que se prova aqui, na ordem em que os testes aparecem:
 *
 *  - **RT-20** — `ROLLBACK` e `REFUND` entregues antes da referência, resolvidos
 *    depois, com saldo, ledger e eventos idênticos aos da ordem normal;
 *  - **RF-26** — esgotado o TTL, a espera vira `REJECTED` com
 *    `REFERENCE_NOT_FOUND` **e evento publicado**. É o emissor que faltava para o
 *    11º código de negócio de D-007;
 *  - **D-052** — a varredura enxerga a pendente recém-nascida, cujo
 *    `next_reference_attempt_at` é **nulo**, e o reagendamento avança pela curva
 *    de D-022 sem tocar no status;
 *  - **D-050** — a cadeia (`ROLLBACK` esperando um `REFUND` que também espera)
 *    desencalha inteira, na ordem cronológica dos ids;
 *  - **D-051** — referência que chega **inválida** é rejeitada pelo código da
 *    regra violada, não por `REFERENCE_NOT_FOUND`;
 *  - **EL-03** — uma pendente já resolvida por outro worker não é resolvida duas
 *    vezes, e o reagendamento não escreve sobre linha terminal.
 *
 * **Sem mock em ponto nenhum** (EL-08): PostgreSQL real, use case de produção,
 * store e worker de produção. O único elemento controlado é o **relógio**, que é
 * injetado por porta desde E-07 — e é o que permite provar um TTL de 15 minutos
 * sem esperar 15 minutos. Controlar o tempo não é substituir infraestrutura: o
 * banco, a transação e o lock são todos de verdade.
 *
 * A invariante da §6.4 fecha cada cenário por `expectLedgerReconciles`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Clock } from "../../src/application/ports/clock.ts";
import type { IdGenerator } from "../../src/application/ports/id-generator.ts";
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from "../../src/application/process-wager-transaction.ts";
import { BusinessFailureCode } from "../../src/domain/failure-code.ts";
import { Money } from "../../src/domain/money.ts";
import type { RetryPolicy } from "../../src/domain/retry-policy.ts";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import { PendingReferenceStore } from "../../src/infrastructure/messaging/pending-reference-store.ts";
import { PendingReferenceWorker } from "../../src/infrastructure/messaging/pending-reference-worker.ts";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { MikroWalletRepository } from "../../src/infrastructure/persistence/repositories/mikro-wallet-repository.ts";
import { outboxMessageRowSchema } from "../../src/infrastructure/persistence/rows/outbox-message-row.ts";
import type { WagerTransactionRow } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import { wagerTransactionRowSchema } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import { walletLedgerEntryRowSchema } from "../../src/infrastructure/persistence/rows/wallet-ledger-entry-row.ts";
import { expectLedgerReconciles } from "../support/concurrency-harness.ts";

let orm: MikroORM;

const INICIO = new Date("2026-09-02T10:00:00.000Z");
const PROVIDER = "provider-referencia";

/** Quinze minutos, o TTL de produção de D-008 — usado como número, não como espera. */
const TTL_MS = 900_000;

/**
 * Curva determinística e curta.
 *
 * `random: () => 0` fixa o equal jitter no **piso**, então o atraso é exatamente
 * `capped / 2` e o teste pode afirmar o instante em vez de aceitar um intervalo.
 * Continua sendo a curva de D-022 — o que muda são os números, que D-008 tornou
 * parametrizáveis justamente para isto.
 */
const CURVA_CURTA: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 4_000, random: () => 0 };

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

/** UUIDv7 (D-014) — `crypto.randomUUID()` é v4 e não serve como id neste projeto. */
function novoId(): string {
  return Bun.randomUUIDv7();
}

function unico(prefixo: string): string {
  return `${prefixo}-${novoId()}`;
}

/**
 * Relógio que anda quando o teste manda.
 *
 * A porta `Clock` existe desde E-07 e o worker a usa como qualquer outro
 * colaborador; o que este teste faz é adiantá-la. É a única forma de exercer um
 * TTL de 15 minutos numa suíte que precisa rodar em segundos **sem** trocar o
 * mecanismo por um substituto (EL-08) — o banco, a transação e o lock continuam
 * reais, e é sobre eles que as asserções falam.
 */
class RelogioAjustavel implements Clock {
  private instante: Date;

  constructor(inicio: Date) {
    this.instante = inicio;
  }

  now(): Date {
    return this.instante;
  }

  avancar(ms: number): void {
    this.instante = new Date(this.instante.getTime() + ms);
  }
}

/** Gerador de ids de produção; nenhuma colisão programada é necessária aqui. */
const ids: IdGenerator = { next: novoId };

interface Cenario {
  relogio: RelogioAjustavel;
  useCase: ProcessWagerTransaction;
  store: PendingReferenceStore;
  worker: PendingReferenceWorker;
  erros: unknown[];
}

/**
 * Monta use case, store e worker sobre o mesmo relógio.
 *
 * O worker recebe o **mesmo** `ProcessWagerTransaction` que a borda HTTP usaria:
 * é o ponto de D-054 — a decisão de uma reversão é uma só, e o caminho de fundo
 * não tem regra própria.
 */
function cenario(ttlMs = TTL_MS): Cenario {
  const relogio = new RelogioAjustavel(INICIO);
  const useCase = new ProcessWagerTransaction(new MikroUnitOfWork(orm.em), relogio, ids);
  const store = new PendingReferenceStore(orm.em);
  const erros: unknown[] = [];

  const worker = new PendingReferenceWorker(store, useCase, relogio, CURVA_CURTA, {
    batchSize: 10,
    ttlMs,
    pollIntervalMs: 10,
    onCycleError: (erro) => erros.push(erro),
  });

  return { relogio, useCase, store, worker, erros };
}

/** Wallet aberta com saldo, `OPENING` aplicada e lançamento de abertura (RF-08). */
async function semearWallet(valor = "100.00"): Promise<Wallet> {
  const walletId = novoId();
  const openingTransactionId = novoId();

  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: unico("player"),
    initialBalance: brl(valor),
    openingTransactionId,
    openingEntryId: novoId(),
    at: INICIO,
  });

  const opening = WagerTransaction.create({
    id: openingTransactionId,
    providerId: PROVIDER,
    externalTransactionId: unico("ext-opening"),
    idempotencyKey: unico("idem-opening"),
    payloadHash: "0".repeat(64),
    correlationId: unico("corr-opening"),
    walletId,
    playerId: wallet.playerId,
    roundId: unico("round-opening"),
    gameId: "abertura",
    kind: WagerTransactionKind.Opening,
    money: brl(valor),
    createdAt: INICIO,
  });
  opening.markProcessed(undefined, wallet.balance, INICIO);

  await new MikroUnitOfWork(orm.em).run(async (repos) => {
    await repos.wallets.insert(wallet);
    await repos.transactions.insert(opening);

    if (openingEntry !== undefined) {
      await repos.ledger.insert(openingEntry);
    }
  });

  return wallet;
}

function comando(
  wallet: Wallet,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  return {
    idempotencyKey: unico("idem"),
    providerId: PROVIDER,
    externalTransactionId: unico("ext"),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: unico("round"),
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    correlationId: unico("corr"),
    ...overrides,
  };
}

async function saldoDe(walletId: string): Promise<string | undefined> {
  const wallet = await new MikroWalletRepository(orm.em.fork()).findById(walletId);

  return wallet?.balance.toJSON().amount;
}

/** A linha da transação, como o banco a guardou — inclusive as colunas de D-052. */
async function linhaDe(id: string): Promise<WagerTransactionRow | undefined> {
  const [row] = await orm.em
    .fork()
    .find(wagerTransactionRowSchema, { id }, { disableIdentityMap: true });

  return row;
}

async function eventosDe(aggregateId: string): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .find(outboxMessageRowSchema, { aggregateId }, { disableIdentityMap: true });

  return rows.map((row) => row.eventType);
}

async function lancamentosDe(walletId: string): Promise<number> {
  const rows = await orm.em
    .fork()
    .find(walletLedgerEntryRowSchema, { walletId }, { disableIdentityMap: true });

  return rows.length;
}

/**
 * Empurra as pendentes dos cenários anteriores para fora do horizonte deste teste.
 *
 * A varredura de RF-26 é **global** de propósito — ela é a fila de trabalho do
 * sistema inteiro, não a de uma wallet —, então uma pendente deixada por um
 * cenário anterior entraria na contagem do seguinte e o `scanned` deixaria de
 * significar o que o teste afirma.
 *
 * Adiar, e não apagar: o ledger e as FKs de referência apontam para essas linhas,
 * e removê-las desfaria o que o cenário anterior provou. Um ano à frente está bem
 * fora de qualquer relógio que estes testes adiantam.
 */
async function adiarPendentesAnteriores(): Promise<void> {
  await orm.em
    .fork()
    .nativeUpdate(
      wagerTransactionRowSchema,
      { status: WagerTransactionStatus.PendingReference },
      { nextReferenceAttemptAt: new Date(INICIO.getTime() + 365 * 24 * 60 * 60 * 1_000) },
    );
}

beforeAll(async () => {
  orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
});

beforeEach(adiarPendentesAnteriores);

afterAll(async () => {
  await orm.close(true);
});

describe("RT-20 — reversão entregue antes da referência", () => {
  it("ROLLBACK espera, e resolve quando a BET chega", async () => {
    const { useCase, worker, erros } = cenario();
    const wallet = await semearWallet("100.00");
    const rodada = unico("round");
    const extAposta = unico("ext-aposta");

    // (1) O `ROLLBACK` chega primeiro. A `BET` que ele estorna não existe.
    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        roundId: rodada,
        referenceExternalTransactionId: extAposta,
      }),
    );

    // RN-15: aceito e aguardando, não rejeitado. O saldo da resposta é o
    // **corrente** da wallet travada (D-053) — não há desfecho a preservar.
    expect(estorno.status).toBe(WagerTransactionStatus.PendingReference);
    expect(estorno.balance.amount).toBe("100.00");
    expect(await eventosDe(estorno.transactionId)).toEqual(["WagerTransactionPendingReference"]);
    expect(await lancamentosDe(wallet.id)).toBe(1);

    // (2) A `BET` chega e é aplicada normalmente.
    const aposta = await useCase.execute(
      comando(wallet, { roundId: rodada, externalTransactionId: extAposta }),
    );

    expect(aposta.status).toBe(WagerTransactionStatus.Processed);
    expect(await saldoDe(wallet.id)).toBe("75.00");

    // (3) O worker volta na pendente e a resolve.
    const ciclo = await worker.runOnce();

    expect(erros).toEqual([]);
    expect(ciclo).toMatchObject({ scanned: 1, resolved: 1, rejected: 0, rescheduled: 0 });

    const linha = await linhaDe(estorno.transactionId);

    expect(linha?.status).toBe(WagerTransactionStatus.Processed);
    // RN-07: o id **interno** da referência, resolvido a partir do id externo.
    expect(linha?.referenceTransactionId).toBe(aposta.transactionId);
    // RN-05: a direção é o inverso da referência — estornar uma `BET` credita.
    expect(await saldoDe(wallet.id)).toBe("100.00");
    expect(await lancamentosDe(wallet.id)).toBe(3);

    // RF-25: o desfecho publica os mesmos dois eventos que publicaria se a
    // reversão tivesse chegado depois da `BET`. O `PendingReference` continua lá:
    // ele descreve um fato que aconteceu, não um estado atual.
    expect(await eventosDe(estorno.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
    ]);
    expect(await eventosDe(wallet.id)).toContain("WalletBalanceChanged");

    await expectLedgerReconciles(orm, wallet.id);
  });

  it("REFUND espera, e resolve quando a BET chega", async () => {
    const { useCase, worker } = cenario();
    const wallet = await semearWallet("100.00");
    const rodada = unico("round");
    const extAposta = unico("ext-aposta");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Refund,
        roundId: rodada,
        referenceExternalTransactionId: extAposta,
      }),
    );

    expect(estorno.status).toBe(WagerTransactionStatus.PendingReference);

    await useCase.execute(comando(wallet, { roundId: rodada, externalTransactionId: extAposta }));

    expect(await saldoDe(wallet.id)).toBe("75.00");
    expect(await worker.runOnce()).toMatchObject({ resolved: 1 });

    // RN-04: `REFUND` sempre credita, e reverte a `BET` uma única vez.
    expect(await saldoDe(wallet.id)).toBe("100.00");
    expect((await linhaDe(estorno.transactionId))?.status).toBe(WagerTransactionStatus.Processed);

    await expectLedgerReconciles(orm, wallet.id);
  });

  it("a correlação da submissão sobrevive ao desfecho publicado pelo worker (D-055)", async () => {
    const { useCase, worker } = cenario();
    const wallet = await semearWallet("100.00");
    const rodada = unico("round");
    const extAposta = unico("ext-aposta");
    const correlacao = unico("corr-do-provedor");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        roundId: rodada,
        referenceExternalTransactionId: extAposta,
        correlationId: correlacao,
      }),
    );

    await useCase.execute(comando(wallet, { roundId: rodada, externalTransactionId: extAposta }));
    await worker.runOnce();

    const linhas = await orm.em
      .fork()
      .find(
        outboxMessageRowSchema,
        { aggregateId: estorno.transactionId },
        { disableIdentityMap: true },
      );

    // A correlação viaja **dentro do envelope** (RF-07), que é o que a outbox
    // guarda em `payload`: os dois eventos da mesma transação carregam a mesma,
    // apesar de terem nascido com minutos de distância e fora da mesma
    // requisição. Sem a coluna de D-055, o segundo teria uma correlação inventada
    // e o rastro de RNF-06 se romperia justamente no desfecho.
    expect(linhas.map((linha) => linha.payload["correlationId"])).toEqual([
      correlacao,
      correlacao,
    ]);

    // E o `causationId` do desfecho aponta para a transação que o causou — o elo
    // que substitui a requisição ausente.
    expect(linhas[1]?.payload["causationId"]).toBe(estorno.transactionId);

    await expectLedgerReconciles(orm, wallet.id);
  });
});

describe("RF-26 — TTL esgotado", () => {
  it("rejeita com REFERENCE_NOT_FOUND e publica o evento, sem tocar no saldo", async () => {
    const { relogio, useCase, worker } = cenario();
    const wallet = await semearWallet("100.00");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: unico("ext-que-nunca-chega"),
      }),
    );

    expect(estorno.status).toBe(WagerTransactionStatus.PendingReference);

    // Um segundo além do TTL: a transação nasceu em `INICIO`, e o prazo é
    // `agora - 15 min`. É a paciência acabando, não uma contagem de varreduras.
    relogio.avancar(TTL_MS + 1_000);

    const ciclo = await worker.runOnce();

    expect(ciclo).toMatchObject({ scanned: 1, resolved: 0, rejected: 1, rescheduled: 0 });

    const linha = await linhaDe(estorno.transactionId);

    expect(linha?.status).toBe(WagerTransactionStatus.Rejected);
    expect(linha?.failureCode).toBe(BusinessFailureCode.ReferenceNotFound);
    // RN-11: rejeição não altera saldo nem gera ledger. Só o lançamento de
    // abertura continua lá.
    expect(await saldoDe(wallet.id)).toBe("100.00");
    expect(await lancamentosDe(wallet.id)).toBe(1);
    // RN-12/D-030: a rejeição registra o saldo que respondeu.
    expect(linha?.observedBalance).toBe("100.00");

    // RF-26 cobra o evento **junto** da rejeição, e não só a mudança de status.
    expect(await eventosDe(estorno.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);

    await expectLedgerReconciles(orm, wallet.id);
  });

  it("dentro do prazo continua esperando, mesmo sem a referência", async () => {
    const { relogio, useCase, worker } = cenario();
    const wallet = await semearWallet("100.00");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: unico("ext-atrasada"),
      }),
    );

    // Um segundo **antes** do prazo. A `BET` ainda pode chegar (RN-15).
    relogio.avancar(TTL_MS - 1_000);

    expect(await worker.runOnce()).toMatchObject({ rejected: 0, rescheduled: 1 });
    expect((await linhaDe(estorno.transactionId))?.status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    await expectLedgerReconciles(orm, wallet.id);
  });
});

describe("D-052 — varredura e reagendamento pelas colunas de retry", () => {
  it("a pendente recém-nascida tem agendamento nulo e mesmo assim é varrida", async () => {
    const { useCase, store, worker } = cenario();
    const wallet = await semearWallet("100.00");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: unico("ext-ausente"),
      }),
    );

    const recemNascida = await linhaDe(estorno.transactionId);

    // É o que E-12 deixou anotado: `decideReversal` grava a pendente deixando
    // valer os defaults da tabela. Uma varredura que só comparasse datas
    // deixaria a **primeira** tentativa de toda transação invisível — ou seja,
    // não resolveria nada.
    expect(recemNascida?.referenceAttempts).toBe(0);
    expect(recemNascida?.nextReferenceAttemptAt).toBeNull();

    const devidas = await store.findDue(INICIO, 10);

    expect(devidas.map((devida) => devida.id)).toContain(estorno.transactionId);

    await worker.runOnce();

    const reagendada = await linhaDe(estorno.transactionId);

    // A curva de D-022 com jitter no piso: `min(4000, 1000 · 2^0) / 2` = 500 ms.
    expect(reagendada?.referenceAttempts).toBe(1);
    expect(reagendada?.nextReferenceAttemptAt).toEqual(new Date(INICIO.getTime() + 500));
    // Reagendar **não** é transição (D-013): o status não se move.
    expect(reagendada?.status).toBe(WagerTransactionStatus.PendingReference);

    await expectLedgerReconciles(orm, wallet.id);
  });

  it("um update de status não apaga o reagendamento, e o reagendamento não muda o status", async () => {
    const { useCase, store, worker } = cenario();
    const wallet = await semearWallet("100.00");
    const rodada = unico("round");
    const extAposta = unico("ext-aposta");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        roundId: rodada,
        referenceExternalTransactionId: extAposta,
      }),
    );

    // Três tentativas já registradas pelo caminho de D-052.
    await store.scheduleRetry(estorno.transactionId, 3, new Date(INICIO.getTime() - 1_000));

    await useCase.execute(comando(wallet, { roundId: rodada, externalTransactionId: extAposta }));

    expect(await worker.runOnce()).toMatchObject({ resolved: 1 });

    const linha = await linhaDe(estorno.transactionId);

    // As duas escritas tocam a mesma linha e **nenhuma pisa na outra**: o
    // `update` do agregado moveu o status sem zerar o contador, porque as colunas
    // de retry estão fora do `Pick<WagerTransactionUpdate>` (D-028, D-052). O
    // contador sobrevive como o que ele é — o registro de quantas vezes se tentou.
    expect(linha?.status).toBe(WagerTransactionStatus.Processed);
    expect(linha?.referenceAttempts).toBe(3);

    await expectLedgerReconciles(orm, wallet.id);
  });

  it("pendente agendada para o futuro não é varrida, e volta a ser quando vence", async () => {
    const { relogio, useCase, worker } = cenario();
    const wallet = await semearWallet("100.00");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: unico("ext-ausente"),
      }),
    );

    expect(await worker.runOnce()).toMatchObject({ scanned: 1, rescheduled: 1 });

    // Mesmo instante: o agendamento de 500 ms ainda não venceu. É o backoff
    // fazendo o worker parar de bater na mesma linha a cada ciclo.
    const semAvancar = await worker.runOnce();

    expect(semAvancar.scanned).toBe(0);

    relogio.avancar(1_000);

    const depois = await worker.runOnce();

    expect(depois).toMatchObject({ scanned: 1, rescheduled: 1 });
    // Segunda tentativa: `min(4000, 1000 · 2^1) / 2` = 1000 ms a partir de agora.
    expect((await linhaDe(estorno.transactionId))?.referenceAttempts).toBe(2);

    await expectLedgerReconciles(orm, wallet.id);
  });
});

describe("D-050 — cadeia de reversões fora de ordem", () => {
  it("ROLLBACK esperando um REFUND que também espera desencalha no mesmo ciclo", async () => {
    const { useCase, worker } = cenario();
    const wallet = await semearWallet("100.00");
    const rodada = unico("round");
    const extAposta = unico("ext-aposta");
    const extRefund = unico("ext-refund");

    // (1) O `REFUND` chega antes da `BET` que ele estorna.
    const refund = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Refund,
        roundId: rodada,
        externalTransactionId: extRefund,
        referenceExternalTransactionId: extAposta,
      }),
    );

    // (2) O `ROLLBACK` chega antes de o `REFUND` ter sido resolvido. A referência
    // **existe**, mas está ela própria aguardando: por D-050 ele espera também,
    // porque ela ainda pode virar `PROCESSED`.
    const rollback = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        roundId: rodada,
        referenceExternalTransactionId: extRefund,
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

    // (3) A `BET` finalmente chega.
    await useCase.execute(comando(wallet, { roundId: rodada, externalTransactionId: extAposta }));

    expect(await saldoDe(wallet.id)).toBe("75.00");

    // (4) Um ciclo só resolve os dois: a ordem por id é cronológica (UUIDv7), o
    // `REFUND` é mais antigo e cada resolução commita antes da seguinte começar.
    // Uma varredura que ignorasse a cadeia deixaria o `ROLLBACK` encalhado até o
    // TTL, mesmo com tudo já resolvido à sua volta.
    const ciclo = await worker.runOnce();

    expect(ciclo).toMatchObject({ scanned: 2, resolved: 2, rejected: 0 });

    expect((await linhaDe(refund.transactionId))?.status).toBe(WagerTransactionStatus.Processed);
    expect((await linhaDe(rollback.transactionId))?.status).toBe(WagerTransactionStatus.Processed);

    // `BET` −25, `REFUND` +25, `ROLLBACK` do `REFUND` −25 (RN-05: o inverso da
    // referência, e a referência creditou).
    expect(await saldoDe(wallet.id)).toBe("75.00");

    await expectLedgerReconciles(orm, wallet.id);
  });
});

describe("D-051 — a referência chega, mas inválida", () => {
  it("rejeita pelo código da regra violada, não por REFERENCE_NOT_FOUND", async () => {
    const { useCase, worker } = cenario();
    const wallet = await semearWallet("100.00");
    const rodada = unico("round");
    const extAposta = unico("ext-aposta");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        roundId: rodada,
        money: { amount: "30.00", currency: "BRL" },
        referenceExternalTransactionId: extAposta,
      }),
    );

    // A `BET` chega com **outro valor**: RN-10 proíbe reversão parcial.
    await useCase.execute(
      comando(wallet, {
        roundId: rodada,
        externalTransactionId: extAposta,
        money: { amount: "25.00", currency: "BRL" },
      }),
    );

    expect(await worker.runOnce()).toMatchObject({ resolved: 0, rejected: 1 });

    const linha = await linhaDe(estorno.transactionId);

    // O provedor precisa saber que o payload está errado, e não que a referência
    // sumiu: são ações diferentes do lado dele (D-007, D-051).
    expect(linha?.status).toBe(WagerTransactionStatus.Rejected);
    expect(linha?.failureCode).toBe(BusinessFailureCode.AmountMismatch);
    expect(await saldoDe(wallet.id)).toBe("75.00");

    await expectLedgerReconciles(orm, wallet.id);
  });
});

describe("EL-03 — a mesma pendente não é resolvida duas vezes", () => {
  it("resolver de novo não move saldo nem publica evento outra vez", async () => {
    const { useCase, worker } = cenario();
    const wallet = await semearWallet("100.00");
    const rodada = unico("round");
    const extAposta = unico("ext-aposta");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        roundId: rodada,
        referenceExternalTransactionId: extAposta,
      }),
    );

    await useCase.execute(comando(wallet, { roundId: rodada, externalTransactionId: extAposta }));
    await worker.runOnce();

    const saldoResolvido = await saldoDe(wallet.id);
    const eventosResolvidos = await eventosDe(estorno.transactionId);

    // Segunda chamada com o mesmo id, como faria um segundo worker que tivesse
    // varrido a linha antes de a primeira resolução commitar. A releitura sob o
    // lock da wallet vê o status já terminal e devolve sem escrever nada.
    const status = await useCase.resolvePendingReference(
      estorno.transactionId,
      new Date(INICIO.getTime() - TTL_MS),
    );

    expect(status).toBe(WagerTransactionStatus.Processed);
    expect(await saldoDe(wallet.id)).toBe(saldoResolvido);
    expect(await eventosDe(estorno.transactionId)).toEqual(eventosResolvidos);

    // E a varredura não a devolve mais: ela deixou de ser `PENDING_REFERENCE`.
    expect(await worker.runOnce()).toMatchObject({ scanned: 0 });

    await expectLedgerReconciles(orm, wallet.id);
  });

  it("o reagendamento não escreve sobre linha que já saiu de PENDING_REFERENCE", async () => {
    const { useCase, store, worker } = cenario();
    const wallet = await semearWallet("100.00");
    const rodada = unico("round");
    const extAposta = unico("ext-aposta");

    const estorno = await useCase.execute(
      comando(wallet, {
        kind: WagerTransactionKind.Rollback,
        roundId: rodada,
        referenceExternalTransactionId: extAposta,
      }),
    );

    await useCase.execute(comando(wallet, { roundId: rodada, externalTransactionId: extAposta }));
    await worker.runOnce();

    const antes = await linhaDe(estorno.transactionId);

    // O `status` no `where` de `scheduleRetry` é a guarda que substitui o lease da
    // outbox: sem ela, um worker atrasado gravaria agendamento numa linha
    // terminal — dado morto que faria uma leitura de incidente duvidar do status.
    await store.scheduleRetry(estorno.transactionId, 9, new Date(INICIO.getTime() + 60_000));

    const depois = await linhaDe(estorno.transactionId);

    expect(depois?.referenceAttempts).toBe(antes?.referenceAttempts);
    expect(depois?.nextReferenceAttemptAt).toEqual(antes?.nextReferenceAttemptAt ?? null);
    expect(depois?.status).toBe(WagerTransactionStatus.Processed);
  });

  it("id inexistente devolve undefined, sem abrir exceção", async () => {
    const { useCase } = cenario();

    // O worker só chama com ids que a varredura devolveu, então este caminho é
    // defesa de contrato: quem chamar com um id qualquer recebe "não há o que
    // resolver", e não um erro que o laço teria de classificar.
    expect(await useCase.resolvePendingReference(novoId(), INICIO)).toBeUndefined();
  });
});
