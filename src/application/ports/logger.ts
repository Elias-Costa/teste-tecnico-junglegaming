/**
 * Os campos que um registro de log pode carregar (RNF-06, D-061).
 *
 * **A lista é fechada de propósito, e essa é a decisão inteira.** RNF-06 exige
 * `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, e
 * proíbe "dados sensíveis ou payloads financeiros completos". Fechar os campos
 * num tipo transforma a segunda metade do requisito em erro de compilação: não
 * existe assinatura aqui que aceite um `Money`, um saldo ou um payload, então
 * "vazou dinheiro no log" deixa de ser algo que alguém precisa lembrar de não
 * fazer.
 *
 * A alternativa usual — um `Record<string, unknown>` com lista de redaction —
 * protege por exclusão, e lista de exclusão falha em silêncio no dia em que um
 * campo novo aparece. É a razão registrada em D-061 para não usar biblioteca.
 *
 * Os três campos além dos cinco de RNF-06 (`kind`, `status`, `failureCode`) são
 * **categóricos**: pertencem a conjuntos fechados do domínio, não trazem valor
 * monetário e são o que torna um log de rejeição legível sem consultar o banco.
 */
export interface LogContext {
  /** Correlação de ponta a ponta (D-039, e a coluna de D-055 quando o desfecho é do worker). */
  correlationId?: string | undefined;
  /** `messageId` do **corpo** da mensagem consumida (D-044). */
  messageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
  /** `WagerTransactionKind`, como texto. */
  kind?: string | undefined;
  /** `WagerTransactionStatus`, como texto. */
  status?: string | undefined;
  /** `FailureCode` de D-007, quando o desfecho tem um. */
  failureCode?: string | undefined;
}

/**
 * Porta de log estruturado (RNF-06, D-061).
 *
 * Vive em `src/application/ports/` ao lado de `Clock` e `IdGenerator` — não
 * porque os use cases logem hoje (nenhum loga), mas porque a porta aqui é o que
 * permitiria a um deles receber o logger sem importar infraestrutura. Quem
 * implementa é `JsonLogger`; quem chama são as bordas e os workers (D-062).
 *
 * `error` recebe o erro **por parâmetro próprio**, fora do contexto: a
 * implementação extrai apenas `name` e `message`. É deliberado — um erro do
 * driver do PostgreSQL carrega os parâmetros da query, e parâmetro de query
 * neste sistema é dinheiro.
 */
export interface Logger {
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, error: unknown, context?: LogContext): void;
}
