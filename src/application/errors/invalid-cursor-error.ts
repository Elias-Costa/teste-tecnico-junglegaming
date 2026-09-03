/**
 * Cursor de paginação que não decodifica para um id válido (RF-10, D-014).
 *
 * Vive na aplicação, e não na borda HTTP, pelo mesmo motivo que
 * `KindNotSubmittableError` mudou de camada em E-12: o cursor é o contrato de
 * paginação do modelo de leitura, não um detalhe do transporte. Quem consultar o
 * ledger por outro caminho no futuro encontra **um** tipo, não dois parecidos.
 *
 * D-006 mapeia para `400`: é forma inválida — situação (a) de RF-15 —, e não
 * ausência de recurso. Um cursor corrompido não descreve uma página vazia; ele
 * descreve uma requisição que não dá para atender.
 */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}
