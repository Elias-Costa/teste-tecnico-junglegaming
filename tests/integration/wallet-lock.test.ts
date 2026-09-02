/**
 * D-002 — a aquisição do lock de wallet, no SQL efetivamente emitido.
 *
 * O spike E-00 já havia confirmado que `LockMode.PESSIMISTIC_WRITE` produz
 * `SELECT ... FOR UPDATE`. O que este arquivo acrescenta é o vínculo com **este
 * caminho de código**: prova que `findByIdForUpdate` — e só ele — trava a linha,
 * que `findById` não trava, e que a chamada fora de transação é recusada.
 *
 * Por que assertar sobre o SQL, e não sobre o comportamento sob concorrência: a
 * prova comportamental é de E-09 (RT-14..RT-17), e ela é cara e demorada. Esta
 * aqui é barata e responde a outra pergunta — "o lock continua sendo emitido?" —
 * que é a que quebra em silêncio numa refatoração. Um `findByIdForUpdate` que
 * deixasse de travar passaria em todo teste de negócio e só apareceria como
 * saldo negativo em produção, que é EL-02.
 *
 * O ORM daqui é próprio, com `debug` e `logger` capturando as queries. Isso não
 * pode ficar na configuração compartilhada: logar toda query no caminho quente
 * é custo que E-09 não deve pagar.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM, ValidationError } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import { buildOrmConfig } from "../../src/infrastructure/persistence/orm-config.ts";
import { MikroWalletRepository } from "../../src/infrastructure/persistence/repositories/mikro-wallet-repository.ts";

let orm: MikroORM;

/** Toda query emitida desde a última limpeza. */
const queries: string[] = [];

/** Só as consultas à tabela de wallets — o resto é ruído de migration e seed. */
function selectsDeWallet(): string[] {
  return queries.filter((query) => query.includes('from "wallets"'));
}

function limparCaptura(): void {
  queries.length = 0;
}

/** Abre uma wallet com saldo zero: aqui o que importa é a linha existir. */
async function seedWallet(): Promise<string> {
  const { wallet } = Wallet.open({
    id: Bun.randomUUIDv7(),
    playerId: `player-${Bun.randomUUIDv7()}`,
    initialBalance: Money.zero("BRL"),
    openingTransactionId: Bun.randomUUIDv7(),
    openingEntryId: Bun.randomUUIDv7(),
    at: new Date("2026-09-01T12:00:00.000Z"),
  });

  await orm.em.transactional((em) => new MikroWalletRepository(em).insert(wallet));

  return wallet.id;
}

beforeAll(async () => {
  orm = await MikroORM.init({
    ...buildOrmConfig(),
    debug: ["query"],
    logger: (message) => queries.push(message),
  });
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
});

afterAll(async () => {
  await orm.close(true);
});

describe("lock pessimista por wallet (D-002, RI-06, EL-02)", () => {
  it("findByIdForUpdate emite SELECT ... FOR UPDATE", async () => {
    const walletId = await seedWallet();
    limparCaptura();

    await orm.em.transactional(async (em) => {
      await new MikroWalletRepository(em).findByIdForUpdate(walletId);
    });

    const selects = selectsDeWallet();

    expect(selects.length).toBeGreaterThan(0);
    expect(selects.some((query) => query.toLowerCase().includes("for update"))).toBe(true);
  });

  it("findById não trava a linha — leitura de RF-09 não bloqueia ninguém", async () => {
    const walletId = await seedWallet();
    limparCaptura();

    await new MikroWalletRepository(orm.em.fork()).findById(walletId);

    const selects = selectsDeWallet();

    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((query) => !query.toLowerCase().includes("for update"))).toBe(true);
  });

  it("recusa a aquisição do lock fora de uma transação", async () => {
    const walletId = await seedWallet();
    const repository = new MikroWalletRepository(orm.em.fork());

    // Um `FOR UPDATE` em autocommit soltaria o lock no fim da própria query:
    // daria a aparência de proteção sem proteger nada, que é o pior dos mundos
    // para EL-02. Quem recusa é o próprio MikroORM (`checkLockRequirements`) —
    // a guarda é da ferramenta, e não precisa ser reescrita aqui.
    let caught: unknown;

    try {
      await repository.findByIdForUpdate(walletId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
  });
});
