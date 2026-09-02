import { BusinessFailureCode } from "../../domain/failure-code.ts";
import type { WagerTransactionKind } from "../../domain/wager-transaction.ts";

/**
 * `OPENING` submetido de fora — a regra de RN-13.
 *
 * `OPENING` é **interno**: nasce do use case de abertura de wallet (RF-08) e de
 * nenhum outro lugar. A recusa não vive no domínio porque a mesma factory
 * `WagerTransaction.create` cria a `OPENING` legítima — validar o kind dentro
 * dela impediria o produtor interno junto com o externo.
 *
 * Vive na **aplicação**, e não na borda HTTP, porque RN-13 diz "nem pela API nem
 * pela fila": é regra de negócio das duas entradas, não regra de uma delas. Os
 * dois parsers de borda a lançam no caminho rápido, e o use case a repete como
 * guarda — quem chamar `ProcessWagerTransaction` com `OPENING` por dentro do
 * sistema encontra a mesma recusa.
 *
 * Carrega `KIND_NOT_SUBMITTABLE` (D-007) e responde `422` por D-006: é rejeição
 * por regra de negócio, com código que o provedor lê para saber que precisa
 * **corrigir o payload**, não reenviar. Não vira linha na tabela, como
 * `WALLET_NOT_FOUND` (D-031): nenhuma transação chega a ser criada.
 */
export class KindNotSubmittableError extends Error {
  readonly failureCode = BusinessFailureCode.KindNotSubmittable;

  constructor(public readonly kind: WagerTransactionKind) {
    super(`kind ${kind} é interno e não pode ser submetido pela API (RN-13).`);
    this.name = "KindNotSubmittableError";
  }
}
