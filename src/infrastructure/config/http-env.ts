/**
 * Porta HTTP do processo (RF-17, D-063).
 *
 * Mora aqui pelo mesmo motivo registrado em `page-size.ts` (D-058): este
 * diretório é a exceção estreita da guarda de EL-01, e já é o dono dos inteiros
 * que entram no sistema como texto — porta do banco, tamanho de lote, limites de
 * retry. Porta HTTP é exatamente esse tipo de valor, e lê-la no `main.ts`
 * obrigaria a contornar a guarda com um truque de conversão, que é pior do que
 * respeitar a fronteira que o projeto já desenhou.
 */

/** Padrão quando `PORT` não é informada. */
export const DEFAULT_HTTP_PORT = 3000;

/** Forma aceita: inteiro positivo de até 5 dígitos, sem zero à esquerda. */
const PORT_FORMAT = /^[1-9][0-9]{0,4}$/;

/** Maior porta TCP válida. */
const MAX_PORT = 65_535;

/**
 * Lê a porta HTTP do ambiente, caindo no default quando o valor não serve.
 *
 * Cair no default em vez de derrubar o boot é a mesma política de `readRetryEnv`:
 * um `PORT=oito mil` não deve impedir a aplicação de subir, e um processo que não
 * sobe é bem mais difícil de diagnosticar do que um que subiu na porta padrão.
 */
export function readHttpPort(raw: string | undefined = process.env.PORT): number {
  if (raw === undefined || !PORT_FORMAT.test(raw)) {
    return DEFAULT_HTTP_PORT;
  }

  const port = Number(raw);

  return port > MAX_PORT ? DEFAULT_HTTP_PORT : port;
}
