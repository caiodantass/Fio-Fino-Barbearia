/**
 * ════════════════════════════════════════════════════════════════════════════
 *  SECRETÁRIA VIRTUAL — LLM real + Tool Calling
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Fluxo de cada mensagem recebida:
 *   1. Identifica o cliente pelo número do remetente (GET /api/interno/clientes/:whatsapp).
 *   2. Monta o contexto: data de hoje, calendário dos próximos dias (para resolver
 *      "terça", "amanhã", "semana que vem"), dados do cliente e agendamentos futuros
 *      — sempre lidos AO VIVO, então um agendamento feito no site já aparece aqui.
 *   3. Envia ao LLM junto com as ferramentas. O LLM decide quais chamar
 *      (ex.: meus_agendamentos → consultar_horarios → remarcar_agendamento).
 *   4. Cada ferramenta é executada contra a API REST. A API aplica as regras e
 *      publica o evento SSE → o horário bloqueia no site na mesma hora.
 *   5. Repete até o LLM produzir a resposta final em texto.
 *
 *  Segurança: o WhatsApp do cliente NUNCA é parâmetro das ferramentas. Ele é
 *  injetado pelo servidor a partir do remetente, então nenhum prompt malicioso
 *  consegue alterar agendamentos de outra pessoa.
 *
 *  Provedores suportados (qualquer endpoint compatível com OpenAI Chat Completions):
 *   • OpenAI  → LLM_BASE_URL=https://api.openai.com/v1                              LLM_MODEL=gpt-4o-mini
 *   • Gemini  → LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai LLM_MODEL=gemini-2.0-flash
 *   • Groq, OpenRouter, Ollama local etc.
 *  Sem LLM_API_KEY, entra em modo degradado (ainda reconhece o cliente e indica o site).
 */
import { db } from '../db/index.js';
import { api } from './apiClient.js';
import { BARBEARIA } from '../config.js';
import { centavosParaReais } from '../lib/erros.js';
import { agoraLocal, hojeLocal, somarDias, nomeDiaSemana, formatarDataHumana } from '../lib/tempo.js';

const MAX_HISTORICO = 16;
const MAX_ITERACOES_FERRAMENTAS = 6;

// ───────────────────────────── Ferramentas (schema) ──────────────────────────
const ferramentas = [
  {
    name: 'listar_servicos',
    description: 'Lista os serviços da barbearia com id, preço e duração. Use antes de informar preços ou agendar.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'listar_barbeiros',
    description: 'Lista os profissionais (id, nome) e os dias da semana em que atendem (0=domingo).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'consultar_horarios',
    description: 'Retorna os horários LIVRES de um profissional em uma data para um serviço. Sempre consulte antes de propor, agendar ou remarcar.',
    parameters: {
      type: 'object',
      properties: {
        barbeiro_id: { type: 'integer' },
        servico_id: { type: 'integer' },
        data: { type: 'string', description: 'AAAA-MM-DD' },
      },
      required: ['barbeiro_id', 'servico_id', 'data'],
    },
  },
  {
    name: 'meus_agendamentos',
    description: 'Lista os agendamentos futuros confirmados do cliente que está conversando.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'criar_agendamento',
    description: 'Cria um agendamento para o cliente que está conversando.',
    parameters: {
      type: 'object',
      properties: {
        barbeiro_id: { type: 'integer' },
        servico_id: { type: 'integer' },
        inicio: { type: 'string', description: 'AAAA-MM-DDTHH:MM (horário local)' },
        nome: { type: 'string', description: 'Nome do cliente. Obrigatório apenas se ele ainda não tiver cadastro.' },
      },
      required: ['barbeiro_id', 'servico_id', 'inicio'],
    },
  },
  {
    name: 'remarcar_agendamento',
    description: 'Move um agendamento existente do cliente para outro horário (e opcionalmente outro profissional/serviço).',
    parameters: {
      type: 'object',
      properties: {
        agendamento_id: { type: 'integer' },
        novo_inicio: { type: 'string', description: 'AAAA-MM-DDTHH:MM' },
        barbeiro_id: { type: 'integer', description: 'Somente se o cliente quiser trocar de profissional.' },
        servico_id: { type: 'integer', description: 'Somente se o cliente quiser trocar de serviço.' },
      },
      required: ['agendamento_id', 'novo_inicio'],
    },
  },
  {
    name: 'cancelar_agendamento',
    description: 'Cancela um agendamento do cliente. Confirme com o cliente antes de cancelar.',
    parameters: {
      type: 'object',
      properties: { agendamento_id: { type: 'integer' }, motivo: { type: 'string' } },
      required: ['agendamento_id'],
    },
  },
];

