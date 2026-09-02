import { createHash } from "node:crypto";
import type { MoneyProps } from "../domain/money.ts";
import type { WagerTransactionKind } from "../domain/wager-transaction.ts";

/**
 * Os **10 campos de negócio** que entram no hash (D-005, RF-14).
 *
 * A lista é contrato: alterá-la invalida todos os `payloadHash` já gravados e é
 * mudança registrada em `docs/decisions.md`. Header `Idempotency-Key` e qualquer
 * metadado de transporte ficam fora por exigência da §9 do enunciado — é o que
 * permite a mesma operação chegar por HTTP e por SQS e produzir o mesmo hash.
 */
export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  /** Já normalizado por D-015 — `"25"` e `"25.00"` não coexistem na entrada. */
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * `payloadHash` canônico: SHA-256 sobre JSON de chaves ordenadas (D-005).
 *
 * Calculado **aqui**, na aplicação, e não no caller (D-032): RF-18 exige um só
 * caminho de processamento para HTTP e SQS, e RF-14 exige que a mesma operação
 * produza o mesmo hash pelos dois. Dois callers hasheando por conta própria
 * fariam essa igualdade depender de disciplina, e a divergência apareceria como
 * `IDEMPOTENCY_CONFLICT` falso num reenvio legítimo.
 *
 * `undefined` é **omitido** do JSON — uma operação sem referência não hasheia
 * como uma com referência vazia. O `null` que D-005 manda rejeitar é barrado na
 * borda (E-08), onde o valor ainda é `unknown`: aqui os campos já são `string`,
 * e um guard seria código que o compilador prova inalcançável.
 */
export function payloadHashOf(fields: PayloadHashFields): string {
  // Nomes exatamente como D-005 os lista, `money.amount` e `money.currency`
  // incluídos: a chave achatada mantém a ordenação num nível só e faz o JSON
  // gravado corresponder, campo a campo, ao texto da decisão.
  const values: Readonly<Record<string, string | undefined>> = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    "money.amount": fields.money.amount,
    "money.currency": fields.money.currency,
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };

  const canonical: Record<string, string> = {};

  // Ordenação explícita em vez de confiar na ordem em que os campos foram
  // escritos acima: a ordem literal é fácil de quebrar numa edição futura, e o
  // resultado seria um hash diferente para o mesmo negócio — sem erro nenhum.
  // `JSON.stringify` preserva a ordem de inserção destas chaves porque nenhuma
  // delas tem forma de índice de array.
  for (const key of Object.keys(values).sort()) {
    const value = values[key];

    if (value !== undefined) {
      canonical[key] = value;
    }
  }

  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
