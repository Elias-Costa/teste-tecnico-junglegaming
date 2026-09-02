import type { Wallet } from "../wallet.ts";

/**
 * Persistência do agregado `Wallet` (RF-02, D-027).
 *
 * A interface vive no domínio porque só fala de agregados: nenhum tipo aqui
 * pertence a outra camada. Quem a implementa é a infraestrutura (E-06), e quem
 * a consome é o use case de E-07 — que assim não conhece o MikroORM.
 */
export interface WalletRepository {
  /** Grava uma wallet recém-aberta (RF-08). */
  insert(wallet: Wallet): Promise<void>;

  /** Leitura simples, sem lock. É o caminho de consulta de RF-09. */
  findById(id: string): Promise<Wallet | undefined>;

  /**
   * Lê a wallet **para escrita**, serializando o acesso concorrente (D-002, EL-02).
   *
   * O nome diz a intenção, não a estratégia: "ler para escrever" é pergunta de
   * domínio, e `SELECT ... FOR UPDATE` é a resposta que a infraestrutura escolheu
   * e pode trocar sem tocar neste contrato. Toda operação que vai alterar saldo
   * entra por aqui — é o ponto único de aquisição do lock que RI-06 exige, e
   * usar `findById` no lugar deste método é como EL-02 volta.
   *
   * Só faz sentido dentro de uma transação; a implementação recusa fora dela.
   */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;

  /** Persiste a mudança de saldo, `version` e `updatedAt` de uma wallet já existente. */
  update(wallet: Wallet): Promise<void>;
}
