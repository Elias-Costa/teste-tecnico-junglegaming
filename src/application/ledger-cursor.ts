import { isUuid } from "../domain/identifier.ts";
import { InvalidCursorError } from "./errors/invalid-cursor-error.ts";

/**
 * Codec do cursor de paginação do ledger (RF-10, D-014).
 *
 * O cursor é o **id do último lançamento entregue**, em base64url. RF-10 exige
 * que ele seja estável e opaco: estável porque o id é UUIDv7 e a ordem não muda
 * com inserção concorrente; opaco porque o cliente não deve construir um cursor
 * à mão nem depender do que há dentro dele. A opacidade aqui é convenção de
 * contrato, não segredo — base64url é reversível e não pretende proteger nada.
 *
 * A validação do conteúdo decodificado é `isUuid` (D-014), compartilhada com a
 * borda HTTP: a forma de um id é um fato só, e ter duas cópias dele é como as
 * duas divergem.
 */

/** Codifica o id do último lançamento da página como cursor opaco. */
export function encodeLedgerCursor(entryId: string): string {
  return Buffer.from(entryId, "utf8").toString("base64url");
}

/**
 * Decodifica o cursor no id que ele representa.
 *
 * @throws InvalidCursorError se o texto não for base64url de um UUID bem formado
 * — a validação que D-014 exige antes de o valor entrar na query.
 */
export function decodeLedgerCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");

  if (!isUuid(decoded)) {
    throw new InvalidCursorError(
      "cursor inválido: use o `nextCursor` devolvido pela página anterior.",
    );
  }

  return decoded;
}
