import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { OpenWallet } from "../../application/open-wallet.ts";
import type { Clock } from "../../application/ports/clock.ts";
import type { IdGenerator } from "../../application/ports/id-generator.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction.ts";
import { DeclaredProviderIdentity } from "../../infrastructure/declared-provider-identity.ts";
import {
  CLOCK,
  ID_GENERATOR,
  PROVIDER_IDENTITY,
  UNIT_OF_WORK,
} from "../../infrastructure/di-tokens.ts";
import { MikroUnitOfWork } from "../../infrastructure/persistence/mikro-unit-of-work.ts";
import { buildOrmConfig } from "../../infrastructure/persistence/orm-config.ts";
import { SystemClock } from "../../infrastructure/system-clock.ts";
import { UuidV7IdGenerator } from "../../infrastructure/uuid-v7-id-generator.ts";
import { AuthGuard } from "./auth.guard.ts";
import { HttpExceptionFilter } from "./http-exception.filter.ts";
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
 * **Não há `main.ts` nesta etapa.** Subir o processo, expor health (RF-17) e
 * oferecer o comando de migration são escopo de E-14/E-15; aqui o módulo é
 * exercitado pelos testes, que sobem a aplicação numa porta efêmera.
 */
@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...buildOrmConfig(),
      registerRequestContext: false,
    }),
  ],
  controllers: [WalletsController, WageringTransactionsController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
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
})
export class AppModule {}
