/**
 * API pública (consumida pelo Site e também pela IA para consultas).
 *
 *  GET  /api/servicos
 *  GET  /api/barbeiros
 *  GET  /api/horarios-disponiveis?barbeiro_id=1&servico_id=3&data=2026-11-03
 *  POST /api/agendamentos          { nome, whatsapp, barbeiro_id, servico_id, inicio }
 *  GET  /api/eventos               (SSE — tempo real)
 */
import { Router } from 'express';
import * as agenda from '../services/agenda.js';
import { rota, limitarTaxa } from '../lib/http.js';
import { conectarSSE } from '../lib/realtime.js';

export const rotasPublicas = Router();

rotasPublicas.get('/servicos', rota(() => ({ servicos: agenda.listarServicos() })));

rotasPublicas.get('/barbeiros', rota(() => ({ barbeiros: agenda.listarBarbeiros() })));

rotasPublicas.get('/horarios-disponiveis', rota((req, res) => {
  res.set('Cache-Control', 'no-store'); // agenda muda a todo instante
  const { barbeiro_id, servico_id, data } = req.query;
  return agenda.horariosDisponiveis({ barbeiroId: barbeiro_id, servicoId: servico_id, data });
}));

rotasPublicas.post(
  '/agendamentos',
  limitarTaxa({ janelaMs: 10 * 60_000, maximo: 30 }),
  rota((req, res) => {
    const { nome, whatsapp, barbeiro_id, servico_id, inicio, website } = req.body ?? {};
    if (website) return res.status(204).end(); // honeypot anti-bot (campo invisível no form)
    const agendamento = agenda.criarAgendamento({
      nome, whatsapp, barbeiroId: barbeiro_id, servicoId: servico_id, inicio, origem: 'site',
    });
    res.status(201).json({ agendamento });
  }),
);

rotasPublicas.get('/eventos', conectarSSE);
