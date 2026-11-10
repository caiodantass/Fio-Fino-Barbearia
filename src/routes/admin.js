/**
 * Módulo administrativo. Protegido por ADMIN_TOKEN (header Authorization: Bearer <token>
 * ou ?token=<token> para permitir download direto da planilha pelo navegador).
 *
 *  GET   /admin/relatorio-diario?data=AAAA-MM-DD[&formato=xls|csv]
 *  GET   /admin/agendamentos?data=AAAA-MM-DD
 *  PATCH /admin/agendamentos/:id/status     { status, forma_pagamento? }
 */
import { Router } from 'express';
import * as agenda from '../services/agenda.js';
import { rota, exigirToken } from '../lib/http.js';
import { hojeLocal, nomeDiaSemana } from '../lib/tempo.js';
import { formatarWhatsapp } from '../lib/telefone.js';

export const rotasAdmin = Router();
rotasAdmin.use(exigirToken('ADMIN_TOKEN'));

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const moeda = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const STATUS_LABEL = {
  confirmado: 'Confirmado',
  concluido: 'Concluído',
  nao_compareceu: 'Faltou',
  cancelado: 'Cancelado',
};

const PAGAMENTO_LABEL = {
  pix: 'Pix',
  dinheiro: 'Dinheiro',
  debito: 'Cartão de Débito',
  credito: 'Cartão de Crédito',
  outro: 'Outro',
  nao_informado: 'Não informado',
};

const ORIGEM_LABEL = {
  site: 'Site',
  whatsapp: 'WhatsApp (IA)',
  admin: 'Painel Admin',
};

function formatarDataBr(dataIso) {
  const [ano, mes, dia] = String(dataIso).split('-');
  const diaSem = nomeDiaSemana(dataIso);
  const diaSemCap = diaSem.charAt(0).toUpperCase() + diaSem.slice(1);
  return `${dia}/${mes}/${ano} (${diaSemCap})`;
}

function capitalizarNome(nome) {
  return String(nome ?? '')
    .trim()
    .split(/\s+/)
    .map((p) => (p.length > 2 ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p.toLowerCase()))
    .join(' ');
}

