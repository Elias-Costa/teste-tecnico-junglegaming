/**
 * Corpo ou header da requisição malformado (RF-13, D-006, D-038).
 *
 * É o `400` da borda: **forma**, não valor. A validação de valor é do domínio —
 * `Money.from` decide escala e moeda (D-015, D-016), `WagerTransaction.create`
 * decide a exigência de referência (D-020) —, e duplicá-la aqui criaria duas
 * descrições da mesma regra, que divergem na primeira mudança.
 *
 * O que este erro cobre é o que só se pode perguntar quando o valor ainda é
 * `unknown`: veio objeto? o campo é string? veio `null`? É a rejeição de `null`
 * que D-005 exige e que D-032 deixou explicitamente para esta etapa — no comando
 * tipado o `null` não chega, e o guard lá seria código inalcançável.
 */
export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPayloadError";
  }
}
