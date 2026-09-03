import type { InboxRepository } from "../../domain/repositories/inbox-repository.ts";
import type { OutboxRepository } from "../../domain/repositories/outbox-repository.ts";
import type { WagerTransactionRepository } from "../../domain/repositories/wager-transaction-repository.ts";
import type { WalletLedgerRepository } from "../../domain/repositories/wallet-ledger-repository.ts";
import type { WalletRepository } from "../../domain/repositories/wallet-repository.ts";

/**
 * Os cinco repositórios **ligados à mesma transação SQL** (D-027, D-028).
 *
 * Chegam juntos porque é junto que eles precisam ser usados: RF-23 exige que
 * transação, saldo, ledger, inbox e outbox sejam confirmados ou descartados de
 * uma vez. Recebê-los por injeção no construtor do use case permitiria usá-los
 * fora de transação — que é a forma silenciosa de escrever em autocommit.
 */
export interface TransactionalRepositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: WalletLedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

/**
 * O que uma leitura sob snapshot pode tocar (D-065).
 *
 * Subconjunto deliberado: quem reconcilia precisa da wallet e do ledger, e de
 * mais nada. Inbox e outbox ficam **fora da assinatura** porque escrever nelas
 * ali é impossível — a transação é `read only` e o PostgreSQL recusaria com
 * `25006`. Recortar o tipo faz a restrição aparecer no compilador antes de
 * aparecer no banco.
 */
export type ReadOnlyRepositories = Pick<TransactionalRepositories, "wallets" | "ledger">;

/**
 * Abre uma transação SQL e entrega os repositórios que valem dentro dela (RF-23).
 *
 * Porta de **aplicação**, não de domínio: ao contrário dos repositórios de
 * D-027, ela não fala de agregado nenhum — fala de orquestração, que é assunto
 * do use case. O domínio continua sem saber que existe transação de banco.
 *
 * A implementação (E-06/E-07, MikroORM) constrói os repositórios com o
 * `EntityManager` forkado que a transação entrega, como manda D-028.
 */
export interface UnitOfWork {
  /**
   * Executa `work` dentro de uma única transação SQL.
   *
   * Commit ao fim do callback; qualquer exceção que escape dele desfaz **tudo**
   * — inclusive as linhas da outbox, que é o que impede um evento de existir
   * para uma movimentação que não aconteceu (RI-04, EL-06).
   */
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;

  /**
   * Executa `work` sobre um **instante congelado** do banco, sem escrever (D-065).
   *
   * Existe para a reconciliação de RF-16, que compara o saldo materializado com a
   * soma do ledger: em READ COMMITTED as duas leituras veem snapshots diferentes,
   * e uma aposta confirmada entre elas acusaria divergência que nunca existiu —
   * num sinal que o requisito manda logar e contabilizar.
   *
   * A implementação abre a transação em `REPEATABLE READ` **e** `read only`. O
   * segundo é o ponto: RF-16 exige que divergência não seja corrigida em
   * silêncio, e sob `read only` isso deixa de ser promessa do código e vira
   * recusa do banco. É também o que separa este método de `run` — não é "uma
   * transação com outro isolamento", é um caminho de onde não sai escrita.
   *
   * Não substitui `run` em consulta de leitura única: um `SELECT` só não tem dois
   * instantes para conciliar, e pagaria isolamento sem comprar nada.
   */
  runSnapshot<T>(work: (repositories: ReadOnlyRepositories) => Promise<T>): Promise<T>;
}
