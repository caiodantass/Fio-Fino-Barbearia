/**
 * Hub de tempo real via Server-Sent Events (SSE).
 *
 * Qualquer mudança na agenda (vinda do Site, da IA no WhatsApp ou do Admin) chama
 * `publicar()`. Todos os navegadores conectados em /api/eventos recebem o aviso e
 * recarregam apenas os horários do barbeiro/dia afetado — o slot some da tela na hora.
 *
 * SSE foi escolhido em vez de WebSocket/Socket.io: unidirecional (servidor → navegador),
 * funciona sobre HTTP comum, reconecta sozinho e não exige dependências.
 * Em múltiplas instâncias, troque o Set local por Redis Pub/Sub ou PostgreSQL LISTEN/NOTIFY.
 */
const clientes = new Set();

export function conectarSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // desativa buffer no Nginx
  });
  res.write('retry: 3000\n\n');
  clientes.add(res);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clientes.delete(res);
  });
}

/**
 * @param {'agenda'} tipo
 * @param {{acao:string, barbeiro_id:number, data:string}} payload
 *   Nunca envie dados pessoais aqui: o canal é público.
 */
export function publicar(tipo, payload) {
  const msg = `event: ${tipo}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clientes) res.write(msg);
}

export const totalConectados = () => clientes.size;
