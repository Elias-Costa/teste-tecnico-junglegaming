/**
 * Uma dependência externa que precisa estar alcançável para o processo servir
 * tráfego (RF-17).
 *
 * A porta existe para que `GET /health/ready` não conheça nem PostgreSQL nem
 * SQS: a borda HTTP tem lint que veta `@aws-sdk/*` (EL-06), então a checagem do
 * SQS **não pode** ser escrita no controller nem que se quisesse. O controller
 * recebe uma lista destas e reporta nome por nome.
 *
 * `check()` **não lança**: uma dependência fora do ar é a resposta esperada de um
 * endpoint de readiness, não um erro dele. Cada implementação captura a própria
 * falha e devolve `false`.
 */
export interface ReadinessProbe {
  /** Nome que aparece no corpo da resposta — `postgres`, `sqs`. */
  readonly name: string;
  check(): Promise<boolean>;
}