// ───────────────────────────── Execução das ferramentas ──────────────────────
/** Cada ferramenta vira uma chamada à API REST. `ctx.whatsapp` vem do remetente, nunca do LLM. */
const executores = {
  listar_servicos: async () => {
    const r = await api.servicos();
    return r.servicos?.map((s) => ({
      id: s.id, nome: s.nome, duracao_min: s.duracao_min,
      preco: `${s.preco_a_partir ? 'a partir de ' : ''}${centavosParaReais(s.preco_centavos)}`,
    })) ?? r;
  },
  listar_barbeiros: async () => (await api.barbeiros()).barbeiros,
  consultar_horarios: async (args) => {
    const r = await api.horarios(args);
    if (!r.ok) return r;
    return {
      data: r.data, dia_semana: nomeDiaSemana(r.data), fechado: r.fechado, motivo: r.motivo,
      horarios_livres: r.horarios.filter((h) => h.disponivel).map((h) => h.hora),
    };
  },
  meus_agendamentos: async (_args, ctx) => {
    const r = await api.cliente(ctx.whatsapp);
    return r.proximos_agendamentos?.map(resumirAgendamento) ?? r;
  },
  criar_agendamento: async (args, ctx) =>
    api.criar({ ...args, whatsapp: ctx.whatsapp, nome: args.nome || ctx.nomeCadastro || ctx.nomePerfil }),
  remarcar_agendamento: async ({ agendamento_id, novo_inicio, barbeiro_id, servico_id }, ctx) =>
    api.remarcar(agendamento_id, { whatsapp: ctx.whatsapp, inicio: novo_inicio, barbeiro_id, servico_id }),
  cancelar_agendamento: async ({ agendamento_id, motivo }, ctx) =>
    api.cancelar(agendamento_id, { whatsapp: ctx.whatsapp, motivo }),
};

function resumirAgendamento(a) {
  return {
    id: a.id, quando: formatarDataHumana(a.inicio), inicio: a.inicio,
    servico: a.servico_nome, servico_id: a.servico_id, profissional: a.barbeiro_nome,
    barbeiro_id: a.barbeiro_id, valor: centavosParaReais(a.valor_centavos),
  };
}

// ───────────────────────────── Contexto / Prompt ─────────────────────────────
function calendarioProximosDias(qtd = 14) {
  const hoje = hojeLocal();
  return Array.from({ length: qtd }, (_, i) => {
    const d = somarDias(hoje, i);
    const rotulo = i === 0 ? ' (hoje)' : i === 1 ? ' (amanhã)' : '';
    return `- ${nomeDiaSemana(d)}${rotulo}: ${d}`;
  }).join('\n');
}

function montarPromptSistema({ cliente, agendamentos, nomePerfil }) {
  const identificacao = cliente
    ? `Cliente CADASTRADO: ${cliente.nome}. Chame-o pelo primeiro nome.`
    : `Cliente NOVO (sem cadastro). Nome no perfil do WhatsApp: "${nomePerfil ?? 'desconhecido'}". ` +
      'Antes de criar o primeiro agendamento, confirme como ele prefere ser chamado.';

  const agenda = agendamentos.length
    ? agendamentos.map((a) => `- #${a.id}: ${a.quando} | ${a.servico} com ${a.profissional} | ${a.valor}`).join('\n')
    : '- Nenhum agendamento futuro.';

  return `Você é a secretária virtual da ${BARBEARIA.nome}, em ${BARBEARIA.cidade}. Atende pelo WhatsApp.
Tom: cordial, direto, descontraído e profissional. Mensagens curtas (estilo WhatsApp), no máximo 1 emoji por mensagem. Português do Brasil.

AGORA: ${nomeDiaSemana(hojeLocal())}, ${agoraLocal().replace('T', ' ')} (fuso de Campina Grande).
Calendário de referência (use para converter "terça", "amanhã", "sexta que vem" em datas):
${calendarioProximosDias()}

${identificacao}
Agendamentos futuros deste cliente (dados ao vivo):
${agenda}

INFORMAÇÕES DA BARBEARIA
- Endereço: ${BARBEARIA.endereco}
- Funcionamento: ${BARBEARIA.horarioFuncionamento}
- Telefones: ${BARBEARIA.telefones.join(' / ')}
- Instagram: ${BARBEARIA.instagram}
- Site para agendar: ${BARBEARIA.site}
${BARBEARIA.politicas.map((p) => `- ${p}`).join('\n')}

REGRAS
1. Nunca invente preços, profissionais ou horários: use as ferramentas.
2. Antes de agendar ou remarcar, SEMPRE chame consultar_horarios para a data desejada.
3. Ao informar horários disponíveis de um dia:
   - Se o cliente pediu um turno específico (ex: "de manhã" ou "à tarde"), liste os horários desse turno.
   - Se o cliente perguntou genericamente (ex: "quais horários tem segunda?"), apresente as opções de forma clara e organizada (por exemplo: "Pela manhã temos: 08:00, 09:00, 10:00, 11:00 | À tarde: 14:00, 15:00, 16:00, 17:00, 18:00"). NUNCA omita turnos inteiros nem limite arbitrariamente a 3 opções quando o dia todo estiver livre.
4. Se o pedido for claro e o horário estiver livre (ex.: "quero segunda às 15h"), execute direto e confirme o resultado.
5. Se o cliente não tiver preferência de profissional, consulte os horários de todos e ofereça opções.
6. Para cancelar, peça confirmação explícita antes.
7. Após criar/remarcar, confirme: serviço, profissional, dia da semana, data, horário e valor.
8. Se uma ferramenta retornar erro (ex.: HORARIO_INDISPONIVEL), explique de forma simples e ofereça alternativas.
9. Assuntos fora da barbearia: responda com educação que só pode ajudar com a Fio Fino.
10. Se o cliente pedir para falar com uma pessoa, informe os telefones dos sócios.`;
}

