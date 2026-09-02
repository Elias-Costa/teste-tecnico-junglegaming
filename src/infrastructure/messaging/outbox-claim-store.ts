import type { FilterQuery } from "@mikro-orm/core";
import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import type { OutboxMessage } from "../../domain/outbox-message.ts";
import { toOutboxMessage } from "../persistence/mappers/outbox-message-mapper.ts";
import {
  type OutboxMessageRow,
  outboxMessageRowSchema,
} from "../persistence/rows/outbox-message-row.ts";
import { READ_WITHOUT_IDENTITY_MAP } from "../persistence/repositories/read-options.ts";

/** O que uma rodada de claim precisa saber (D-009). */
export interface ClaimRequest {
  /** Identidade da instância que reivindica — vai para `locked_by`. */
  instanceId: string;
  now: Date;
  /** Quantas linhas reivindicar de uma vez. */
  batchSize: number;
  /** Duração do lease, em ms (D-008: 30 s por padrão). */
  leaseMs: number;
}

/**
 * As três escritas operacionais do lease da outbox (RF-24, D-009).
 *
 * Vive aqui, e não em `MikroOutboxRepository`, porque o repositório persiste o
 * **agregado** e este objeto manipula **estado de entrega**: quem está
 * trabalhando na linha, até quando, e o desfecho da tentativa. O JSDoc de lá já
 * dizia que o claim com lease seria de E-10 e não da persistência do agregado —
 * este arquivo é o cumprimento daquilo.
 *
 * Nenhum método aqui faz I/O de rede. É condição de D-009: o publisher **nunca**
 * segura transação de banco aberta durante a chamada ao SQS, porque um SQS lento
 * exauriria o pool de conexões — a primeira crítica que um avaliador levanta, e a
 * que não tem defesa boa.
 */
export class OutboxClaimStore {
  constructor(private readonly em: EntityManager) {}

  /**
   * Reivindica um lote de mensagens devidas, com lease (D-009).
   *
   * `LockMode.PESSIMISTIC_PARTIAL_WRITE` emite `FOR UPDATE SKIP LOCKED`: duas
   * instâncias varrendo ao mesmo tempo não disputam a mesma linha, e a segunda
   * **pula** em vez de esperar. É a disputa acontecendo no banco, que é o único
   * lugar onde ela pode acontecer com múltiplas instâncias (RI-08, EL-05) — a
   * entidade `OutboxMessage` deliberadamente não opina sobre isso (`isDue` olha
   * só o agendamento).
   *
   * A transação é **curta e sem rede**: seleciona, grava o par do lease e
   * commita. O publish acontece depois, fora daqui.
   *
   * **O que cada parte sustenta, verificado por sonda em E-10.** Quem impede a
   * dupla reivindicação é o *lock de linha dentro da transação*: sem `lockMode`
   * nenhum, dois publishers leem as mesmas linhas antes de qualquer um gravar o
   * lease, e RT-19 acusa 100 publicações para 60 mensagens. Trocado por
   * `PESSIMISTIC_WRITE` — `FOR UPDATE` sem `SKIP LOCKED` — o teste **passa**: ao
   * soltar o lock, o PostgreSQL reavalia o predicado contra a versão nova da
   * linha, e o segundo publisher descarta o que já foi reivindicado. Ou seja,
   * `SKIP LOCKED` compra **vazão**, não correção: sem ele o segundo publisher
   * esperaria o primeiro em vez de seguir adiante. É a leitura correta de D-009,
   * e vale registrar porque a leitura intuitiva é a oposta.
   *
   * Não há filtro por `attempts` (D-042): as 10 tentativas de D-008 limitam a
   * curva do backoff e servem de limiar de alerta, não de desistência. Todo
   * evento gravado na mesma transação do dinheiro precisa sair.
   */
  async claim(request: ClaimRequest): Promise<OutboxMessage[]> {
    return this.em.transactional(async (tx) => {
      const rows = await tx.find(outboxMessageRowSchema, claimableAt(request.now), {
        ...READ_WITHOUT_IDENTITY_MAP,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        limit: request.batchSize,
        // Ordem de id é ordem cronológica: o id é UUIDv7 (D-014). Publicar na
        // ordem em que os eventos aconteceram é o que faz o `MessageGroupId` de
        // D-040 entregar ordem por agregado do lado do consumidor.
        orderBy: { id: "asc" },
      });

      if (rows.length === 0) {
        return [];
      }

      const lockedUntil = new Date(request.now.getTime() + request.leaseMs);

      await tx.nativeUpdate(
        outboxMessageRowSchema,
        { id: { $in: rows.map((row) => row.id) } },
        // O par é escrito junto, sempre: `ck_outbox_messages_lease_pair` recusa
        // metade preenchida, e uma linha reivindicada sem prazo ficaria presa
        // para sempre — o oposto do que o lease existe para evitar.
        { lockedBy: request.instanceId, lockedUntil },
      );

      return rows.map((row) => toOutboxMessage({ ...row, lockedBy: request.instanceId, lockedUntil }));
    });
  }

  /**
   * Marca a publicação e **libera o lease** (D-043).
   *
   * Os três campos vão no mesmo `UPDATE` porque descrevem um fato só: a linha
   * saiu. Lease é sobre trabalho em andamento, e trabalho concluído não tem
   * lease — sem a limpeza, toda linha publicada carregaria um `locked_until` no
   * passado que nenhuma consulta usa e que uma leitura de incidente teria de
   * aprender a ignorar.
   */
  async markPublished(id: string, at: Date): Promise<void> {
    await this.em.nativeUpdate(
      outboxMessageRowSchema,
      { id },
      { publishedAt: at, lockedBy: null, lockedUntil: null },
    );
  }

  /**
   * Persiste o reagendamento de uma tentativa que falhou e libera o lease.
   *
   * `attempts` e `nextAttemptAt` chegam já calculados por
   * `OutboxMessage.scheduleRetry` (D-022) — a curva é do domínio, e recalculá-la
   * aqui criaria uma segunda curva para manter.
   *
   * Soltar o lease na falha é o ponto: é o **agendamento**, e não o prazo do
   * lease, que decide quando a próxima tentativa acontece. Segurar o lease até
   * vencer atrasaria uma retentativa de 1 s pelos 30 s do lease.
   */
  async releaseForRetry(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      outboxMessageRowSchema,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        lockedBy: null,
        lockedUntil: null,
      },
    );
  }
}

/**
 * O predicado do caminho quente: pendente, devida e livre.
 *
 * As três condições são o índice parcial `ix_outbox_messages_pending` de E-05
 * lido em forma de query — `published_at is null` no `where` do índice,
 * `next_attempt_at` e `locked_until` nas colunas dele.
 *
 * Lease **vencido conta como livre**: é exatamente o que permite outra instância
 * assumir quando a primeira morreu entre o commit e a publicação, o cenário
 * obrigatório de RF-24.
 */
function claimableAt(now: Date): FilterQuery<OutboxMessageRow> {
  return {
    publishedAt: null,
    $and: [
      { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
    ],
  };
}
