/**
 * Tokens de injeção para as portas da camada de aplicação.
 *
 * Existem porque as portas são **interfaces**, e interface não sobrevive à
 * compilação: não há símbolo em runtime para o container do NestJS usar como
 * chave. Os tokens são a chave que falta.
 *
 * Ficam na infraestrutura, e não junto do módulo HTTP, porque a borda HTTP não é
 * o único consumidor: o worker da outbox (E-10) e o consumidor SQS (E-11) montam
 * o mesmo grafo de dependências e precisam dos mesmos tokens. Postos aqui, um
 * worker não precisa importar da camada de interface para se montar.
 *
 * São `Symbol`, e não string: colisão acidental com um token de biblioteca deixa
 * de ser possível, e o nome descritivo continua aparecendo na mensagem de erro
 * quando o Nest não consegue resolver a dependência.
 */

/** Token de `Clock` (`src/application/ports/clock.ts`). */
export const CLOCK = Symbol("Clock");

/** Token de `IdGenerator` (`src/application/ports/id-generator.ts`, D-014). */
export const ID_GENERATOR = Symbol("IdGenerator");

/** Token de `UnitOfWork` (`src/application/ports/unit-of-work.ts`, RF-23, D-028). */
export const UNIT_OF_WORK = Symbol("UnitOfWork");

/** Token de `ProviderIdentityPort` (`src/application/ports/provider-identity.ts`, D-012). */
export const PROVIDER_IDENTITY = Symbol("ProviderIdentityPort");

/** Token de `Logger` (`src/application/ports/logger.ts`, RNF-06, D-061). */
export const LOGGER = Symbol("Logger");
