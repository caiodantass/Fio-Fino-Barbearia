/** Erro de regra de negócio com status HTTP e código estável (útil para a IA e o front). */
export class ErroNegocio extends Error {
  constructor(status, codigo, mensagem, detalhes) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
    this.detalhes = detalhes;
  }
}

export const centavosParaReais = (c) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
