import type { FailureCode } from "../domain/failure-code.ts";
import type { MoneyProps } from "../domain/money.ts";
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction.ts";
import { ResourceNotFoundError } from "./errors/resource-not-found-error.ts";
import type { UnitOfWork } from "./ports/unit-of-work.ts";

/**
 * Representação de uma transação numa consulta (RF-11, RF-12, D-059).
 *
 * Três blocos, e a divisão é a de D-059: identidade e payload (imutáveis do
 * nascimento ao terminal), desfecho (o que as transições de D-013 escreveram) e
 * auditoria — `idempotencyKey` e `correlationId`, que são o que fecha um
 * atendimento sem acesso ao banco.
 *
 * **`payloadHash` não está aqui de propósito.** É mecanismo interno de D-005, e
 * expô-lo convidaria o provedor a recalculá-lo e a depender de uma lista de
 * campos que a própria D-005 declara ser contrato nosso, alterável.
 *
 * Campos ausentes são **omitidos** do JSON, não `null`: mesma convenção do
 * filtro de exceção de E-08.
 */
export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  /** Id **no provedor** da transação revertida, quando o kind exige (RN-06). */
  referenceExternalTransactionId?: string | undefined;
  /** Id **interno** da referência, presente só depois de resolvida (RN-07). */
  referenceTransactionId?: string | undefined;
  /** Saldo observado no desfecho (RN-12, D-030) — ausente enquanto pendente. */
  observedBalance?: MoneyProps | undefined;
  failureCode?: FailureCode | undefined;
  /** Correlação da submissão que a criou (D-055). Ausente em linha anterior à `m0003`. */
  correlationId?: string | undefined;
  /** ISO 8601 explícito (D-059) — a forma não depende do serializador montado. */
  createdAt: string;
  processedAt?: string | undefined;
}

/**
 * Consulta uma transação pelas suas **duas** identidades (RF-11, RF-12).
 *
 * Um use case com dois métodos, e não dois use cases: é o mesmo recurso visto
 * por chaves diferentes — o id interno, que só quem já recebeu uma resposta
 * conhece, e o par `(providerId, externalTransactionId)`, que é o único
 * identificador que o provedor tem antes disso. Separá-los duplicaria a
 * montagem da view sem separar nada de verdade.
 *
 * Os dois finders **já existiam** desde E-06 e E-12; esta etapa só abre o
 * caminho de leitura para eles.
 */
export class GetWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Consulta por id interno (RF-11).
   *
   * @throws ResourceNotFoundError se não existe (D-056 → 404).
   */
  async byId(transactionId: string): Promise<WagerTransactionView> {
    return this.unitOfWork.run(async (repos) => {
      const transaction = await repos.transactions.findById(transactionId);

      if (transaction === undefined) {
        throw new ResourceNotFoundError("transação", transactionId);
      }

      return toWagerTransactionView(transaction);
    });
  }

  /**
   * Consulta pela identidade no provedor (RF-12).
   *
   * `providerId` errado devolve `404`, e não `403`: o par **é** a identidade, e
   * não há autorização a violar enquanto D-012 mantiver a autenticação fora.
   *
   * @throws ResourceNotFoundError se o par não existe (D-056 → 404).
   */
  async byProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.unitOfWork.run(async (repos) => {
      const transaction = await repos.transactions.findByProviderExternalId(
        providerId,
        externalTransactionId,
      );

      if (transaction === undefined) {
        throw new ResourceNotFoundError(
          "transação",
          `${providerId}:${externalTransactionId}`,
        );
      }

      return toWagerTransactionView(transaction);
    });
  }
}

/**
 * Monta a view a partir da entidade (D-059).
 *
 * Função de módulo, e não método: os dois caminhos de consulta produzem
 * exatamente a mesma representação, e é essa igualdade que impede o provedor de
 * ver campos diferentes conforme a chave que usou para perguntar.
 */
function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    observedBalance: transaction.observedBalance?.toJSON(),
    failureCode: transaction.failureCode,
    correlationId: transaction.correlationId,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString(),
  };
}
