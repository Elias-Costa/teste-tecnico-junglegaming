/**
 * Uma instância da aplicação, em processo próprio — o alvo de RT-17.
 *
 * **Não é arquivo de teste** (o `bun test` só coleta `*.test.ts`); é o programa
 * que `tests/concurrency/multi-instance.test.ts` executa três vezes com
 * `Bun.spawn`. Sobe o **`AppModule` de produção**, sem substituir nada: mesmo
 * grafo de dependências, mesmo `UnitOfWork`, mesmo relógio, mesmo gerador de id.
 *
 * Por que a aplicação inteira, e não um worker chamando o use case direto: RI-08
 * cobra que a solução esteja correta com **múltiplas instâncias da aplicação**, e
 * EL-05 é exatamente "correta somente com uma instância". Três processos de
 * sistema operacional servindo HTTP contra um único PostgreSQL é a leitura
 * literal disso — e é a única forma de a prova não depender de nenhum estado
 * compartilhado em memória, que é o mecanismo que EL-05 exige.
 *
 * A conexão vem do ambiente herdado do processo pai (D-011): esta instância não
 * sabe — nem pode saber — se quem provisionou o banco foi o Docker Compose ou o
 * Testcontainers.
 *
 * **Protocolo com o pai**, deliberadamente mínimo:
 *  - stdout recebe **uma** linha JSON `{"ready":true,"baseUrl":"..."}` quando a
 *    instância está servindo. É o handshake que sincroniza os três processos sem
 *    depender de relógio ou de `sleep`.
 *  - o fim do stdin — o pai fechando o pipe, ou qualquer byte nele — encerra a
 *    instância com `close()` limpo.
 *  - stderr fica herdado do pai, para que uma falha de boot apareça na saída do
 *    teste em vez de sumir num pipe que ninguém lê.
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/interface/http/app.module.ts";

// `logger: false` mantém o stdout limpo: o handshake é uma linha JSON, e o
// banner de boot do NestJS no meio dela quebraria o parse do pai.
const app = await NestFactory.create(AppModule, { logger: false });

// Porta efêmera e host explícito, como no teste de E-08: `getUrl()` devolveria
// um endereço IPv6 em algumas máquinas, e nem todo `fetch` o resolve.
await app.listen(0, "127.0.0.1");

await Bun.write(Bun.stdout, `${JSON.stringify({ ready: true, baseUrl: await app.getUrl() })}\n`);

// Espera o sinal de encerramento do pai. Uma leitura só basta: ela resolve tanto
// quando chega um byte quanto quando o pai fecha o pipe, e nos dois casos o
// significado é o mesmo — pode encerrar. O conteúdo nunca é lido.
await Bun.stdin.stream().getReader().read();

await app.close();
