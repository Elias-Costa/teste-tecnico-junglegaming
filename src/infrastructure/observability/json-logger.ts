import type { LogContext, Logger } from "../../application/ports/logger.ts";

/** Níveis emitidos. Três bastam: informação, alerta operacional e falha. */
type LogLevel = "info" | "warn" | "error";

/**
 * O que sobra de um erro depois da poda de RNF-06.
 *
 * Só `name` e `message`. O objeto inteiro **nunca** é serializado: um
 * `DriverException` do MikroORM copia as próprias propriedades do erro do `pg`
 * (fato verificado em E-08), e entre elas vão os parâmetros da query — que neste
 * sistema são valor monetário e identificadores de jogador.
 */
interface LoggedError {
  name: string;
  message: string;
}

/** Escreve a linha pronta. Injetável para que o teste leia o que foi emitido. */
export type LogSink = (line: string) => void;

/**
 * Logger JSON de uma linha por evento (RNF-06, D-061).
 *
 * Escreve tudo em **stdout**, inclusive erro. Um stream só preserva a ordem
 * relativa dos registros — dois streams entrelaçados perdem exatamente a
 * informação que se procura ao investigar um incidente —, e quem separa
 * severidade é o campo `level`, que o agregador indexa.
 *
 * Uma linha por evento, sem indentação: log de container é lido por agregador, e
 * um objeto quebrado em várias linhas vira vários registros sem relação.
 *
 * O contexto é achatado no objeto raiz em vez de aninhado sob uma chave: é o que
 * permite filtrar por `correlationId` sem que a consulta precise saber a forma
 * interna do registro.
 */
export class JsonLogger implements Logger {
  constructor(private readonly sink: LogSink = writeToStdout) {}

  info(event: string, context?: LogContext): void {
    this.emit("info", event, context);
  }

  warn(event: string, context?: LogContext): void {
    this.emit("warn", event, context);
  }

  error(event: string, error: unknown, context?: LogContext): void {
    this.emit("error", event, context, describeError(error));
  }

  /**
   * Monta e emite o registro.
   *
   * `JSON.stringify` já omite chaves cujo valor é `undefined`, então um contexto
   * parcial — o caso normal, porque nem todo evento tem `transactionId` — sai sem
   * chaves vazias e sem nenhum `null` que o leitor tenha de interpretar.
   */
  private emit(
    level: LogLevel,
    event: string,
    context: LogContext | undefined,
    error?: LoggedError,
  ): void {
    this.sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...context,
        ...(error === undefined ? {} : { error }),
      }),
    );
  }
}

/**
 * Reduz um erro desconhecido aos dois campos que podem ser logados.
 *
 * O que não é `Error` vira a própria descrição textual: um `throw "texto"` ainda
 * precisa aparecer no log, e `String(valor)` é o único jeito de descrevê-lo sem
 * serializar um objeto de origem desconhecida.
 */
function describeError(error: unknown): LoggedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: "UnknownError", message: String(error) };
}

/** Destino padrão: uma linha em stdout. */
function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}
