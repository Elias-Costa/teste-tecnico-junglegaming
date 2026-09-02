/**
 * Identidade do provedor que assina a requisição — **ponto de extensão de D-012**.
 *
 * A autenticação **não é implementada** neste projeto, por decisão registrada:
 * ela vale zero ponto na tabela de avaliação e competiria com os 70 pontos do
 * núcleo. O enunciado (§2) aceita a não-implementação desde que o desenho
 * pretendido esteja documentado e exista ponto de extensão explícito no código.
 * Esta porta e o `AuthGuard` no-op de `src/interface/http` são esse ponto.
 *
 * Fica na **aplicação**, e não no domínio: identidade de provedor não é agregado
 * deste sistema — é um fato sobre quem chamou, não sobre o dinheiro.
 *
 * O desenho completo (qual IdP, onde o guard entraria, o que mudaria no contrato
 * da API) é seção de `ARCHITECTURE.md`, entregue em E-17.
 */
export interface ProviderIdentityPort {
  /**
   * Resolve o provedor a partir das credenciais da requisição.
   *
   * A implementação atual devolve a identidade **declarada** no payload, sem
   * verificar nada. É o que "não implementar autenticação" significa aqui — e o
   * ponto que D-012 faz questão de deixar explícito: **não autenticar não relaxa
   * regra de negócio.** O `providerId` continua sujeito às validações de domínio,
   * inclusive à posse da referência exigida por RN-07.
   *
   * @param credentials material de autenticação da requisição (hoje ignorado).
   * @param declaredProviderId o `providerId` que veio no corpo da requisição.
   */
  resolve(credentials: string | undefined, declaredProviderId: string): Promise<string>;
}
