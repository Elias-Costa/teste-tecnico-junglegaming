import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  TransactionalRepositories,
  UnitOfWork,
} from "../../application/ports/unit-of-work.ts";
import { MikroInboxRepository } from "./repositories/mikro-inbox-repository.ts";
import { MikroOutboxRepository } from "./repositories/mikro-outbox-repository.ts";
import { MikroWagerTransactionRepository } from "./repositories/mikro-wager-transaction-repository.ts";
import { MikroWalletLedgerRepository } from "./repositories/mikro-wallet-ledger-repository.ts";
import { MikroWalletRepository } from "./repositories/mikro-wallet-repository.ts";

/**
 * `UnitOfWork` sobre o `EntityManager` do MikroORM (RF-23, D-028).
 *
 * Os cinco repositórios são construídos **dentro** do callback, com o `em`
 * forkado que `transactional()` entrega. É a diferença entre uma transação e
 * cinco autocommits: repositórios criados fora — no construtor, por exemplo —
 * escreveriam cada um por si, e a atomicidade de RF-23 sumiria sem nenhum erro
 * aparecer. É também o motivo de esta classe existir em vez de o use case
 * receber os repositórios por injeção.
 *
 * O `em` recebido aqui é o de nível de aplicação; cada `run` deriva o seu, então
 * duas execuções concorrentes não compartilham contexto de transação.
 */
export class MikroUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    return this.em.transactional(async (tx) =>
      work({
        wallets: new MikroWalletRepository(tx),
        transactions: new MikroWagerTransactionRepository(tx),
        ledger: new MikroWalletLedgerRepository(tx),
        inbox: new MikroInboxRepository(tx),
        outbox: new MikroOutboxRepository(tx),
      }),
    );
  }
}
