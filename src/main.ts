/**
 * Ponto de entrada do processo (D-063).
 *
 * Sobe **um** processo que serve HTTP e roda os três laços de mensageria. É a
 * leitura correta de D-010 para este projeto: os contadores do `prom-client` são
 * por processo, então API e workers juntos fazem um `/metrics` cobrir as oito
 * métricas. Separá-los é legítimo em produção — bastaria um segundo entrypoint
 * montando só o `WorkersModule` —, e aí cada processo exporia o seu, com o
 * scraper agregando. O que **não** funcionaria é worker sem `/metrics` nenhum,
 * que era o estado do repositório até esta etapa.
 *
 * Escalar horizontalmente continua sendo subir mais instâncias deste mesmo
 * processo: nenhum estado de coordenação vive em memória — o lease da outbox
 * (D-009), a inbox (RF-19) e o `FOR UPDATE` da wallet (D-002) estão todos no
 * banco, que é o que RI-08 e EL-05 cobram.
 *
 * **Não aplica migration.** Schema é passo de operação, não efeito colateral de
 * boot: duas instâncias subindo juntas disputariam o `up`, e um `up` automático
 * em produção transforma deploy em migração silenciosa. O comando é
 * `bun run migration:up`, e o README (E-17) o documenta como passo próprio.
 */
import { NestFactory } from "@nestjs/core";
import { readHttpPort } from "./infrastructure/config/http-env.ts";
import { WorkersModule } from "./interface/workers/workers.module.ts";

const app = await NestFactory.create(WorkersModule);

// **É isto que faz RF-22 existir fora do teste.** Sem os shutdown hooks, o
// `SIGTERM` do `docker stop` mataria o processo sem passar pelo
// `onApplicationShutdown` do `WagerWorkers` — e uma mensagem em processamento
// ficaria invisível na fila até o visibility timeout vencer, em vez de ser
// devolvida na hora.
app.enableShutdownHooks();

// Host explícito: sem ele, algumas máquinas publicam só em IPv6 e o cliente do
// avaliador não conecta. `0.0.0.0` porque o processo é feito para rodar em
// container, onde ouvir só em `localhost` o tornaria inalcançável de fora.
await app.listen(readHttpPort(), "0.0.0.0");
