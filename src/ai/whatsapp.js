/**
 * Integração com a WhatsApp Cloud API (Meta).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const GRAPH = `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || 'v21.0'}`;

/** Valida o header X-Hub-Signature-256 usando o App Secret (evita webhooks forjados). */
export function assinaturaValida(rawBody, assinatura) {
  const segredo = process.env.WA_APP_SECRET;
  if (!segredo) return process.env.NODE_ENV !== 'production'; // em dev, permite sem segredo
  if (!assinatura || !rawBody) return false;
  const esperado = `sha256=${createHmac('sha256', segredo).update(rawBody).digest('hex')}`;
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Extrai mensagens de texto do payload do webhook.
 * @returns {{id:string, de:string, nomePerfil?:string, texto:string}[]}
 */
export function extrairMensagens(payload) {
  const saida = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const nomes = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages ?? []) {
        let texto = null;
        if (m.type === 'text') texto = m.text?.body;
        else if (m.type === 'button') texto = m.button?.text;
        else if (m.type === 'interactive') texto = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
        else texto = `[O cliente enviou uma mensagem do tipo "${m.type}" que não é texto]`;
        if (texto) saida.push({ id: m.id, de: m.from, nomePerfil: nomes[m.from], texto });
      }
    }
  }
  return saida;
}

export async function enviarTexto(para, texto) {
  if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
    console.log(`[whatsapp:simulado] → ${para}: ${texto}`);
    return;
  }
  const resp = await fetch(`${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: para,
      type: 'text',
      text: { preview_url: false, body: texto.slice(0, 4096) },
    }),
  });
  if (!resp.ok) console.error('[whatsapp] falha ao enviar:', resp.status, await resp.text());
}

/** Marca como lida (os dois "tracinhos azuis") — melhora a percepção de atendimento. */
export async function marcarComoLida(messageId) {
  if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) return;
  await fetch(`${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => {});
}