// ───────────────────────────── Memória de conversa ───────────────────────────
function carregarHistorico(whatsapp) {
  return db.prepare(`
    SELECT papel AS role, conteudo AS content FROM (
      SELECT id, papel, conteudo FROM conversas_ia
      WHERE whatsapp = ? AND criado_em >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-12 hours')
      ORDER BY id DESC LIMIT ?
    ) ORDER BY id`).all(whatsapp, MAX_HISTORICO);
}

function salvarMensagem(whatsapp, papel, conteudo) {
  db.prepare('INSERT INTO conversas_ia (whatsapp, papel, conteudo) VALUES (?, ?, ?)').run(whatsapp, papel, conteudo);
}

// ───────────────────────────── LLM ───────────────────────────────────────────
async function chamarLLM(messages) {
  const base = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      temperature: 0.3,
      messages,
      tools: ferramentas.map((f) => ({ type: 'function', function: f })),
      tool_choice: 'auto',
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).choices[0].message;
}

// ───────────────────────────── Ponto de entrada ──────────────────────────────
/**
 * @param {{whatsapp:string, texto:string, nomePerfil?:string}} entrada  whatsapp já normalizado
 * @returns {Promise<string>} resposta a ser enviada ao cliente
 */
export async function responder({ whatsapp, texto, nomePerfil }) {
  // 1. Reconhecimento automático pelo número + contexto ao vivo
  const perfil = await api.cliente(whatsapp);
  const cliente = perfil.cliente ?? null;
  const agendamentos = (perfil.proximos_agendamentos ?? []).map(resumirAgendamento);

  if (!process.env.LLM_API_KEY) return respostaSemLLM({ cliente, agendamentos });

  const ctx = { whatsapp, nomePerfil, nomeCadastro: cliente?.nome };
  const messages = [
    { role: 'system', content: montarPromptSistema({ cliente, agendamentos, nomePerfil }) },
    ...carregarHistorico(whatsapp),
    { role: 'user', content: texto },
  ];
  salvarMensagem(whatsapp, 'user', texto);

  const fallback = `Tive um probleminha para concluir. Você pode agendar direto pelo site: ${BARBEARIA.site} ou ligar para ${BARBEARIA.telefones[0]}.`;

  try {
    // 2. Loop de tool calling
    for (let i = 0; i < MAX_ITERACOES_FERRAMENTAS; i++) {
      const msg = await chamarLLM(messages);
      if (!msg.tool_calls?.length) {
        const resposta = msg.content?.trim() || 'Desculpe, não entendi. Pode repetir?';
        salvarMensagem(whatsapp, 'assistant', resposta);
        return resposta;
      }

      messages.push(msg); // Preserva tool_calls e metadados do Google (thought_signature)
      for (const call of msg.tool_calls) {
        let resultado;
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          const executor = executores[call.function.name];
          resultado = executor ? await executor(args, ctx) : { erro: 'Ferramenta desconhecida' };
        } catch (e) {
          resultado = { erro: e.message };
        }
        console.log(`[ia] ${whatsapp} → ${call.function.name} ${call.function.arguments}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(resultado) });
      }
    }
  } catch (e) {
    console.error('[ia] falha no LLM:', e.message);
  }

  salvarMensagem(whatsapp, 'assistant', fallback);
  return fallback;
}

/** Modo degradado (sem chave de LLM configurada): ainda reconhece o cliente. */
function respostaSemLLM({ cliente, agendamentos }) {
  const saudacao = cliente ? `Olá, ${cliente.nome.split(' ')[0]}!` : 'Olá! Bem-vindo à Fio Fino Barbearia.';
  const prox = agendamentos[0]
    ? ` Seu próximo horário: ${agendamentos[0].quando} (${agendamentos[0].servico} com ${agendamentos[0].profissional}).`
    : '';
  return `${saudacao}${prox} Para agendar, acesse ${BARBEARIA.site} ou ligue ${BARBEARIA.telefones.join(' / ')}.`;
}
