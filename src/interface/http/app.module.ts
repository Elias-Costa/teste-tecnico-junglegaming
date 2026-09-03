import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { GetWagerTransaction } from "../../application/get-wager-transaction.ts";
import { GetWallet } from "../../application/get-wallet.ts";
import { ListWalletLedger } from "../../application/list-wallet-ledger.ts";
import { OpenWallet } from "../../application/open-wallet.ts";
import type { Clock } from "../../application/ports/clock.ts";
import type { IdGenerator } from "../../application/ports/id-generator.ts";
import type { Logger } from "../../application/ports/logger.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction.ts";
import { ReconcileWallet } from "../../application/reconcile-wallet.ts";
import { DeclaredProviderIdentity } from "../../infrastructure/declared-provider-identity.ts";
import {
  CLOCK,
  ID_GENERATOR,
  LOGGER,
  PROVIDER_IDENTITY,
  UNIT_OF_WORK,
} from "../../infrastructure/di-tokens.ts";
import { JsonLogger } from "../../infrastructure/observability/json-logger.ts";
import { MikroUnitOfWork } from "../../infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../infrastructure/persistence/orm-config.ts";
import { SystemClock } from "../../infrastructure/system-clock.ts";
import { UuidV7IdGenerator } from "../../infrastructure/uuid-v7-id-generator.ts";
import { AuthGuard } from "./auth.guard.ts";
import { HealthController } from "./health.controller.ts";
import { HttpExceptionFilter } from "./http-exception.filter.ts";
import { MetricsController } from "./metrics.controller.ts";
import { OutboxLagMetric } from "./outbox-lag-metric.ts";
import { ProviderTransactionsController } from "./provider-transactions.controller.ts";
import { ReadinessProbes } from "./readiness-probes.ts";
import { WageringTransactionsController } from "./wagering-transactions.controller.ts";
import { WalletsController } from "./wallets.controller.ts";

/**
 * Grafo de dependências da aplicação HTTP.
 *
 * Os use cases são montados por factory, e não por `useClass`, porque eles não
 * são classes do NestJS: `src/application` não conhece decorator nenhum, e essa
 * fronteira é parte do desenho (`AGENTS.md` §4). O container resolve as portas
 * pelos tokens de `di-tokens.ts` e entrega tudo pronto ao construtor.
 *
 * **`registerRequestContext: false`** é a única opção não óbvia daqui. O
 * middleware que o `@mikro-orm/nestjs` registra por padrão existe para dar um
 * identity map por requisição — exatamente o mecanismo que D-028 removeu ao
 * escrever por comando explícito. Ligá-lo devolveria ao caminho de escrita um
 * rastreamento que ninguém usa e que reexporia o ledger ao `P0001` da trigger de
 * D-023.
 *
 * **Este módulo é HTTP e só HTTP — os workers não estão aqui, de propósito**
 * (D-063). Quem os monta é o `WorkersModule`, que importa este e é o raiz do
 * processo de produção (`src/main.ts`). A separação existe por causa de RT-17:
 * `tests/support/app-instance.ts` sobe o `AppModule` **três vezes** em processos
 * distintos para provar a concorrência, e se os laços estivessem aqui as três
 * instâncias passariam a consumir SQS no meio da prova.
 */
@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...buildOrmConfig(),
      registerRequestContext: false,
    }),
  ],
  controllers: [
    WalletsController,
    WageringTransactionsController,
    ProviderTransactionsController,
    // As duas rotas de observabilidade de E-15. Ficam abertas: RF-17 exige health
    // sem autenticação, e D-010 põe `/metrics` no mesmo regime — coerente com
    // D-012, que não implementa autenticação em lugar nenhum.
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: LOGGER, useClass: JsonLogger },
    ReadinessProbes,
    OutboxLagMetric,
    { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
    { provide: PROVIDER_IDENTITY, useClass: DeclaredProviderIdentity },

    {
      // O `EntityManager` injetado é o de nível de aplicação; cada `run` deriva o
      // seu por `transactional()`, então duas requisições concorrentes não
      // compartilham contexto de transação (ver `MikroUnitOfWork`).
      provide: UNIT_OF_WORK,
      inject: [EntityManager],
      useFactory: (em: EntityManager): UnitOfWork => new MikroUnitOfWork(em),
    },

    {
      provide: OpenWallet,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (unitOfWork: UnitOfWork, clock: Clock, ids: IdGenerator): OpenWallet =>
        new OpenWallet(unitOfWork, clock, ids),
    },

    // As quatro leituras de E-14 recebem **só** a `UnitOfWork`: consulta não
    // gera id nem carimba instante, então injetar `Clock` ou `IdGenerator` nelas
    // seria dependência que ninguém usa. `ReconcileWallet` é a exceção: E-15
    // liga o logger no gancho `onDivergence`, que estava injetável e sem ninguém
    // do outro lado desde E-14.
    {
      provide: GetWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork): GetWallet => new GetWallet(unitOfWork),
    },
    {
      provide: GetWagerTransaction,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork): GetWagerTransaction =>
        new GetWagerTransaction(unitOfWork),
    },
    {
      provide: ListWalletLedger,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork): ListWalletLedger =>
        new ListWalletLedger(unitOfWork),
    },
    {
      provide: ReconcileWallet,
      inject: [UNIT_OF_WORK, LOGGER],
      useFactory: (unitOfWork: UnitOfWork, logger: Logger): ReconcileWallet =>
        // RF-16 manda **logar** a divergência, além de contabilizá-la e
        // sinalizá-la na resposta. O `walletId` vai; `difference` não — é valor
        // monetário, e RNF-06 proíbe payload financeiro no log. Quem quiser o
        // número tem a resposta do endpoint e o ledger.
        new ReconcileWallet(unitOfWork, (report) => {
          logger.warn("wallet.reconciliation.divergent", { walletId: report.walletId });
        }),
    },

    {
      provide: ProcessWagerTransaction,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (
        unitOfWork: UnitOfWork,
        clock: Clock,
        ids: IdGenerator,
      ): ProcessWagerTransaction => new ProcessWagerTransaction(unitOfWork, clock, ids),
    },

    // Registrados no container, e não em `app.useGlobalFilters(...)`: assim
    // valem para qualquer forma de subir este módulo — inclusive a dos testes —
    // e não dependem de alguém lembrar de chamar o método certo no bootstrap.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],

  // Exportado para o `WorkersModule` de D-063, que monta os três laços **sobre**
  // este grafo em vez de construir um segundo. É o que garante que a fila e o
  // HTTP compartilhem o mesmo use case (RF-18) e o mesmo `UnitOfWork`: dois
  // grafos paralelos seriam a forma silenciosa de as duas entradas divergirem.
  exports: [ProcessWagerTransaction, UNIT_OF_WORK, CLOCK, ID_GENERATOR, LOGGER],
})
export class AppModule {}
