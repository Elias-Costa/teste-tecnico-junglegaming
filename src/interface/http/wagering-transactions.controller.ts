import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import {
  GetWagerTransaction,
  type WagerTransactionView,
} from "../../application/get-wager-transaction.ts";
import type { IdGenerator } from "../../application/ports/id-generator.ts";
import type { ProviderIdentityPort } from "../../application/ports/provider-identity.ts";
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionResult,
} from "../../application/process-wager-transaction.ts";
import { ID_GENERATOR, PROVIDER_IDENTITY } from "../../infrastructure/di-tokens.ts";
import { CORRELATION_HEADER, resolveCorrelationId } from "./correlation.ts";
import { parseSubmitTransactionRequest } from "./dto/parse-submit-transaction-request.ts";
import { uuidParam } from "./dto/parse.ts";
import { httpStatusForResult } from "./http-status-map.ts";
import type { HttpResponse } from "./http-response.ts";

/** Header onde a credencial chegaria, se houvesse autenticação (D-012). */
const AUTHORIZATION_HEADER = "authorization";

/**
 * `POST /wagering/transactions` — submissão de operação (RF-13, RF-14).
 *
 * O status da resposta sai de `httpStatusForResult` (D-036): `200` para aplicada,
 * `422` para rejeitada com `failureCode` no corpo, `202` para aceita e pendente.
 * O corpo é o mesmo nos três casos — `{ transactionId, status, balance,
 * idempotentReplay }` mais o código quando há —, porque nos três casos a
 * transação **existe** e o provedor precisa do id para consultá-la depois.
 *
 * `200` e não `201`: um replay não cria nada (RN-12), e o mesmo endpoint não pode
 * responder ora "criei", ora "já existia" para requisições que o provedor
 * considera idênticas.
 */
@Controller("wagering/transactions")
export class WageringTransactionsController {
  constructor(
    private readonly process: ProcessWagerTransaction,
    private readonly getTransaction: GetWagerTransaction,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /**
   * Processa a submissão e responde com o desfecho.
   *
   * `Idempotency-Key` é lido do header e é a fonte da verdade da idempotência
   * (RF-14); ausência é `400`, tratada no parser.
   */
  @Post()
  async submit(
    @Body() body: unknown,
    @Headers() headers: Record<string, unknown>,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessWagerTransactionResult> {
    const correlationId = resolveCorrelationId(headers[CORRELATION_HEADER], this.ids);

    response.setHeader(CORRELATION_HEADER, correlationId);

    const command = parseSubmitTransactionRequest(body, headers, correlationId);

    // **O ponto de extensão de D-012 está no caminho de toda submissão.** Hoje a
    // implementação devolve a identidade declarada sem verificar nada; quando
    // houver autenticação, é aqui que a credencial vira `providerId` — e nada
    // mais no caminho muda. Repare que o `providerId` **resolvido** é o que segue
    // para o use case, não o do corpo: com auth de verdade, os dois podem
    // divergir, e é o resolvido que vale.
    const providerId = await this.identity.resolve(
      credentialOf(headers),
      command.providerId,
    );

    const result = await this.process.execute({ ...command, providerId });

    response.status(httpStatusForResult(result.status));

    return result;
  }

  /**
   * `GET /wagering/transactions/:transactionId` — consulta por id interno (RF-11).
   *
   * Sempre `200` ou `404` (D-056): a consulta não decide nada de negócio, então
   * uma transação em `REJECTED` é devolvida com `200` e o seu `failureCode` no
   * corpo. Responder `422` aqui repetiria o desfecho da submissão como se a
   * consulta o estivesse produzindo de novo.
   */
  @Get(":transactionId")
  async get(
    @Param("transactionId") transactionId: string,
    @Headers(CORRELATION_HEADER) correlationHeader: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WagerTransactionView> {
    response.setHeader(CORRELATION_HEADER, resolveCorrelationId(correlationHeader, this.ids));

    return this.getTransaction.byId(uuidParam(transactionId, "transactionId"));
  }
}

/** Lê a credencial da requisição, se houver. Hoje é sempre ignorada (D-012). */
function credentialOf(headers: Record<string, unknown>): string | undefined {
  const value = headers[AUTHORIZATION_HEADER];

  return typeof value === "string" ? value : undefined;
}
