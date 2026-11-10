/**
 * Normaliza números brasileiros para a chave única do cliente: 55 + DDD + 9 + 8 dígitos.
 *
 * Por que isso importa: a WhatsApp Cloud API às vezes entrega o `wa_id` SEM o nono
 * dígito (ex.: 558388887777). Se o cliente digitou (83) 98888-7777 no site, sem
 * normalização teríamos dois cadastros para a mesma pessoa e a IA não o reconheceria.
 *
 * @returns {string|null} ex.: '5583988887777'
 */
export function normalizarWhatsapp(entrada) {
  let d = String(entrada ?? '').replace(/\D/g, '');
  if (!d) return null;

  d = d.replace(/^0+/, '');                       // 083... → 83...
  if (d.length === 10 || d.length === 11) d = `55${d}`; // sem DDI

  if (!d.startsWith('55')) return null;           // escopo: números brasileiros

  // 55 + DDD + 8 dígitos de celular (6-9) → insere o nono dígito
  if (d.length === 12 && /[6-9]/.test(d[4])) d = `${d.slice(0, 4)}9${d.slice(4)}`;

  if (d.length !== 13 && d.length !== 12) return null;
  const ddd = Number(d.slice(2, 4));
  if (ddd < 11 || ddd > 99) return null;
  return d;
}

/** '5583988887777' → '(83) 98888-7777' */
export function formatarWhatsapp(n) {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(n ?? '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n;
}
