import { Controller, Get, Headers, Inject, Param, Res } from "@nestjs/common";
import {
  GetWagerTransaction,
  type WagerTransactionView,
} from "../../application/get-wager-transaction.ts";
import type { IdGenerator } from "../../application/ports/id-generator.ts";
import { ID_GENERATOR } from "../../infrastructure/di-tokens.ts";
import { CORRELATION_HEADER, resolveCorrelationId } from "./correlation.ts";
import type { HttpResponse } from "./http-response.ts";

/**
 * `GET /providers/:providerId/wagering/transactions/:externalTransactionId` (RF-12).
 *
 * Controller próprio porque o prefixo de rota é outro — `providers`, não
 * `wagering/transactions`. É a mesma transação vista pela identidade que o
 * provedor conhece: antes de receber a primeira resposta, o par
 * `(providerId, externalTransactionId)` é o **único** identificador que ele tem.
 *
 * Os dois parâmetros são texto livre, e não UUID: o `externalTransactionId` é
 * do provedor e o próprio enunciado o exemplifica como `transaction-123`.
 */
@Controller("providers/:providerId/wagering/transactions")
export class ProviderTransactionsController {
  constructor(
    private readonly getTransaction: GetWagerTransaction,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /**
   * Consulta pela identidade no provedor (RF-12).
   *
   * Par inexistente é `404` (D-056), inclusive quando o `externalTransactionId`
   * existe **sob outro provedor**: o par é a identidade, e responder `403` daria
   * a entender que há autorização em jogo — não há, por D-012.
   *
   * `providerId: "internal"` é rota válida e devolve a `OPENING` da abertura de
   * wallet (D-033). É auditoria legítima da transação interna, não vazamento.
   */
  @Get(":externalTransactionId")
  async get(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Headers(CORRELATION_HEADER) correlationHeader: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WagerTransactionView> {
    response.setHeader(CORRELATION_HEADER, resolveCorrelationId(correlationHeader, this.ids));

    return this.getTransaction.byProviderExternalId(providerId, externalTransactionId);
  }
}
