import type { IdGenerator } from "../application/ports/id-generator.ts";

/**
 * Gerador de UUIDv7 — a implementação de produção de `IdGenerator` (D-014).
 *
 * `Bun.randomUUIDv7()` é nativo do runtime, verificado no spike E-00: nenhuma
 * biblioteca de UUID entra neste projeto. **Não é `crypto.randomUUID()`**, que
 * produz v4: id v4 não é ordenável no tempo e quebraria em silêncio o cursor
 * keyset de RF-10 — a segunda página viria fora de ordem, sem erro nenhum.
 */
export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
