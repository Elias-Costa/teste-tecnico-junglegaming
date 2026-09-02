/**
 * Classificação de erro de banco: transitório ou não (D-037).
 *
 * Existe porque D-006 exige `503` para falha **transitória** de infraestrutura
 * sem dizer como reconhecer uma. A resposta é uma lista explícita e curta de
 * SQLSTATE, e não uma checagem por classe de exceção do MikroORM: verificado em
 * `node_modules`, o `PostgreSqlExceptionConverter` **não produz**
 * `ConnectionException` nem `LockWaitTimeoutException` — falha de conexão chega
 * como `DriverException` base, com o SQLSTATE (ou o `errno` de rede) copiado do
 * erro original do driver.
 *
 * Fica na infraestrutura, e não junto do filtro HTTP, porque **E-11 usa a mesma
 * classificação** para RF-21: transitório volta para retry, permanente vai para
 * DLQ. Um worker não deve importar da camada de interface para perguntar isso.
 *
 * O que **não** está nesta lista é tão importante quanto o que está: violação de
 * constraint, erro de sintaxe e tabela inexistente são bugs nossos. Reenviar não
 * conserta bug, e responder `503` a eles gastaria as cinco tentativas de D-008
 * do provedor para chegar ao mesmo lugar.
 */

/**
 * SQLSTATE transitórios, na forma completa de cinco caracteres.
 *
 * - `40001` / `40P01` — falha de serialização e deadlock. O caminho normal de
 *   D-002 é `FOR UPDATE`, que espera em vez de abortar, mas o deadlock continua
 *   possível e a resposta certa é "tente de novo".
 * - `55P03` — lock indisponível (`NOWAIT`/`SKIP LOCKED` sem candidato).
 * - `57014` — query cancelada, tipicamente por `statement_timeout`.
 * - `57P01` — servidor encerrando por comando administrativo.
 */
const TRANSIENT_SQL_STATES: ReadonlySet<string> = new Set([
  "40001",
  "40P01",
  "55P03",
  "57014",
  "57P01",
]);

/**
 * Classes inteiras de SQLSTATE que são transitórias por definição (dois primeiros
 * caracteres).
 *
 * - `08` — *connection exception*, a família inteira.
 * - `53` — *insufficient resources*: conexões esgotadas, disco cheio, memória.
 */
const TRANSIENT_SQL_STATE_CLASSES: readonly string[] = ["08", "53"];

/**
 * Erros de rede que nem chegam a ter SQLSTATE — o banco não respondeu.
 *
 * É o caso do PostgreSQL fora do ar: o socket falha antes de existir protocolo,
 * e o driver propaga o código do sistema operacional.
 */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Verdadeiro quando o erro representa indisponibilidade momentânea do banco.
 *
 * Recebe `unknown` de propósito: quem chama é um filtro de exceção e um
 * consumidor de fila, e nenhum dos dois tem garantia de tipo sobre o que foi
 * lançado. A leitura do código é feita por narrowing, sem `as`.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  const code = errorCodeOf(error);

  if (code === undefined) {
    return false;
  }

  return (
    TRANSIENT_SQL_STATES.has(code) ||
    TRANSIENT_NETWORK_CODES.has(code) ||
    TRANSIENT_SQL_STATE_CLASSES.some((prefix) => code.startsWith(prefix))
  );
}

/**
 * Extrai o `code` do erro — SQLSTATE do PostgreSQL ou código de rede do sistema.
 *
 * Funciona porque `DriverException` copia **todas as próprias propriedades** do
 * erro original ao envolvê-lo (verificado em `node_modules`, registrado em
 * `AGENTS.md` §2.1). Sem isso, a conversão do MikroORM apagaria justamente o
 * dado que esta decisão precisa ler.
 */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error;

  return typeof code === "string" ? code : undefined;
}

/**
 * Nome da constraint violada, quando o erro veio de uma violação de integridade.
 *
 * Mesmo mecanismo de `errorCodeOf`: o `pg` põe `constraint` no erro e a conversão
 * preserva. É o que permite a D-035 distinguir **qual** UNIQUE falhou — a mesma
 * `UniqueConstraintViolationException` cobre as cinco constraints únicas desta
 * base, e responder `409` de wallet duplicada para uma violação de idempotência
 * seria dizer ao provedor a coisa errada.
 */
export function violatedConstraintOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("constraint" in error)) {
    return undefined;
  }

  const { constraint } = error;

  return typeof constraint === "string" ? constraint : undefined;
}
