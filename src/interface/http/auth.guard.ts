import { type CanActivate, Injectable } from "@nestjs/common";

/**
 * Guard de autenticação **no-op** — o ponto de extensão de D-012.
 *
 * A autenticação não é implementada neste projeto, e isso é decisão registrada,
 * não omissão: ela vale zero ponto na tabela de avaliação e competiria com os 70
 * pontos do núcleo. A §2 do enunciado aceita explicitamente a não-implementação
 * desde que o desenho pretendido esteja documentado e exista **ponto de extensão
 * explícito no código**. Este guard, registrado de verdade em `APP_GUARD`, e a
 * `ProviderIdentityPort` da camada de aplicação são esse ponto.
 *
 * Está registrado globalmente e libera tudo. É deliberadamente um guard vazio, e
 * não a ausência de guard: quem for implementar auth troca o corpo de um método
 * que já está no caminho de toda requisição, em vez de descobrir onde plugá-lo.
 *
 * **Não autenticar não relaxa regra de negócio** — o ponto que D-012 faz questão
 * de deixar explícito. O `providerId` que chega no payload continua sujeito às
 * validações de domínio, inclusive à posse da referência exigida por RN-07.
 *
 * Os endpoints de health de E-15 permanecem abertos por requisito (RF-17), o que
 * é coerente com este desenho por construção.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /**
   * Libera toda requisição.
   *
   * Sem parâmetro de contexto de propósito: um `ExecutionContext` recebido e
   * ignorado sugeriria que alguma inspeção acontece aqui. Nada acontece — e é
   * isso que precisa ficar legível para quem vier implementar.
   */
  canActivate(): boolean {
    return true;
  }
}
