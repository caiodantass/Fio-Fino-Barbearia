import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './db/index.js';
import { rotasPublicas } from './routes/publicas.js';
import { rotasInternas } from './routes/internas.js';
import { rotasAdmin } from './routes/admin.js';
import { rotasWebhook } from './routes/webhook.js';
import { tratarErros } from './lib/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '../public');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // req.ip correto atrás de Nginx/Cloudflare (rate limit)

// Guarda o corpo bruto: necessário para validar a assinatura HMAC do webhook da Meta
app.use(express.json({
  limit: '200kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use('/api/interno', rotasInternas); // IA (token interno)
app.use('/api', rotasPublicas);         // Site
app.use('/admin', rotasAdmin);          // Relatórios (token admin)
app.use('/webhook', rotasWebhook);      // WhatsApp Cloud API

app.get('/painel', (_req, res) => res.sendFile(resolve(PUBLIC, 'painel.html')));
app.use(express.static(PUBLIC, { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

app.use('/api', (_req, res) => res.status(404).json({ erro: { codigo: 'NAO_ENCONTRADO', mensagem: 'Rota não encontrada.' } }));
app.use(tratarErros);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✂  Fio Fino rodando em http://localhost:${PORT}`);
  console.log(`   Painel admin:  http://localhost:${PORT}/painel`);
});
