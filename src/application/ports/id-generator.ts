/**
 * Fonte dos identificadores gerados pela aplicação (D-014).
 *
 * Ids não têm `DEFAULT` no banco e não nascem no domínio: quem os gera é a
 * camada de aplicação, com UUIDv7 (`Bun.randomUUIDv7()`), porque o cursor keyset
 * de RF-10 depende de id ordenável no tempo.
 *
 * Ser porta, e não chamada direta, é o que torna a atomicidade de RF-23
 * testável contra o PostgreSQL real: um gerador que devolve um id já existente
 * produz `23505` de verdade no meio da transação, e o teste observa o rollback
 * sem nenhum mock de banco no caminho (RT-09, EL-08).
 */
export interface IdGenerator {
  /** Próximo identificador. Cada agregado, evento e linha de outbox consome um. */
  next(): string;
}
