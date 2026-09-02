import { EntitySchema } from "@mikro-orm/core";

/**
 * A tabela `wallets` como linha (D-026).
 *
 * Espelho fiel de `m0001-initial-schema.ts` — nada aqui é modelagem, é
 * transcrição. O agregado `Wallet` correspondente é reconstruído pelo mapper,
 * que é o único ponto do sistema que conhece as duas representações (D-004).
 */
export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  /**
   * Coluna `numeric(19,2)` lida como **string** (D-004, EL-01).
   *
   * O driver do PostgreSQL devolve `numeric` como texto, e é assim que ele
   * atravessa a infraestrutura: `moneyFromColumns` é o único ponto que
   * interpreta o valor, e ele o entrega como `bigint` de centavos (D-003).
   */
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Mapeamento da linha de wallet.
 *
 * `columnType` explícito em toda coluna: o schema é escrito à mão em SQL
 * (E-05), então o mapeamento precisa dizer exatamente o que já existe lá, em
 * vez de deixar o MikroORM inferir um tipo a partir do TypeScript e acertar por
 * coincidência.
 *
 * **`version` é inteiro comum, não a version property do MikroORM.** Declará-la
 * como versão ligaria o optimistic locking do ORM, que D-002 rejeitou: a
 * concorrência é resolvida por `SELECT ... FOR UPDATE`, e `version` existe por
 * exigência de RF-02 como estado observável do agregado. Um `OptimisticLockError`
 * aparecendo em produção seria um mecanismo que ninguém decidiu adotar.
 */
export const walletRowSchema = new EntitySchema<WalletRow>({
  name: "WalletRow",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", columnType: "uuid", fieldName: "id", primary: true },
    playerId: { type: "string", columnType: "varchar(120)", fieldName: "player_id" },
    currency: { type: "string", columnType: "varchar(3)", fieldName: "currency" },
    balance: { type: "string", columnType: "numeric(19,2)", fieldName: "balance" },
    version: { type: "integer", columnType: "integer", fieldName: "version" },
    createdAt: { type: "datetime", columnType: "timestamptz", fieldName: "created_at" },
    updatedAt: { type: "datetime", columnType: "timestamptz", fieldName: "updated_at" },
  },
});
