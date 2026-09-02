import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post, Res } from "@nestjs/common";
import { OpenWallet, type OpenWalletResult } from "../../application/open-wallet.ts";
import type { IdGenerator } from "../../application/ports/id-generator.ts";
import { ID_GENERATOR } from "../../infrastructure/di-tokens.ts";
import { CORRELATION_HEADER, resolveCorrelationId } from "./correlation.ts";
import { parseOpenWalletRequest } from "./dto/parse-open-wallet-request.ts";
import type { HttpResponse } from "./http-response.ts";

/**
 * `POST /wallets` — abertura de wallet (RF-08).
 *
 * A borda faz três coisas e nenhuma a mais: resolve a correlação (D-039),
 * traduz o corpo em comando (D-038) e devolve o resultado. Validação de valor,
 * transação SQL e eventos são do use case — e é isso que faz a mesma regra valer
 * para qualquer entrada futura sem precisar ser repetida aqui.
 *
 * Nenhum `try/catch`: exceção sobe para o filtro único de D-006. Um `catch` local
 * seria o começo da inconsistência que a §9 do enunciado cobra explicitamente.
 */
@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /**
   * Abre a wallet e responde `201` com o estado inicial.
   *
   * `201` é o único status de sucesso possível aqui: abertura ou cria o recurso,
   * ou falha. O `409` de wallet duplicada (D-035) e o `400` de saldo negativo
   * chegam como exceção e são traduzidos pelo filtro.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async open(
    @Body() body: unknown,
    @Headers(CORRELATION_HEADER) correlationHeader: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<OpenWalletResult> {
    const correlationId = resolveCorrelationId(correlationHeader, this.ids);

    // Ecoado antes do trabalho: o provedor precisa do id de correlação também
    // quando a resposta é erro, que é justamente quando ele vai investigar.
    response.setHeader(CORRELATION_HEADER, correlationId);

    return this.openWallet.execute(parseOpenWalletRequest(body, correlationId));
  }
}
