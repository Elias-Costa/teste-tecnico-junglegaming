import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { GetWallet, type WalletView } from "../../application/get-wallet.ts";
import {
  ListWalletLedger,
  type LedgerPageView,
} from "../../application/list-wallet-ledger.ts";
import { OpenWallet, type OpenWalletResult } from "../../application/open-wallet.ts";
import type { IdGenerator } from "../../application/ports/id-generator.ts";
import {
  ReconcileWallet,
  type ReconciliationReport,
} from "../../application/reconcile-wallet.ts";
import { ID_GENERATOR } from "../../infrastructure/di-tokens.ts";
import { CORRELATION_HEADER, resolveCorrelationId } from "./correlation.ts";
import { parseLedgerQuery } from "./dto/parse-ledger-query.ts";
import { parseOpenWalletRequest } from "./dto/parse-open-wallet-request.ts";
import { uuidParam } from "./dto/parse.ts";
import type { HttpResponse } from "./http-response.ts";

/**
 * Endpoints da wallet: abertura (RF-08), consultas (RF-09, RF-10) e
 * reconciliação (RF-16).
 *
 * A borda faz três coisas e nenhuma a mais: resolve a correlação (D-039),
 * traduz rota e corpo em comando (D-038) e devolve o resultado. Validação de
 * valor, transação SQL e eventos são dos use cases — e é isso que faz a mesma
 * regra valer para qualquer entrada futura sem precisar ser repetida aqui.
 *
 * Nenhum `try/catch`: exceção sobe para o filtro único de D-006. Um `catch`
 * local seria o começo da inconsistência que a §9 do enunciado cobra
 * explicitamente — e vale igualmente para os endpoints de leitura, cujo `404`
 * (D-056) vem do mesmo mapa.
 */
@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
    private readonly listLedger: ListWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
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
    const correlationId = this.echoCorrelation(correlationHeader, response);

    return this.openWallet.execute(parseOpenWalletRequest(body, correlationId));
  }

  /**
   * `GET /wallets/:walletId` — estado corrente (RF-09).
   *
   * A resposta tem a **mesma forma** da abertura (D-059): uma forma por recurso,
   * nos dois verbos.
   */
  @Get(":walletId")
  async get(
    @Param("walletId") walletId: string,
    @Headers(CORRELATION_HEADER) correlationHeader: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WalletView> {
    this.echoCorrelation(correlationHeader, response);

    return this.getWallet.execute(uuidParam(walletId, "walletId"));
  }

  /**
   * `GET /wallets/:walletId/ledger` — página do ledger por cursor (RF-10).
   *
   * O cursor é opaco e estável (D-014): o cliente repassa o `nextCursor` da
   * página anterior e nunca o constrói. `nextCursor: null` é a última página.
   */
  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query() query: Record<string, unknown>,
    @Headers(CORRELATION_HEADER) correlationHeader: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<LedgerPageView> {
    this.echoCorrelation(correlationHeader, response);

    const { cursor, limit } = parseLedgerQuery(query);

    return this.listLedger.execute({
      walletId: uuidParam(walletId, "walletId"),
      cursor,
      limit,
    });
  }

  /**
   * `POST /wallets/:walletId/reconciliation` — confere saldo contra ledger (RF-16).
   *
   * `200`, e não `201`: a reconciliação **não cria nada** — e não corrige nada,
   * que é o ponto do requisito. Divergência responde `200` com
   * `consistent: false`; devolver erro para uma verificação que funcionou
   * confundiria "o sistema está inconsistente" com "a verificação falhou".
   */
  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param("walletId") walletId: string,
    @Headers(CORRELATION_HEADER) correlationHeader: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ReconciliationReport> {
    this.echoCorrelation(correlationHeader, response);

    return this.reconcileWallet.execute(uuidParam(walletId, "walletId"));
  }

  /**
   * Resolve e ecoa a correlação (D-039), devolvendo o id resolvido.
   *
   * Ecoado **antes** do trabalho: o provedor precisa do id de correlação também
   * quando a resposta é erro, que é justamente quando ele vai investigar. Vale
   * para leitura tanto quanto para escrita — um `404` sem correlação é um
   * atendimento que começa sem rastro.
   */
  private echoCorrelation(header: unknown, response: HttpResponse): string {
    const correlationId = resolveCorrelationId(header, this.ids);

    response.setHeader(CORRELATION_HEADER, correlationId);

    return correlationId;
  }
}
