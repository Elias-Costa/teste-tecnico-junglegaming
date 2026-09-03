import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import { WalletAlreadyExistsError } from "../../../application/errors/wallet-already-exists-error.ts";
import type { WalletRepository } from "../../../domain/repositories/wallet-repository.ts";
import type { Wallet } from "../../../domain/wallet.ts";
import { startLockWaitTimer } from "../../observability/metrics.ts";
import { toWallet, toWalletRow, toWalletUpdate } from "../mappers/wallet-mapper.ts";
import { walletRowSchema } from "../rows/wallet-row.ts";
import { violatedConstraintOf } from "../transient-error.ts";
import { READ_WITHOUT_IDENTITY_MAP } from "./read-options.ts";

/** Constraint de RI-09 que impõe uma wallet por `playerId` + `currency` (E-05). */
const UNIQUE_PLAYER_CURRENCY = "uq_wallets_player_currency";

/**
 * Repositório de wallet sobre o MikroORM (RF-02, D-026, D-028).
 *
 * Recebe o `EntityManager` no construtor, e não um singleton injetado: por
 * D-028 as escritas são comandos diretos dentro de `em.transactional()`, e o
 * `em` que vale é o **forkado** que a transação entrega. Um repositório
 * construído fora dela escreveria em autocommit — que é a forma silenciosa de
 * quebrar a atomicidade de RF-23.
 */
export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Grava uma wallet recém-aberta, traduzindo a duplicata em erro de aplicação
   * (RF-08, D-035).
   *
   * A garantia de unicidade continua sendo do banco — `uq_wallets_player_currency`
   * é quem recusa, como RI-09 exige. O que este `catch` faz é **traduzir**: só o
   * repositório sabe qual das cinco constraints únicas desta base falhou, porque
   * a mesma `UniqueConstraintViolationException` cobre todas elas, e
   * `src/application` não pode importar o ORM (D-028).
   *
   * Uma violação de **outra** constraint é relançada como veio: ela seria um bug
   * nosso, e mascará-la de "wallet já existe" contaria ao provedor uma história
   * que não aconteceu.
   *
   * @throws WalletAlreadyExistsError quando o jogador já tem wallet nessa moeda.
   */
  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(walletRowSchema, toWalletRow(wallet));
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        violatedConstraintOf(error) === UNIQUE_PLAYER_CURRENCY
      ) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }

      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(walletRowSchema, { id }, READ_WITHOUT_IDENTITY_MAP);

    return row === null ? undefined : toWallet(row);
  }

  /**
   * **Ponto único de aquisição do lock de wallet** (D-002, RI-06, EL-02).
   *
   * `LockMode.PESSIMISTIC_WRITE` emite `SELECT ... FOR UPDATE` — confirmado no
   * SQL efetivamente emitido, primeiro no spike E-00 e depois em
   * `tests/integration/wallet-lock.test.ts`, que amarra a garantia a este
   * método. O banco serializa por wallet; wallets diferentes não se veem, então
   * não há lock global (RI-06).
   *
   * Se aparecer um segundo lugar no código que trave wallet, RI-06 passa a ser
   * violado por dispersão e não por desenho — é este método, e só ele, que
   * qualquer revisão precisa auditar.
   *
   * Fora de uma transação o próprio MikroORM recusa a chamada
   * (`checkLockRequirements`), o que é a guarda certa: um `FOR UPDATE` em
   * autocommit soltaria o lock no fim da própria query e daria a impressão de
   * proteção sem proteger nada.
   */
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    // `wallet_lock_wait_seconds` (D-010) é medido **aqui**, e este é o único
    // ponto do código fora das bordas que conhece métrica (D-062): a espera pelo
    // `FOR UPDATE` não é visível de nenhuma camada acima. Como a estratégia é
    // pessimista (D-002), contenção aparece como fila — o histograma é a leitura
    // de "conflitos de lock" que RNF-07 pede num sistema sem optimistic locking.
    //
    // O `finally` garante a observação também quando a query morre em deadlock
    // (`40P01`): o tempo esperado até a falha é justamente o que interessa ali.
    const stopTimer = startLockWaitTimer();

    try {
      const row = await this.em.findOne(
        walletRowSchema,
        { id },
        { ...READ_WITHOUT_IDENTITY_MAP, lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      return row === null ? undefined : toWallet(row);
    } finally {
      stopTimer();
    }
  }

  async update(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(walletRowSchema, { id: wallet.id }, toWalletUpdate(wallet));
  }
}
