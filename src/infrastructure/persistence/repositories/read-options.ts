/**
 * Opções comuns a toda leitura dos repositórios (D-028).
 *
 * `disableIdentityMap` desliga o identity map do MikroORM na volta da consulta.
 * A escrita já é por comando explícito — `em.insert()` e `em.nativeUpdate()`, sem
 * `persist`/`flush` —, e sem esta opção o rastreamento voltaria pela porta da
 * leitura: uma linha lida ficaria gerenciada, e um `flush()` chamado em qualquer
 * outro ponto do processo poderia emitir `UPDATE` por ela.
 *
 * Isso importa em especial no ledger. A trigger de D-023 recusa `UPDATE` com
 * `P0001` (RI-05, EL-07), e ela deve continuar sendo a rede de segurança que
 * ninguém consegue acionar — não o mecanismo que segura o dia a dia.
 */
export const READ_WITHOUT_IDENTITY_MAP = { disableIdentityMap: true } as const;
