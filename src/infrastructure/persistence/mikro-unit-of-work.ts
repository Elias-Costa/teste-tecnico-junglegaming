import { IsolationLevel } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  ReadOnlyRepositories,
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

  /**
   * Transação de leitura em `REPEATABLE READ` e `read only` (D-065).
   *
   * As duas opções são passadas ao mesmo `em.transactional`, e o driver as
   * traduz em `set transaction isolation level repeatable read` e no modo de
   * acesso `read only` da conexão — conferido no `@mikro-orm/sql` instalado, não
   * escrito de memória (`AGENTS.md` §2.1).
   *
   * Só os dois repositórios de `ReadOnlyRepositories` são construídos. Não é
   * economia: instanciar inbox e outbox aqui ofereceria a quem lê um caminho de
   * escrita que só falharia em tempo de execução, no meio de um relatório.
   */
  async runSnapshot<T>(work: (repositories: ReadOnlyRepositories) => Promise<T>): Promise<T> {
    return this.em.transactional(
      async (tx) =>
        work({
          wallets: new MikroWalletRepository(tx),
          ledger: new MikroWalletLedgerRepository(tx),
        }),
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }
}
