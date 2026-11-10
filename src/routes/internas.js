/**
 * API interna — usada pela Secretária Virtual (IA). Protegida por INTERNAL_API_TOKEN.
 * O WhatsApp do cliente vem SEMPRE do remetente da mensagem (nunca do texto/LLM),
 * garantindo que um cliente só consiga mexer nos próprios agendamentos.
 *
 *  GET   /api/interno/clientes/:whatsapp                 → cliente + próximos agendamentos
 *  POST  /api/interno/agendamentos                        { whatsapp, nome?, barbeiro_id, servico_id, inicio }
 *  PATCH /api/interno/agendamentos/:id/remarcar           { whatsapp, inicio, barbeiro_id?, servico_id? }
 *  PATCH /api/interno/agendamentos/:id/cancelar           { whatsapp, motivo? }
 */
import { Router } from 'express';
import * as agenda from '../services/agenda.js';
import { rota, exigirToken } from '../lib/http.js';

export const rotasInternas = Router();
rotasInternas.use(exigirToken('INTERNAL_API_TOKEN'));

rotasInternas.get('/clientes/:whatsapp', rota((req) => agenda.obterCliente(req.params.whatsapp)));

rotasInternas.post('/agendamentos', rota((req, res) => {
  const { whatsapp, nome, barbeiro_id, servico_id, inicio } = req.body ?? {};
  const agendamento = agenda.criarAgendamento({
    whatsapp, nome, barbeiroId: barbeiro_id, servicoId: servico_id, inicio, origem: 'whatsapp',
  });
  res.status(201).json({ agendamento });
}));

rotasInternas.patch('/agendamentos/:id/remarcar', rota((req) => {
  const { whatsapp, inicio, barbeiro_id, servico_id } = req.body ?? {};
  return {
    agendamento: agenda.remarcarAgendamento({
      id: req.params.id, whatsapp, novoInicio: inicio, barbeiroId: barbeiro_id, servicoId: servico_id, origem: 'whatsapp',
    }),
  };
}));

rotasInternas.patch('/agendamentos/:id/cancelar', rota((req) => {
  const { whatsapp, motivo } = req.body ?? {};
  return { agendamento: agenda.cancelarAgendamento({ id: req.params.id, whatsapp, motivo, origem: 'whatsapp' }) };
}));
