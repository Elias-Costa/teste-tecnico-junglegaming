import { afterEach, describe, expect, it } from "bun:test";
import { buildClientUrl, readDatabaseEnv } from "../../src/infrastructure/config/database-env.ts";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("readDatabaseEnv", () => {
  it("usa a porta 55432 por padrão, não a 5432", () => {
    delete process.env.PGPORT;

    // O que este teste protege não é o número, é o alinhamento: se o default
    // daqui e o do docker-compose.yml divergirem, o cliente passa a apontar
    // para uma porta que ninguém publicou.
    expect(readDatabaseEnv().port).toBe(55432);
  });

  it("deixa o ambiente sobrescrever, que é como o Testcontainers injeta (D-011)", () => {
    process.env.PGHOST = "127.0.0.1";
    process.env.PGPORT = "49876";
    process.env.PGDATABASE = "provisionado";

    const env = readDatabaseEnv();
    expect(env.host).toBe("127.0.0.1");
    expect(env.port).toBe(49876);
    expect(env.dbName).toBe("provisionado");
  });
});

describe("buildClientUrl", () => {
  it("monta a URL a partir das partes", () => {
    expect(
      buildClientUrl({
        host: "db.local",
        port: 55432,
        user: "wagering",
        password: "wagering",
        dbName: "wagering",
      }),
    ).toBe("postgresql://wagering:wagering@db.local:55432/wagering");
  });

  it("escapa credencial com caractere reservado", () => {
    // O Testcontainers gera senha aleatória; um `@` ou `/` não escapado
    // quebraria a URL de forma difícil de diagnosticar.
    const url = buildClientUrl({
      host: "db.local",
      port: 55432,
      user: "user@corp",
      password: "p@ss/word:1",
      dbName: "wagering",
    });

    expect(url).toBe("postgresql://user%40corp:p%40ss%2Fword%3A1@db.local:55432/wagering");
    expect(new URL(url).hostname).toBe("db.local");
  });
});
