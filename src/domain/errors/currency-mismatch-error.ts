/**
 * Conflito de moeda entre dois valores monetários (RF-01, RT-04).
 *
 * É erro de **domínio**, não caminho de negócio: somar BRL com USD é operação
 * sem significado, e não uma rejeição que o provedor possa corrigir sozinho.
 * Quem traduz isso em resposta é a borda — a mesma condição observada contra a
 * wallet vira o `failureCode` `CURRENCY_MISMATCH` (RF-02, D-007).
 *
 * Carrega as duas moedas porque a mensagem formatada não é interface: quem
 * trata o erro precisa dos valores, não de um texto para desmontar.
 */
export class CurrencyMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly received: string,
  ) {
    super(`conflito de moeda: esperado ${expected}, recebido ${received}.`);
    this.name = "CurrencyMismatchError";
  }
}
