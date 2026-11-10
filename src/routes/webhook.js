/**
 * Webhook da WhatsApp Cloud API.
 *
 *  GET  /webhook/whatsapp   → verificação inicial (hub.challenge) feita pela Meta
 *  POST /webhook/whatsapp   → mensagens recebidas
 *  POST /webhook/simular    → (somente dev) testa a IA sem a Meta: { whatsapp, texto, nome? }
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { normalizarWhatsapp } from '../lib/telefone.js';
import { rota } from '../lib/http.js';
import { responder } from '../ai/secretaria.js';
import { assinaturaValida, extrairMensagens, enviarTexto, marcarComoLida } from '../ai/whatsapp.js';

export const rotasWebhook = Router();

rotasWebhook.get('/whatsapp', (req, res) => {
  const { 'hub.mode': modo, 'hub.verify_token': token, 'hub.challenge': desafio } = req.query;
  if (modo === 'subscribe' && token && token === process.env.WA_VERIFY_TOKEN) return res.status(200).send(desafio);
  res.sendStatus(403);
});

/**
 * Fila serial por número: se o cliente manda 3 mensagens seguidas
 * ("oi" / "quero cortar" / "amanhã cedo"), elas são processadas em ordem,
 * sem respostas cruzadas nem agendamentos duplicados.
 */
const filas = new Map();
function enfileirar(chave, tarefa) {
  const anterior = filas.get(chave) ?? Promise.resolve();
  const atual = anterior.then(tarefa).catch((e) => console.error('[webhook]', e));
  filas.set(chave, atual);
  atual.finally(() => filas.get(chave) === atual && filas.delete(chave));
  return atual;
}

const jaProcessada = (id) =>
  db.prepare('INSERT OR IGNORE INTO mensagens_processadas (wa_message_id) VALUES (?)').run(id).changes === 0;

rotasWebhook.post('/whatsapp', (req, res) => {
  if (!assinaturaValida(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);

  // A Meta exige 200 rápido; o processamento (LLM) segue em segundo plano.
  res.sendStatus(200);

  for (const msg of extrairMensagens(req.body)) {
    if (jaProcessada(msg.id)) continue; // reentrega da Meta
    const whatsapp = normalizarWhatsapp(msg.de);
    if (!whatsapp) continue;

    enfileirar(whatsapp, async () => {
      marcarComoLida(msg.id);
      const resposta = await responder({ whatsapp, texto: msg.texto, nomePerfil: msg.nomePerfil });
      // Responde para o wa_id original (formato exato que a Meta reconhece)
      await enviarTexto(msg.de, resposta);
    });
  }
});

if (process.env.NODE_ENV !== 'production') {
  rotasWebhook.post('/simular', rota(async (req) => {
    const whatsapp = normalizarWhatsapp(req.body?.whatsapp);
    if (!whatsapp) return { erro: 'whatsapp inválido' };
    const resposta = await enfileirar(whatsapp, () =>
      responder({ whatsapp, texto: String(req.body.texto ?? ''), nomePerfil: req.body.nome }));
    return { whatsapp, resposta };
  }));
}
