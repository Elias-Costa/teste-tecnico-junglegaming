/**
 * Recurso pedido por uma **consulta** não existe (D-056).
 *
 * Separado de `WalletNotFoundError` de propósito, e a diferença não é de
 * recurso — é de verbo. Aquele erro é a rejeição de negócio de D-031, produzida
 * quando uma operação é **submetida** contra wallet inexistente: carrega
 * `WALLET_NOT_FOUND` da taxonomia de D-007 e responde `422`, porque houve
 * decisão de negócio. Este não decide nada: a leitura não encontrou linha, e a
 * resposta é `404` sem `failureCode`.
 *
 * Colapsar os dois num tipo só obrigaria o mapa de status a adivinhar o verbo —
 * e devolveria a um `GET` um código da taxonomia de negócio, dizendo ao provedor
 * que algo foi recusado quando nada foi processado.
 *
 * `404` **não** é uma sexta forma das cinco situações de RF-15: ele responde uma
 * pergunta que a §9 não faz, porque a §9 trata da submissão.
 */
export class ResourceNotFoundError extends Error {
  /**
   * @param resource nome do recurso, como aparece na rota (`wallet`, `transação`).
   * @param identifier identificador procurado, ecoado na mensagem para que o
   * provedor confirme que consultou o que pretendia.
   */
  constructor(
    public readonly resource: string,
    public readonly identifier: string,
  ) {
    super(`${resource} ${identifier} não encontrada.`);
    this.name = "ResourceNotFoundError";
  }
}
