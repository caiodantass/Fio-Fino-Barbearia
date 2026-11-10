import { timingSafeEqual } from 'node:crypto';
import { ErroNegocio } from './erros.js';

/** Wrapper para handlers: converte exceções em respostas JSON padronizadas. */
export const rota = (fn) => async (req, res, next) => {
  try {
    const resultado = await fn(req, res);
    if (resultado !== undefined && !res.headersSent) res.json(resultado);
  } catch (e) {
    next(e);
  }
};

function tokensIguais(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

function extrairToken(req) {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return req.get('x-internal-token') || req.query.token;
}

/** Protege rotas com um token fixo definido em variável de ambiente. */
export const exigirToken = (nomeVariavel) => (req, _res, next) => {
  const esperado = process.env[nomeVariavel];
  if (!esperado) return next(new ErroNegocio(503, 'NAO_CONFIGURADO', `${nomeVariavel} não configurado.`));
  if (!tokensIguais(extrairToken(req), esperado)) {
    return next(new ErroNegocio(401, 'NAO_AUTORIZADO', 'Não autorizado.'));
  }
  next();
};

/** Rate limit simples em memória (por IP) — protege o POST público contra spam. */
export function limitarTaxa({ janelaMs, maximo }) {
  const acessos = new Map();
  setInterval(() => {
    const agora = Date.now();
    for (const [ip, lista] of acessos) {
      const validos = lista.filter((t) => agora - t < janelaMs);
      validos.length ? acessos.set(ip, validos) : acessos.delete(ip);
    }
  }, janelaMs).unref();

  return (req, _res, next) => {
    const agora = Date.now();
    const lista = (acessos.get(req.ip) || []).filter((t) => agora - t < janelaMs);
    if (lista.length >= maximo) {
      return next(new ErroNegocio(429, 'MUITAS_REQUISICOES', 'Muitas tentativas. Aguarde alguns minutos.'));
    }
    lista.push(agora);
    acessos.set(req.ip, lista);
    next();
  };
}

/** Handler global de erros. */
// eslint-disable-next-line no-unused-vars
export function tratarErros(err, _req, res, _next) {
  if (err instanceof ErroNegocio) {
    return res.status(err.status).json({ erro: { codigo: err.codigo, mensagem: err.message, detalhes: err.detalhes } });
  }
  // Violação do índice único de slot (corrida extrema) → conflito, não erro 500
  if (/UNIQUE constraint failed: agendamentos/.test(err?.message)) {
    return res.status(409).json({ erro: { codigo: 'HORARIO_INDISPONIVEL', mensagem: 'Esse horário acabou de ser reservado.' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: { codigo: 'JSON_INVALIDO', mensagem: 'Corpo da requisição inválido.' } });
  }
  console.error(err);
  res.status(500).json({ erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno. Tente novamente.' } });
}
