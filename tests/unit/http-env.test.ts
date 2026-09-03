/**
 * E-15 — leitura da porta HTTP (D-063).
 *
 * Mesmo espírito de `database-env.test.ts` e `retry-env.test.ts`: a política é
 * **cair no default em vez de derrubar o boot**, porque um processo que não sobe
 * é mais difícil de diagnosticar do que um que subiu na porta errada.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_HTTP_PORT, readHttpPort } from "../../src/infrastructure/config/http-env.ts";

describe("readHttpPort (RF-17, D-063)", () => {
  it("usa 3000 quando PORT não é informada", () => {
    expect(readHttpPort(undefined)).toBe(DEFAULT_HTTP_PORT);
  });

  it("aceita uma porta válida", () => {
    expect(readHttpPort("8080")).toBe(8080);
  });

  it("cai no default em valor não numérico, em vez de propagar NaN", () => {
    expect(readHttpPort("oito mil")).toBe(DEFAULT_HTTP_PORT);
  });

  it("recusa zero, negativo e porta acima do máximo de TCP", () => {
    expect(readHttpPort("0")).toBe(DEFAULT_HTTP_PORT);
    expect(readHttpPort("-1")).toBe(DEFAULT_HTTP_PORT);
    expect(readHttpPort("70000")).toBe(DEFAULT_HTTP_PORT);
  });

  it("recusa forma decimal e zero à esquerda", () => {
    expect(readHttpPort("8080.5")).toBe(DEFAULT_HTTP_PORT);
    expect(readHttpPort("08080")).toBe(DEFAULT_HTTP_PORT);
  });
});
