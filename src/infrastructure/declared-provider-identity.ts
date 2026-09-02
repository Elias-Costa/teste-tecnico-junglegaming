import type { ProviderIdentityPort } from "../application/ports/provider-identity.ts";

/**
 * Implementação **no-op** de `ProviderIdentityPort` (D-012).
 *
 * Devolve o `providerId` declarado no payload, sem verificar credencial nenhuma.
 * É o outro lado do `AuthGuard` vazio: a porta existe e está no caminho de toda
 * submissão, então implementá-la de verdade é trocar o corpo deste método —
 * validar um JWT, consultar um IdP — sem tocar em controller nem em use case.
 *
 * Aceitar a identidade declarada **não** relaxa nenhuma regra de negócio: o
 * `providerId` continua sendo o que resolve a referência em RN-07, e uma
 * operação que aponte para transação de outro provedor é rejeitada com
 * `REFERENCE_MISMATCH` como sempre foi. O que falta é a prova de que o chamador
 * é quem diz ser — e é exatamente isso que `ARCHITECTURE.md` documenta como não
 * implementado.
 */
export class DeclaredProviderIdentity implements ProviderIdentityPort {
  resolve(_credentials: string | undefined, declaredProviderId: string): Promise<string> {
    return Promise.resolve(declaredProviderId);
  }
}
