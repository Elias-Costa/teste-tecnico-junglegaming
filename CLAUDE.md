@AGENTS.md

## Claude Code — Instruções Específicas

- **Use o modo de plano (plan mode)** para qualquer etapa que toque mais de um módulo ao mesmo tempo (domínio + migration + repositório + rota; worker + outbox; consumer + inbox). Neste projeto isso é quase toda etapa. Apresente o plano antes de editar.
- Sempre rode `bun run check` antes de reportar uma tarefa como concluída e **cole a saída na resposta**. Para etapas que tocam Postgres ou SQS, rode também `bun run check:full`.
- Ao final de cada tarefa concluída, cite qual(is) requisito(s) de `docs/requirements.md` (RF-XX / RN-XX / RT-XX) foram atendidos.
- **IMPORTANTE: antes de dar qualquer etapa por pronta, verifique explicitamente quais falhas eliminatórias (EL-01..EL-08) a etapa poderia ter introduzido e diga qual teste prova que não foram.** Nenhuma etapa que toque dinheiro, saldo, idempotência ou publicação de evento é concluída sem isso.
- Se notar uma inconsistência entre `docs/desafio-original.md`, `docs/requirements.md` e `docs/decisions.md`, **pare e reporte a inconsistência** em vez de escolher qual documento seguir.
- Use `/clear` entre etapas. Contexto acumulado de uma etapa anterior degrada a próxima.