function gerarPlanilhaExcelHtml(data, r, itens) {
  const dataBr = formatarDataBr(data);
  const ticketMedio = r.atendimentos_concluidos > 0
    ? Math.round(r.faturamento_centavos / r.atendimentos_concluidos)
    : 0;

  const linhasBarbeiros = r.por_barbeiro.map((b) => {
    const isAtivo = b.barbeiro_ativo !== 0;
    return `
      <tr>
        <td class="celula-texto" colspan="3"><strong>${esc(b.barbeiro_nome)}</strong> ${isAtivo ? '' : '<span style="color:#777777;">(Em breve)</span>'}</td>
        <td class="celula-centro" colspan="2">${isAtivo ? b.atendimentos : '—'}</td>
        <td class="celula-moeda" colspan="4">${isAtivo ? moeda(b.faturamento_centavos) : 'Em breve'}</td>
      </tr>`;
  }).join('');

  const linhasPagamentos = (r.por_forma_pagamento || []).length
    ? r.por_forma_pagamento.map((p) => `
      <tr>
        <td class="celula-texto" colspan="5">${esc(PAGAMENTO_LABEL[p.forma_pagamento] ?? p.forma_pagamento)}</td>
        <td class="celula-moeda" colspan="4">${moeda(p.faturamento_centavos)}</td>
      </tr>`).join('')
    : `<tr><td class="celula-vazia" colspan="9">Nenhum pagamento concluído registrado nesta data.</td></tr>`;

  const linhasAgenda = itens.length
    ? itens.map((a, idx) => {
      const classeStatus = `status-${a.status}`;
      const statusTexto = STATUS_LABEL[a.status] ?? a.status;
      const pagTexto = a.forma_pagamento ? (PAGAMENTO_LABEL[a.forma_pagamento] ?? a.forma_pagamento) : '—';
      const origemTexto = ORIGEM_LABEL[a.origem] ?? a.origem;
      const valorFormatado = moeda(a.valor_centavos);
      const entraNoCaixa = a.status === 'concluido';

      return `
        <tr class="${idx % 2 === 1 ? 'linha-par' : ''}">
          <td class="celula-centro">${idx + 1}</td>
          <td class="celula-centro"><strong>${esc(a.inicio.slice(11))}</strong> às ${esc(a.fim.slice(11))}</td>
          <td class="celula-texto"><strong>${esc(capitalizarNome(a.cliente_nome))}</strong></td>
          <td class="celula-centro" style="mso-number-format:'\\@';">${esc(formatarWhatsapp(a.cliente_whatsapp))}</td>
          <td class="celula-texto">${esc(a.barbeiro_nome)}</td>
          <td class="celula-texto">${esc(a.servico_nome)}</td>
          <td class="celula-moeda ${entraNoCaixa ? 'valor-pago' : 'valor-nao-pago'}">${valorFormatado}</td>
          <td class="celula-centro ${classeStatus}"><strong>${esc(statusTexto)}</strong></td>
          <td class="celula-centro">${esc(pagTexto)} <span style="color:#666666;">(${esc(origemTexto)})</span></td>
        </tr>`;
    }).join('')
    : `<tr><td class="celula-vazia" colspan="9">Nenhum agendamento registrado para este dia.</td></tr>`;

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40" lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <!--[if gte mso 9]>
  <xml>
    <x:ExcelWorkbook>
      <x:ExcelWorksheets>
        <x:ExcelWorksheet>
          <x:Name>Relatorio ${data}</x:Name>
          <x:WorksheetOptions>
            <x:DisplayGridlines/>
          </x:WorksheetOptions>
        </x:ExcelWorksheet>
      </x:ExcelWorksheets>
    </x:ExcelWorkbook>
  </xml>
  <![endif]-->
  <style>
    body, table {
      font-family: 'Segoe UI', Calibri, Arial, sans-serif;
      font-size: 11pt;
      color: #1c1c1f;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    td, th {
      border: 1px solid #d4d4d8;
      padding: 8px 12px;
      vertical-align: middle;
    }
    .titulo-principal {
      background-color: #0b0b0e;
      color: #f4f4f6;
      font-size: 16pt;
      font-weight: bold;
      text-align: center;
      height: 44px;
      border: 1px solid #0b0b0e;
    }
    .subtitulo-data {
      background-color: #1c1c22;
      color: #d4d4d8;
      font-size: 11pt;
      text-align: center;
      height: 28px;
      border: 1px solid #1c1c22;
    }
    .secao-header {
      background-color: #27272f;
      color: #ffffff;
      font-size: 11pt;
      font-weight: bold;
      text-align: left;
      height: 32px;
    }
    .col-header {
      background-color: #e4e4e7;
      color: #18181b;
      font-weight: bold;
      text-align: center;
      height: 30px;
      border: 1px solid #a1a1aa;
    }
    .kpi-label {
      background-color: #f4f4f5;
      color: #52525b;
      font-weight: bold;
      font-size: 10pt;
      text-align: center;
    }
    .kpi-label-verde {
      background-color: #f0fdf4;
      color: #166534;
      font-weight: bold;
      font-size: 10pt;
      text-align: center;
    }
    .kpi-label-azul {
      background-color: #f0f9ff;
      color: #075985;
      font-weight: bold;
      font-size: 10pt;
      text-align: center;
    }
    .kpi-label-amarelo {
      background-color: #fffbeb;
      color: #92400e;
      font-weight: bold;
      font-size: 10pt;
      text-align: center;
    }
    .kpi-label-vermelho {
      background-color: #fef2f2;
      color: #991b1b;
      font-weight: bold;
      font-size: 10pt;
      text-align: center;
    }
    .kpi-valor {
      background-color: #ffffff;
      color: #09090b;
      font-size: 14pt;
      font-weight: bold;
      text-align: center;
      height: 36px;
    }
    .kpi-destaque {
      background-color: #dcfce7;
      color: #14532d;
      font-size: 15pt;
      font-weight: bold;
      text-align: center;
      height: 36px;
      border: 2px solid #86efac;
    }
    .kpi-valor-azul {
      background-color: #e0f2fe;
      color: #0369a1;
      font-size: 14pt;
      font-weight: bold;
      text-align: center;
      height: 36px;
    }
    .kpi-valor-amarelo {
      background-color: #fef3c7;
      color: #b45309;
      font-size: 14pt;
      font-weight: bold;
      text-align: center;
      height: 36px;
    }
    .kpi-valor-vermelho {
      background-color: #fee2e2;
      color: #dc2626;
      font-size: 14pt;
      font-weight: bold;
      text-align: center;
      height: 36px;
    }
    .celula-texto { text-align: left; }
    .celula-centro { text-align: center; }
    .celula-moeda {
      text-align: right;
      font-weight: bold;
    }
    .celula-vazia {
      text-align: center;
      color: #71717a;
      font-style: italic;
      padding: 16px;
    }
    .linha-par td {
      background-color: #fafafa;
    }
    .status-concluido {
      background-color: #dcfce7 !important;
      color: #15803d !important;
      font-weight: bold;
    }
    .status-confirmado {
      background-color: #e0f2fe !important;
      color: #0284c7 !important;
      font-weight: bold;
    }
    .status-nao_compareceu {
      background-color: #fee2e2 !important;
      color: #dc2626 !important;
      font-weight: bold;
    }
    .status-cancelado {
      background-color: #f3f4f6 !important;
      color: #6b7280 !important;
      font-weight: bold;
    }
    .valor-pago { color: #166534; font-weight: bold; }
    .valor-nao-pago { color: #9ca3af; text-decoration: line-through; }
    .rodape-total {
      background-color: #18181b;
      color: #ffffff;
      font-weight: bold;
      font-size: 12pt;
      height: 34px;
    }
    .espacador td {
      border: none;
      height: 14px;
      background: transparent;
    }
  </style>
</head>
<body>
  <table>
    <!-- Larguras ideais para cada uma das 9 colunas no Excel -->
    <colgroup>
      <col width="50" />
      <col width="135" />
      <col width="210" />
      <col width="160" />
      <col width="175" />
      <col width="230" />
      <col width="130" />
      <col width="135" />
      <col width="220" />
    </colgroup>

    <!-- TÍTULO DO RELATÓRIO -->
    <tr>
      <td class="titulo-principal" colspan="9">✂ FIO FINO BARBEARIA — RELATÓRIO DIÁRIO DE MOVIMENTO</td>
    </tr>
    <tr>
      <td class="subtitulo-data" colspan="9">Data de Referência: <strong>${esc(dataBr)}</strong> · Campina Grande/PB</td>
    </tr>

    <tr class="espacador"><td colspan="9"></td></tr>

    <!-- BLOCO 1: INDICADORES GERAIS DO DIA -->
    <tr>
      <td class="secao-header" colspan="9">1. RESUMO GERAL DO DIA</td>
    </tr>
    <tr>
      <td class="kpi-label-verde" colspan="2">Clientes Atendidos</td>
      <td class="kpi-label-verde" colspan="2">Faturamento Realizado</td>
      <td class="kpi-label" colspan="2">Ticket Médio</td>
      <td class="kpi-label-azul" colspan="1">Previstos</td>
      <td class="kpi-label-vermelho" colspan="1">Faltas</td>
      <td class="kpi-label-amarelo" colspan="1">Cancelamentos</td>
    </tr>
    <tr>
      <td class="kpi-valor" colspan="2" style="color:#15803d; font-size:16pt;">${r.clientes_atendidos}</td>
      <td class="kpi-destaque" colspan="2">${moeda(r.faturamento_centavos)}</td>
      <td class="kpi-valor" colspan="2">${moeda(ticketMedio)}</td>
      <td class="kpi-valor-azul" colspan="1">${r.agendamentos_previstos}</td>
      <td class="kpi-valor-vermelho" colspan="1">${r.faltas}</td>
      <td class="kpi-valor-amarelo" colspan="1">${r.cancelamentos}</td>
    </tr>

    <tr class="espacador"><td colspan="9"></td></tr>

    <!-- BLOCO 2: DESEMPENHO POR PROFISSIONAL -->
    <tr>
      <td class="secao-header" colspan="9">2. PRODUÇÃO POR PROFISSIONAL (ATENDIMENTOS CONCLUÍDOS)</td>
    </tr>
    <tr>
      <td class="col-header" colspan="3">Profissional</td>
      <td class="col-header" colspan="2">Qtd. Cortes Concluídos</td>
      <td class="col-header" colspan="4">Faturamento Gerado (R$)</td>
    </tr>
    ${linhasBarbeiros}

    <tr class="espacador"><td colspan="9"></td></tr>

    <!-- BLOCO 3: RECEITA POR FORMA DE PAGAMENTO -->
    <tr>
      <td class="secao-header" colspan="9">3. RECEITA POR FORMA DE PAGAMENTO</td>
    </tr>
    <tr>
      <td class="col-header" colspan="5">Forma de Pagamento</td>
      <td class="col-header" colspan="4">Total Recebido (R$)</td>
    </tr>
    ${linhasPagamentos}

    <tr class="espacador"><td colspan="9"></td></tr>

    <!-- BLOCO 4: LISTAGEM DETALHADA DOS AGENDAMENTOS -->
    <tr>
      <td class="secao-header" colspan="9">4. DETALHAMENTO COMPLETO DA AGENDA DO DIA (${itens.length} registro(s))</td>
    </tr>
    <tr>
      <td class="col-header">Nº</td>
      <td class="col-header">Horário</td>
      <td class="col-header">Cliente</td>
      <td class="col-header">WhatsApp</td>
      <td class="col-header">Profissional</td>
      <td class="col-header">Serviço</td>
      <td class="col-header">Valor (R$)</td>
      <td class="col-header">Status</td>
      <td class="col-header">Pagamento & Canal</td>
    </tr>
    ${linhasAgenda}
    <tr>
      <td class="rodape-total" colspan="6" style="text-align:right;">TOTAL FATURADO NO CAIXA (CONCLUÍDOS):</td>
      <td class="rodape-total" style="text-align:right;">${moeda(r.faturamento_centavos)}</td>
      <td class="rodape-total" colspan="2" style="text-align:center;">${r.atendimentos_concluidos} concluído(s)</td>
    </tr>
  </table>
</body>
</html>`;
}

function gerarPlanilhaExcelMensalHtml(anoMes, r) {
  const [ano, mes] = anoMes.split('-');
  const mesesNomes = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const mesExtenso = `${mesesNomes[Number(mes) - 1]} de ${ano}`;
  const ticketMedio = r.atendimentos_concluidos > 0
    ? Math.round(r.faturamento_centavos / r.atendimentos_concluidos)
    : 0;

  const linhasBarbeiros = r.por_barbeiro.map((b) => {
    const isAtivo = b.barbeiro_ativo !== 0;
    return `
      <tr>
        <td class="celula-texto" colspan="3"><strong>${esc(b.barbeiro_nome)}</strong> ${isAtivo ? '' : '<span style="color:#777777;">(Em breve)</span>'}</td>
        <td class="celula-centro" colspan="2">${isAtivo ? b.atendimentos : '—'}</td>
        <td class="celula-moeda" colspan="4">${isAtivo ? moeda(b.faturamento_centavos) : 'Em breve'}</td>
      </tr>`;
  }).join('');

  const linhasPagamentos = (r.por_forma_pagamento || []).length
    ? r.por_forma_pagamento.map((p) => `
      <tr>
        <td class="celula-texto" colspan="5">${esc(PAGAMENTO_LABEL[p.forma_pagamento] ?? p.forma_pagamento)}</td>
        <td class="celula-moeda" colspan="4">${moeda(p.faturamento_centavos)}</td>
      </tr>`).join('')
    : `<tr><td class="celula-vazia" colspan="9">Nenhum pagamento registrado neste mês.</td></tr>`;

  const linhasDias = (r.por_dia || []).length
    ? r.por_dia.map((d, idx) => {
        const [a, m, dia] = d.data.split('-');
        const diaSem = nomeDiaSemana(d.data);
        return `
          <tr class="${idx % 2 === 1 ? 'linha-par' : ''}">
            <td class="celula-centro">${idx + 1}</td>
            <td class="celula-centro"><strong>${dia}/${m}</strong> (${diaSem})</td>
            <td class="celula-centro" colspan="2"><strong>${d.concluidos}</strong> atendimentos</td>
            <td class="celula-centro" style="color:${d.faltas > 0 ? '#dc2626' : '#52525b'}; font-weight:${d.faltas > 0 ? 'bold' : 'normal'};">${d.faltas} falta(s)</td>
            <td class="celula-moeda valor-pago" colspan="4">${moeda(d.faturamento_centavos)}</td>
          </tr>`;
      }).join('')
    : `<tr><td class="celula-vazia" colspan="9">Nenhum atendimento realizado neste mês.</td></tr>`;

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40" lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <!--[if gte mso 9]>
  <xml>
    <x:ExcelWorkbook>
      <x:ExcelWorksheets>
        <x:ExcelWorksheet>
          <x:Name>Mensal ${anoMes}</x:Name>
          <x:WorksheetOptions>
            <x:DisplayGridlines/>
          </x:WorksheetOptions>
        </x:ExcelWorksheet>
      </x:ExcelWorksheets>
    </x:ExcelWorkbook>
  </xml>
  <![endif]-->
  <style>
    body, table { font-family: 'Segoe UI', Calibri, Arial, sans-serif; font-size: 11pt; color: #1c1c1f; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #d4d4d8; padding: 8px 12px; vertical-align: middle; }
    .titulo-principal { background-color: #0b0b0e; color: #f4f4f6; font-size: 16pt; font-weight: bold; text-align: center; height: 44px; border: 1px solid #0b0b0e; }
    .subtitulo-data { background-color: #1c1c22; color: #d4d4d8; font-size: 11pt; text-align: center; height: 28px; border: 1px solid #1c1c22; }
    .secao-header { background-color: #27272f; color: #ffffff; font-size: 11pt; font-weight: bold; text-align: left; height: 32px; }
    .col-header { background-color: #e4e4e7; color: #18181b; font-weight: bold; text-align: center; height: 30px; border: 1px solid #a1a1aa; }
    .kpi-label-verde { background-color: #f0fdf4; color: #166534; font-weight: bold; font-size: 10pt; text-align: center; }
    .kpi-label-azul { background-color: #f0f9ff; color: #075985; font-weight: bold; font-size: 10pt; text-align: center; }
    .kpi-label-amarelo { background-color: #fffbeb; color: #92400e; font-weight: bold; font-size: 10pt; text-align: center; }
    .kpi-label-vermelho { background-color: #fef2f2; color: #991b1b; font-weight: bold; font-size: 10pt; text-align: center; }
    .kpi-label { background-color: #f4f4f5; color: #52525b; font-weight: bold; font-size: 10pt; text-align: center; }
    .kpi-valor { background-color: #ffffff; color: #09090b; font-size: 14pt; font-weight: bold; text-align: center; height: 36px; }
    .kpi-destaque { background-color: #dcfce7; color: #14532d; font-size: 16pt; font-weight: bold; text-align: center; height: 36px; border: 2px solid #86efac; }
    .kpi-valor-azul { background-color: #e0f2fe; color: #0369a1; font-size: 14pt; font-weight: bold; text-align: center; height: 36px; }
    .kpi-valor-amarelo { background-color: #fef3c7; color: #b45309; font-size: 14pt; font-weight: bold; text-align: center; height: 36px; }
    .kpi-valor-vermelho { background-color: #fee2e2; color: #dc2626; font-size: 14pt; font-weight: bold; text-align: center; height: 36px; }
    .celula-texto { text-align: left; }
    .celula-centro { text-align: center; }
    .celula-moeda { text-align: right; font-weight: bold; }
    .celula-vazia { text-align: center; color: #71717a; font-style: italic; padding: 16px; }
    .linha-par td { background-color: #fafafa; }
    .valor-pago { color: #166534; font-weight: bold; }
    .rodape-total { background-color: #18181b; color: #ffffff; font-weight: bold; font-size: 12pt; height: 34px; }
    .espacador td { border: none; height: 14px; background: transparent; }
  </style>
</head>
<body>
  <table>
    /* Larguras e alturas calibradas para nunca cortar títulos no Excel */
    <colgroup>
      <col width="60" />
      <col width="170" />
      <col width="190" />
      <col width="150" />
      <col width="190" />
      <col width="180" />
      <col width="150" />
      <col width="150" />
      <col width="200" />
    </colgroup>
    <tr><td class="titulo-principal" colspan="9">✂ FIO FINO BARBEARIA — RELATÓRIO MENSAL DE FECHAMENTO</td></tr>
    <tr><td class="subtitulo-data" colspan="9">Mês de Referência: <strong>${esc(mesExtenso)}</strong> · Campina Grande/PB</td></tr>
    <tr class="espacador"><td colspan="9"></td></tr>

    <tr><td class="secao-header" colspan="9">1. RESUMO GERAL DO MÊS</td></tr>
    <tr>
      <td class="kpi-label-verde" colspan="2">Clientes Atendidos no Mês</td>
      <td class="kpi-label-verde" colspan="2">Faturamento Total do Mês</td>
      <td class="kpi-label" colspan="2">Ticket Médio Mensal</td>
      <td class="kpi-label-azul" colspan="1">Agendados Futuros</td>
      <td class="kpi-label-vermelho" colspan="1">Total Faltas</td>
      <td class="kpi-label-amarelo" colspan="1">Total Cancelados</td>
    </tr>
    <tr>
      <td class="kpi-valor" colspan="2" style="color:#15803d; font-size:16pt;">${r.clientes_atendidos}</td>
      <td class="kpi-destaque" colspan="2">${moeda(r.faturamento_centavos)}</td>
      <td class="kpi-valor" colspan="2">${moeda(ticketMedio)}</td>
      <td class="kpi-valor-azul" colspan="1">${r.agendamentos_previstos}</td>
      <td class="kpi-valor-vermelho" colspan="1">${r.faltas}</td>
      <td class="kpi-valor-amarelo" colspan="1">${r.cancelamentos}</td>
    </tr>
    <tr class="espacador"><td colspan="9"></td></tr>

    <tr><td class="secao-header" colspan="9">2. PRODUÇÃO POR PROFISSIONAL NO MÊS</td></tr>
    <tr>
      <td class="col-header" colspan="3">Profissional</td>
      <td class="col-header" colspan="2">Atendimentos Concluídos</td>
      <td class="col-header" colspan="4">Total Faturado no Mês</td>
    </tr>
    ${linhasBarbeiros}
    <tr class="espacador"><td colspan="9"></td></tr>

    <tr><td class="secao-header" colspan="9">3. RECEITA MENSAL POR FORMA DE PAGAMENTO</td></tr>
    <tr>
      <td class="col-header" colspan="5">Forma de Pagamento</td>
      <td class="col-header" colspan="4">Total Recebido no Mês (R$)</td>
    </tr>
    ${linhasPagamentos}
    <tr class="espacador"><td colspan="9"></td></tr>

    <tr><td class="secao-header" colspan="9">4. EVOLUÇÃO DIÁRIA DO MOVIMENTO NO MÊS</td></tr>
    <tr style="height: 38px;">
      <td class="col-header">Nº</td>
      <td class="col-header">Data</td>
      <td class="col-header" colspan="2">Cortes Concluídos</td>
      <td class="col-header" style="white-space: normal; line-height: 1.2;">Faltas Registradas</td>
      <td class="col-header" colspan="4">Faturamento do Dia (R$)</td>
    </tr>
    ${linhasDias}
    <tr>
      <td class="rodape-total" colspan="5" style="text-align:right;">TOTAL FATURADO NO MÊS:</td>
      <td class="rodape-total" colspan="4" style="text-align:right; color:#86efac;">${moeda(r.faturamento_centavos)}</td>
    </tr>
  </table>
</body>
</html>`;
}

rotasAdmin.get('/relatorio-mensal', rota((req, res) => {
  const mesParam = req.query.mes || hojeLocal().slice(0, 7);
  const r = agenda.relatorioMensal(mesParam);
  const formato = req.query.formato;

  if (!formato) {
    return {
      mes: r.mes,
      clientes_atendidos: r.clientes_atendidos,
      faturamento_total_centavos: r.faturamento_centavos,
      faturamento_total: moeda(r.faturamento_centavos),
      detalhes: r,
    };
  }

  const htmlPlanilha = gerarPlanilhaExcelMensalHtml(mesParam, r);
  res.set('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="Relatorio-Mensal-FioFino-${mesParam}.xls"`);
  res.send(`\uFEFF${htmlPlanilha}`);
}));

rotasAdmin.get('/relatorio-diario', rota((req, res) => {
  const data = req.query.data || hojeLocal();
  const r = agenda.relatorioDiario(data);
  const formato = req.query.formato;

  if (!formato) {
    return {
      data: r.data,
      clientes_atendidos: r.clientes_atendidos,
      faturamento_total_centavos: r.faturamento_centavos,
      faturamento_total: moeda(r.faturamento_centavos),
      detalhes: {
        atendimentos_concluidos: r.atendimentos_concluidos,
        agendamentos_previstos: r.agendamentos_previstos,
        receita_prevista_centavos: r.receita_prevista_centavos,
        faltas: r.faltas,
        cancelamentos: r.cancelamentos,
        por_barbeiro: r.por_barbeiro,
        por_servico: r.por_servico,
        por_forma_pagamento: r.por_forma_pagamento,
      },
    };
  }

  // Exportação em Planilha Excel Estilizada (.xls) — abre direto no Excel com colunas largas, cores e bordas
  const itens = agenda.agendaDoDia(data);
  const htmlPlanilha = gerarPlanilhaExcelHtml(data, r, itens);

  res.set('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="Relatorio-FioFino-${data}.xls"`);
  res.send(`\uFEFF${htmlPlanilha}`);
}));

rotasAdmin.get('/agendamentos', rota((req) => ({ agendamentos: agenda.agendaDoDia(req.query.data || hojeLocal()) })));

rotasAdmin.patch('/agendamentos/:id/status', rota((req) => {
  const { status, forma_pagamento } = req.body ?? {};
  return { agendamento: agenda.atualizarStatus({ id: req.params.id, status, formaPagamento: forma_pagamento }) };
}));
