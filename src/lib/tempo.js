/**
 * Utilitários de data/hora no fuso da barbearia (Campina Grande/PB → America/Fortaleza, UTC-3, sem horário de verão).
 * A agenda trabalha com strings locais 'YYYY-MM-DDTHH:MM' — independentes do fuso do servidor.
 */
const TZ = process.env.TZ_BARBEARIA || 'America/Fortaleza';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Agora no fuso da barbearia → 'YYYY-MM-DDTHH:MM' */
export function agoraLocal() {
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export const hojeLocal = () => agoraLocal().slice(0, 10);

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_DATAHORA = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/;

export function validarData(data) {
  if (!RE_DATA.test(data ?? '')) return false;
  const d = new Date(`${data}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === data;
}

/** Aceita 'YYYY-MM-DDTHH:MM', 'YYYY-MM-DD HH:MM' ou com segundos → 'YYYY-MM-DDTHH:MM' | null */
export function normalizarDataHora(valor) {
  const m = RE_DATAHORA.exec(String(valor ?? '').trim());
  if (!m || !validarData(m[1])) return null;
  const [h, min] = m[2].split(':').map(Number);
  if (h > 23 || min > 59) return null;
  return `${m[1]}T${m[2]}`;
}

/** Soma minutos a uma data-hora local sem depender do fuso do servidor. */
export function somarMinutos(dataHora, minutos) {
  const d = new Date(`${dataHora}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutos);
  return d.toISOString().slice(0, 16);
}

export function somarDias(data, dias) {
  const d = new Date(`${data}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export const diaDaSemana = (data) => new Date(`${data}T00:00:00Z`).getUTCDay();

export const hhmmParaMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const minParaHhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const nomeDiaSemana = (data) => DIAS[diaDaSemana(data)];

/** '2026-11-03T08:00' → 'terça-feira, 03/11 às 08:00' */
export function formatarDataHumana(dataHora) {
  const [data, hora] = dataHora.split('T');
  const [, mes, dia] = data.split('-');
  return `${nomeDiaSemana(data)}, ${dia}/${mes} às ${hora}`;
}
