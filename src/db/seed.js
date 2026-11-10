/**
 * Popula o banco com dados iniciais. IDEMPOTENTE: pode rodar várias vezes sem duplicar.
 * Uso: npm run seed
 */
import { db, transacao } from './index.js';

const servicos = [
  // slug, nome, descrição, preço (centavos), "a partir de", duração (min)
  ['cabelo', 'Cabelo', 'Corte personalizado e acabamento refinado na navalha.', 3500, 0, 45],
  ['barba', 'Barba', 'Modelagem, toalha quente e barboterapia.', 2500, 0, 30],
  ['cabelo-barba', 'Cabelo e Barba', 'O combo clássico completo da casa.', 5500, 0, 60],
  ['cabelo-barba-esfoliacao', 'Cabelo, Barba e Esfoliação', 'Combo completo com esfoliação e cuidado facial.', 7000, 0, 60],
  ['pezinho', 'Pezinho', 'Alinhamento do contorno e acabamento.', 1000, 0, 20],
  ['barba-premium', 'Barba Premium', 'Barboterapia com óleos especiais, balm e toalha quente.', 4000, 0, 45],
  ['pigmentacao-barba', 'Pigmentação na Barba', 'Preenchimento e definição de falhas com pigmento.', 3000, 0, 30],
  ['tratamentos', 'Tratamentos', 'Hidratação profunda, selagem e cuidados capilares.', 5000, 1, 45],
];

// Barbeiros:
// Barbeiro 1: Henrique Diniz (ativo)
// Barbeiro 2: Em breve (ativo = 0 para não aceitar agendamento ainda, mas exibido elegantemente na interface)
const barbeiros = [
  ['Henrique Diniz', '5583996556879', 'Especialista em cortes modernos, fade refinado e visagismo.', 1],
  ['Barbeiro 2', '', 'Em breve · Nova cadeira de atendimento.', 0],
];

// Horários de atendimento de hora em hora:
// Manhã: 08:00 às 12:00 (slots 08:00, 09:00, 10:00, 11:00)
// Tarde: 14:00 às 19:00 (slots 14:00, 15:00, 16:00, 17:00, 18:00)
const turnos = [['08:00', '12:00'], ['14:00', '19:00']];
const diasUteis = [1, 2, 3, 4, 5, 6]; // seg–sáb (0 = domingo)

transacao(() => {
  const insServico = db.prepare(`
    INSERT INTO servicos (slug, nome, descricao, preco_centavos, preco_a_partir, duracao_min, ordem)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (slug) DO UPDATE SET
      nome = excluded.nome,
      descricao = excluded.descricao,
      preco_centavos = excluded.preco_centavos,
      preco_a_partir = excluded.preco_a_partir,
      duracao_min = excluded.duracao_min,
      ordem = excluded.ordem`);
  servicos.forEach((s, i) => insServico.run(...s, i + 1));

  // Atualiza ou insere barbeiros
  db.exec('DELETE FROM expedientes');
  db.exec('DELETE FROM barbeiros');

  const insBarbeiro = db.prepare('INSERT INTO barbeiros (nome, telefone, bio, ativo) VALUES (?, ?, ?, ?)');
  const insExp = db.prepare(
    'INSERT OR IGNORE INTO expedientes (barbeiro_id, dia_semana, inicio, fim) VALUES (?, ?, ?, ?)');

  for (const b of barbeiros) {
    const { lastInsertRowid } = insBarbeiro.run(b[0], b[1], b[2], b[3]);
    if (b[3] === 1) { // Só cadastra expediente se o barbeiro estiver ativo
      for (const dia of diasUteis) {
        for (const [ini, fim] of turnos) {
          insExp.run(lastInsertRowid, dia, ini, fim);
        }
      }
    }
  }

  // Categorias do livro-caixa
  const insCat = db.prepare('INSERT OR IGNORE INTO categorias_financeiras (nome, tipo) VALUES (?, ?)');
  [['Serviços', 'receita'], ['Produtos', 'receita'], ['Aluguel', 'despesa'], ['Insumos', 'despesa'],
   ['Energia/Água', 'despesa'], ['Comissões', 'despesa'], ['Marketing', 'despesa']]
    .forEach((c) => insCat.run(...c));
});

console.log('✔ Seed atualizado com Henrique Diniz e configuração refinada.');
