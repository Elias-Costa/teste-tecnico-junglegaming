/**
 * E-14 — o cursor de RF-10 e o tamanho de página de D-058.
 *
 * As duas metades da paginação que **não** dependem de banco: o codec do cursor
 * opaco (D-014) e a conversão do `limit` que a guarda de EL-01 empurrou para
 * `infrastructure/config` (D-058). A prova de que a paginação realmente
 * atravessa páginas sem repetir nem pular linha é de integração — aqui se prova
 * que valor malformado morre **antes** de virar consulta.
 */
import { describe, expect, it } from "bun:test";
import { InvalidCursorError } from "../../src/application/errors/invalid-cursor-error.ts";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from "../../src/application/ledger-cursor.ts";
import {
  DEFAULT_LEDGER_PAGE_SIZE,
  MAX_LEDGER_PAGE_SIZE,
  parseLedgerPageSize,
} from "../../src/infrastructure/config/page-size.ts";
import { parseLedgerQuery } from "../../src/interface/http/dto/parse-ledger-query.ts";
import { InvalidPayloadError } from "../../src/interface/http/errors/invalid-payload-error.ts";

/**
 * Captura a rejeição sem o matcher `rejects.toThrow()`.
 *
 * As funções aqui são síncronas, então `try/catch` direto basta — mas o formato
 * é o mesmo que o resto da suíte usa, por consistência de leitura.
 */
function erroDe(acao: () => unknown): unknown {
  try {
    acao();
  } catch (error) {
    return error;
  }

  return undefined;
}

describe("cursor do ledger (RF-10, D-014)", () => {
  const id = "0192f291-27dd-7d3f-8071-5f8685deef37";

  it("volta ao id que codificou", () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(id))).toBe(id);
  });

  it("é opaco: não repete o id em claro", () => {
    expect(encodeLedgerCursor(id)).not.toContain(id);
  });

  it("é base64**url**: nunca produz `+`, `/` ou `=`, que a query string escaparia", () => {
    // Um cursor com esses caracteres obrigaria o cliente a lembrar de codificar
    // a URL — e quem esquecesse receberia um erro que parece defeito do servidor.
    for (let i = 0; i < 200; i += 1) {
      const cursor = encodeLedgerCursor(Bun.randomUUIDv7());

      expect(cursor).not.toMatch(/[+/=]/);
    }
  });

  it("recusa texto que não decodifica em UUID — antes de encostar na coluna `uuid`", () => {
    // Sem esta guarda o valor chegaria à query e o `22P02` do PostgreSQL, que
    // D-037 não mapeia, viraria `500` para o que é payload inválido.
    const cursores = [
      Buffer.from("nao-e-uuid", "utf8").toString("base64url"),
      Buffer.from("'; drop table wallet_ledger_entries; --", "utf8").toString("base64url"),
      "cursor-que-nem-e-base64!!",
      "",
    ];

    for (const cursor of cursores) {
      expect(erroDe(() => decodeLedgerCursor(cursor))).toBeInstanceOf(InvalidCursorError);
    }
  });
});

describe("tamanho de página (D-058)", () => {
  it("aceita inteiro positivo dentro do teto", () => {
    expect(parseLedgerPageSize("1")).toBe(1);
    expect(parseLedgerPageSize("50")).toBe(50);
    expect(parseLedgerPageSize("200")).toBe(MAX_LEDGER_PAGE_SIZE);
  });

  it("recusa acima do teto em vez de reduzir em silêncio", () => {
    // Reduzir faria o cliente parar de paginar achando que já recebeu tudo.
    expect(parseLedgerPageSize("201")).toBeUndefined();
    expect(parseLedgerPageSize("9999")).toBeUndefined();
  });

  it("recusa o que não é inteiro positivo em forma canônica", () => {
    for (const raw of ["0", "-1", "1.5", "1e3", " 50", "50 ", "050", "abc", ""]) {
      expect(parseLedgerPageSize(raw)).toBeUndefined();
    }
  });
});

describe("query string de RF-10", () => {
  it("sem parâmetro nenhum: início da lista, página padrão", () => {
    expect(parseLedgerQuery({})).toEqual({
      cursor: undefined,
      limit: DEFAULT_LEDGER_PAGE_SIZE,
    });
  });

  it("repassa o cursor sem interpretá-lo — quem o valida é o codec", () => {
    expect(parseLedgerQuery({ cursor: "abc", limit: "10" })).toEqual({
      cursor: "abc",
      limit: 10,
    });
  });

  it("recusa parâmetro repetido, que chega como array", () => {
    // Duas respostas possíveis para a mesma pergunta não têm desempate correto —
    // mesmo argumento do `Idempotency-Key` repetido.
    expect(erroDe(() => parseLedgerQuery({ limit: ["1", "2"] }))).toBeInstanceOf(
      InvalidPayloadError,
    );
    expect(erroDe(() => parseLedgerQuery({ cursor: ["a", "b"] }))).toBeInstanceOf(
      InvalidPayloadError,
    );
  });

  it("recusa cursor vazio e limit fora do intervalo", () => {
    expect(erroDe(() => parseLedgerQuery({ cursor: "   " }))).toBeInstanceOf(InvalidPayloadError);
    expect(erroDe(() => parseLedgerQuery({ limit: "0" }))).toBeInstanceOf(InvalidPayloadError);
    expect(erroDe(() => parseLedgerQuery({ limit: "500" }))).toBeInstanceOf(InvalidPayloadError);
  });
});
