/**
 * Peças compartilhadas pelos testes de concorrência de E-09 (RT-14..RT-17).
 *
 * Existe por um motivo específico e não por gosto de fatorar: a **invariante
 * final da §6.4** — `wallet.balance == saldo reconstruído pelo ledger` — precisa
 * valer nos quatro cenários, e um requisito que cada arquivo reimplementa do seu
 * jeito é um requisito que passa a valer de quatro jeitos. `expectLedgerReconciles`
 * é o único lugar do projeto que responde a essa pergunta.
 *
 * Nada aqui substitui infraestrutura (EL-08): a semeadura usa o domínio e os
 * repositórios de produção contra o PostgreSQL real, e as leituras de conferência
 * vão direto às tabelas, sem passar pelo código que está sendo testado.
 */
import { expect } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { ProcessWagerTransactionCommand } from "../../src/application/process-wager-transaction.ts";
import { LedgerDirection } from "../../src/domain/ledger-direction.ts";
import { Money } from "../../src/domain/money.ts";
import { WagerTransaction, WagerTransactionKind } from "../../src/domain/wager-transaction.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work.ts";
import { MikroWalletRepository } from "../../src/infrastructure/persistence/repositories/mikro-wallet-repository.ts";
import { outboxMessageRowSchema } from "../../src/infrastructure/persistence/rows/outbox-message-row.ts";
import type { WagerTransactionRow } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import { wagerTransactionRowSchema } from "../../src/infrastructure/persistence/rows/wager-transaction-row.ts";
import type { WalletLedgerEntryRow } from "../../src/infrastructure/persistence/rows/wallet-ledger-entry-row.ts";
import { walletLedgerEntryRowSchema } from "../../src/infrastructure/persistence/rows/wallet-ledger-entry-row.ts";

/** Moeda única destes cenários — o conflito de moeda é assunto de RT-04. */
export const MOEDA = "BRL";

/** Provedor fictício das submissões; nenhum deles é o `internal` de D-033. */
const PROVIDER = "provider-concorrencia";

/** UUIDv7 (D-014) — `crypto.randomUUID()` é v4 e não serve como id neste projeto. */
export function novoId(): string {
  return Bun.randomUUIDv7();
}

/** Sufixo único, para que um cenário não falhe pela unicidade que outro exercitou. */
export function unico(prefixo: string): string {
  return `${prefixo}-${novoId()}`;
}

/** Atalho de leitura: todo valor destes testes é `BRL`. */
export function brl(amount: string): Money {
  return Money.from({ amount, currency: MOEDA });
}

/** Wallet aberta, com a `OPENING` e o lançamento de abertura já gravados (RF-08). */
export interface CarteiraSemeada {
  id: string;
  playerId: string;
}

/**
 * Abre uma wallet com saldo, pelo domínio e pelos repositórios reais.
 *
 * Deliberadamente **não** passa pelo use case `OpenWallet`: ele publicaria os dois
 * eventos de D-034 na outbox, e os testes de E-09 contam linhas de outbox para
 * provar que 50 submissões idênticas produzem os eventos de **uma** (EL-03,
 * EL-06). Semear pelo caminho de baixo deixa a outbox limpa, e a abertura em si
 * já tem prova própria em `tests/integration/http-write-api.test.ts`.
 */
export async function semearCarteira(orm: MikroORM, amount: string): Promise<CarteiraSemeada> {
  const walletId = novoId();
  const openingTransactionId = novoId();
  const agora = new Date();

  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: unico("player"),
    initialBalance: brl(amount),
    openingTransactionId,
    openingEntryId: novoId(),
    at: agora,
  });

  const opening = WagerTransaction.create({
    id: openingTransactionId,
    providerId: PROVIDER,
    externalTransactionId: unico("ext-opening"),
    idempotencyKey: unico("idem-opening"),
    payloadHash: "0".repeat(64),
    walletId,
    playerId: wallet.playerId,
    roundId: unico("round-opening"),
    gameId: "abertura",
    kind: WagerTransactionKind.Opening,
    money: brl(amount),
    createdAt: agora,
  });
  opening.markProcessed(undefined, wallet.balance, agora);

  // `openingEntry` é `undefined` só quando o saldo inicial é zero, e nenhum
  // cenário de E-09 semeia wallet vazia — disputa por saldo exige saldo.
  if (openingEntry === undefined) {
    throw new Error("a semeadura de E-09 exige saldo inicial acima de zero.");
  }

  await new MikroUnitOfWork(orm.em).run(async (repos) => {
    await repos.wallets.insert(wallet);
    await repos.transactions.insert(opening);
    await repos.ledger.insert(openingEntry);
  });

  return { id: walletId, playerId: wallet.playerId };
}

/**
 * Comando de `BET` pronto, com identidade única por padrão.
 *
 * Os `overrides` são o que cada cenário precisa fixar: RT-14 repassa a **mesma**
 * `idempotencyKey` e o **mesmo** `externalTransactionId` às 50 execuções, porque
 * é isso que faz delas a mesma aposta.
 */
export function comandoDeAposta(
  carteira: CarteiraSemeada,
  amount: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  return {
    idempotencyKey: unico("idem"),
    providerId: PROVIDER,
    externalTransactionId: unico("ext"),
    playerId: carteira.playerId,
    walletId: carteira.id,
    roundId: unico("round"),
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: MOEDA },
    correlationId: unico("corr"),
    ...overrides,
  };
}

/** Saldo persistido da wallet, lido num `em` novo — o que o banco guardou. */
export async function saldoDe(orm: MikroORM, walletId: string): Promise<Money> {
  const wallet = await new MikroWalletRepository(orm.em.fork()).findById(walletId);

  if (wallet === undefined) {
    throw new Error(`wallet ${walletId} não existe`);
  }

  return wallet.balance;
}

