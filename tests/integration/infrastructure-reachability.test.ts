/**
 * Alcançabilidade de PostgreSQL e SQS pela configuração lida do ambiente.
 *
 * Serve a dois propósitos:
 *
 *  1. É a prova de que a metade Testcontainers de D-011 funciona — quando
 *     rodado por `check:full`, quem provisionou foi o preload, e o teste não
 *     sabe disso. Rodado no loop de desenvolvimento, quem provisionou foi o
 *     Compose. O teste é idêntico nos dois casos, que é o critério de D-011.
 *  2. É o mesmo par de verificações que `GET /health/ready` vai fazer em E-15
 *     (RF-17): PostgreSQL e SQS alcançáveis.
 *
 * Nota registrada em D-001: `orm.isConnected()` é preguiçoso e retorna `false`
 * antes da primeira conexão real. Readiness precisa emitir query de verdade —
 * por isso o teste abaixo executa `select 1` em vez de consultar o flag.
 */
import { describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { ListQueuesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { buildClientUrl } from "../../src/infrastructure/config/database-env.ts";
import { readSqsEnv } from "../../src/infrastructure/config/sqs-env.ts";

describe("infraestrutura alcançável pela configuração de ambiente (D-011)", () => {
  it("PostgreSQL responde a uma query real", async () => {
    const orm = await MikroORM.init({
      entities: [],
      // Ainda não há entidades mapeadas; o objetivo aqui é a conexão.
      discovery: { warnWhenNoEntities: false },
      clientUrl: buildClientUrl(),
    });

    try {
      const rows = await orm.em.getConnection().execute<{ ok: number }[]>("select 1 as ok");
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await orm.close(true);
    }
  });

  it("SQS responde a uma chamada de API real", async () => {
    const env = readSqsEnv();
    const client = new SQSClient({
      region: env.region,
      endpoint: env.endpoint,
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
    });

    try {
      const result = await client.send(new ListQueuesCommand({}));
      expect(result.$metadata.httpStatusCode).toBe(200);
    } finally {
      client.destroy();
    }
  });
});
