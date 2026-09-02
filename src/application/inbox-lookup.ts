import type { UnitOfWork } from "./ports/unit-of-work.ts";

/**
 * A pergunta que abre o consumo de uma mensagem (RF-19, EL-04, EL-05).
 *
 * Existe por uma restrição de D-028: os repositórios só existem **dentro** de
 * `UnitOfWork.run`, e a borda de mensageria não deveria abrir transação por conta
 * própria só para fazer uma leitura. Esta classe é o mínimo que resolve isso sem
 * dar à borda acesso ao `EntityManager`.
 *
 * A resposta vem do **banco**, não de estrutura em processo — é literalmente o
 * que EL-04 proíbe, e o que faz a deduplicação continuar valendo com três
 * instâncias (RI-08).
 *
 * **Não é a única linha de defesa, de propósito.** Entre esta leitura e o commit
 * da transação financeira existe uma janela em que outra instância pode processar
 * a mesma entrega; quem fecha essa janela é a chave primária `pk_inbox_messages`
 * (D-025), que aborta a transação perdedora inteira. Esta consulta é o caminho
 * **normal** da reentrega — a que evita reabrir a transação por nada.
 */
export class InboxLookup {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Verdadeiro quando a mensagem já foi processada até o commit.
   *
   * Uma linha de inbox **existe** apenas se a transação financeira dela commitou:
   * ela é gravada já processada, na mesma transação (RF-23). Então "existe e está
   * processada" e "o efeito no dinheiro aconteceu" são a mesma afirmação, e é ela
   * que autoriza o `ack` de uma reentrega sem refazer trabalho.
   *
   * @param messageId o `messageId` do **corpo** da mensagem (D-044).
   */
  async wasProcessed(consumerName: string, messageId: string): Promise<boolean> {
    return this.unitOfWork.run(async (repos) => {
      const received = await repos.inbox.findByKey(consumerName, messageId);

      return received?.isProcessed() ?? false;
    });
  }
}