/** `version` da wallet — RF-02 manda incrementar só quando o saldo muda. */
export async function versaoDe(orm: MikroORM, walletId: string): Promise<number> {
  const wallet = await new MikroWalletRepository(orm.em.fork()).findById(walletId);

  return wallet?.version ?? -1;
}

/** Lançamentos da wallet, na ordem do cursor de D-014 (id UUIDv7 é temporal). */
export async function lancamentosDe(
  orm: MikroORM,
  walletId: string,
): Promise<WalletLedgerEntryRow[]> {
  return orm.em
    .fork()
    .find(walletLedgerEntryRowSchema, { walletId }, { disableIdentityMap: true, orderBy: { id: "asc" } });
}

/** Só os débitos — é a contagem que RT-14 e RT-15 cobram. */
export async function debitosDe(
  orm: MikroORM,
  walletId: string,
): Promise<WalletLedgerEntryRow[]> {
  const lancamentos = await lancamentosDe(orm, walletId);

  return lancamentos.filter((entry) => entry.direction === LedgerDirection.Debit);
}

/** Transações da wallet, incluindo a `OPENING` da semeadura. */
export async function transacoesDe(
  orm: MikroORM,
  walletId: string,
): Promise<WagerTransactionRow[]> {
  return orm.em.fork().find(wagerTransactionRowSchema, { walletId }, { disableIdentityMap: true });
}

/** Tipos de evento enfileirados na outbox para um agregado (RI-04, EL-06). */
export async function eventosDe(orm: MikroORM, aggregateId: string): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .find(outboxMessageRowSchema, { aggregateId }, { disableIdentityMap: true });

  return rows.map((row) => row.eventType);
}

/**
 * Reconstrói o saldo somando o ledger inteiro (§6.4).
 *
 * Soma de créditos menos débitos, **independente de ordem**: é essa a igualdade
 * que o enunciado cobra, e ela não depende de qual lançamento veio antes. Fazer
 * a reconstrução depender da ordenação introduziria fragilidade sem provar nada
 * a mais — dois lançamentos gravados no mesmo milissegundo são um empate
 * legítimo, não um defeito.
 *
 * Toda a aritmética passa por `Money` (D-003): reconstruir saldo com `number`
 * seria EL-01 dentro do próprio teste que existe para provar a ausência dele.
 */
export async function saldoReconstruido(orm: MikroORM, walletId: string): Promise<Money> {
  const lancamentos = await lancamentosDe(orm, walletId);

  return lancamentos.reduce<Money>((acumulado, entry) => {
    const valor = Money.from({ amount: entry.amount, currency: entry.currency });

    return entry.direction === LedgerDirection.Credit
      ? acumulado.add(valor)
      : acumulado.subtract(valor);
  }, Money.zero(MOEDA));
}

/**
 * **A invariante final de todos os testes** (`docs/requirements.md` §6.4).
 *
 * Nenhum teste de concorrência é considerado verde sem ela. Junto vai a
 * verificação de que nenhum lançamento deixou o saldo negativo: o `CHECK
 * (balance >= 0)` do schema protege a coluna da wallet, mas quem conta a
 * história é o ledger, e um `balance_after` negativo seria EL-02 mesmo com a
 * wallet aparentemente sã.
 */
export async function expectLedgerReconciles(orm: MikroORM, walletId: string): Promise<void> {
  const saldo = await saldoDe(orm, walletId);
  const reconstruido = await saldoReconstruido(orm, walletId);

  expect(reconstruido.toJSON()).toEqual(saldo.toJSON());

  const lancamentos = await lancamentosDe(orm, walletId);

  for (const entry of lancamentos) {
    expect(Money.from({ amount: entry.balanceAfter, currency: entry.currency }).isNegative()).toBe(
      false,
    );
  }
}

/**
 * Barreira de N participantes, com prazo que **rejeita** em vez de travar.
 *
 * Usada por RT-16 para provar a ausência de lock global (RI-06, RNF-01): se as N
 * wallets disputassem um lock compartilhado, a enésima chegada nunca aconteceria.
 * Sem o prazo, o teste ficaria pendurado para sempre e a suíte morreria por
 * timeout genérico, sem dizer o que falhou — o prazo transforma "trava" em
 * "falha com mensagem".
 */
export class Barreira {
  private chegaram = 0;
  private liberar: (() => void) | undefined;
  private readonly completa: Promise<void>;

  constructor(
    private readonly participantes: number,
    private readonly prazoMs: number,
  ) {
    this.completa = new Promise<void>((resolve) => {
      this.liberar = resolve;
    });
  }

  /**
   * Anuncia a chegada e espera as demais.
   *
   * @throws Error se as N chegadas não acontecerem dentro do prazo.
   */
  async chegar(): Promise<void> {
    this.chegaram += 1;

    if (this.chegaram === this.participantes) {
      this.liberar?.();
    }

    let temporizador: ReturnType<typeof setTimeout> | undefined;

    const prazo = new Promise<never>((_, reject) => {
      temporizador = setTimeout(() => {
        reject(
          new Error(
            `barreira não completou em ${String(this.prazoMs)}ms: ` +
              `${String(this.chegaram)} de ${String(this.participantes)} chegaram. ` +
              "Sinal de contenção mútua entre wallets distintas (RI-06).",
          ),
        );
      }, this.prazoMs);
    });

    try {
      await Promise.race([this.completa, prazo]);
    } finally {
      clearTimeout(temporizador);
    }
  }
}
