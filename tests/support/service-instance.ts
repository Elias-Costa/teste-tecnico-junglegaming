/**
 * O **serviço inteiro** em processo próprio — o alvo de **RT-21**.
 *
 * **Não é arquivo de teste** (o `bun test` só coleta `*.test.ts`); é o programa
 * que `tests/concurrency/service-restart.test.ts` executa com `Bun.spawn`.
 * Espelha `src/main.ts` linha por linha, com uma diferença só: a porta é efêmera
 * e anunciada, para que o pai possa subir duas instâncias sem colisão.
 *
 * A diferença para `tests/support/app-instance.ts` é o módulo raiz, e ela é a
 * razão de este arquivo existir: aquele sobe o `AppModule`, que é **HTTP puro** —
 * de propósito, porque RT-17 precisa de três instâncias servindo sem três
 * consumidores SQS no meio da prova de concorrência. RT-21 precisa do oposto: o
 * `WorkersModule`, com HTTP **e** os três laços, que é o que o enunciado chama de
 * "serviço" quando pede o reinício dele.
 *
 * `enableShutdownHooks()` está aqui pelo mesmo motivo que está em `main.ts`, e o
 * teste conta com isso: a instância que **encerra** o faz de forma ordenada
 * (RF-22), e a que **morre** morre por `SIGKILL`, que nenhum gancho intercepta.
 * Sem os hooks registrados, as duas mortes seriam a mesma coisa e o teste não
 * distinguiria encerramento de crash.
 *
 * **Protocolo com o pai**, e ele difere dos outros dois harnesses num ponto:
 *  - o anúncio `{"ready":true,"baseUrl":"..."}` vai para o **arquivo** apontado
 *    por `SERVICE_ANNOUNCE_FILE`, não para o stdout;
 *  - o fim do stdin encerra com `close()` limpo;
 *  - stdout e stderr ficam herdados, para que log e falha de boot apareçam na
 *    saída do teste.
 *
 * **Por que o anúncio não vai pelo stdout:** este processo sobe o `WorkersModule`
 * inteiro, e o `JsonLogger` de RNF-06 escreve em stdout por decisão registrada
 * (D-061) — `workers.started` sai antes de qualquer coisa que este arquivo
 * escreva. Disputar o stdout com o log obrigaria o pai a filtrar linhas de
 * diagnóstico atrás do handshake, ou obrigaria o harness a trocar o logger, que
 * é justamente substituir a composição de produção que o teste existe para
 * exercitar. Um arquivo é o canal do teste; o stdout continua sendo o do serviço.
 *
 * A migration **não** é aplicada aqui, exatamente como `main.ts` não a aplica:
 * schema é passo de operação, e o teste pai é quem prepara o banco.
 */
import { rename } from "node:fs/promises";
import { NestFactory } from "@nestjs/core";
import { WorkersModule } from "../../src/interface/workers/workers.module.ts";

const anuncioEm = process.env.SERVICE_ANNOUNCE_FILE;

if (anuncioEm === undefined) {
  throw new Error("SERVICE_ANNOUNCE_FILE é obrigatório: é por ele que o pai sabe que subiu.");
}

// `logger: false` deixa em stdout só o log estruturado da aplicação: o banner de
// boot do NestJS não é JSON e sujaria a saída que RNF-06 padroniza.
const app = await NestFactory.create(WorkersModule, { logger: false });

app.enableShutdownHooks();

// Porta efêmera e host explícito: `getUrl()` devolveria um endereço IPv6 em
// algumas máquinas, e nem todo `fetch` o resolve.
await app.listen(0, "127.0.0.1");

// **Escrita em duas etapas, e o rename é o ponto.** O pai detecta o anúncio pela
// existência do arquivo; escrever direto no destino o faz existir vazio por um
// instante, e o pai o lê antes de haver conteúdo — falha observada, não hipótese.
// O rename dentro do mesmo diretório é atômico, então o arquivo passa a existir
// já completo.
const parcial = `${anuncioEm}.parcial`;

await Bun.write(parcial, JSON.stringify({ ready: true, baseUrl: await app.getUrl() }));
await rename(parcial, anuncioEm);

// Uma leitura basta: ela resolve tanto quando chega um byte quanto quando o pai
// fecha o pipe, e nos dois casos o significado é o mesmo — pode encerrar.
await Bun.stdin.stream().getReader().read();

await app.close();
