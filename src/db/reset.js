/**
 * Reseta todos os dados de testes (agendamentos, clientes, conversas da IA e livro-caixa)
 * e repopula os serviços, barbeiros e expedientes padrão.
 * Uso: npm run reset
 */
import { db, transacao } from './index.js';

transacao(() => {
  db.exec(`
    DELETE FROM agendamento_eventos;
    DELETE FROM lancamentos_financeiros;
    DELETE FROM agendamentos;
    DELETE FROM conversas_ia;
    DELETE FROM mensagens_processadas;
    DELETE FROM bloqueios;
    DELETE FROM clientes;
  `);
});

console.log('🧹 Todos os agendamentos, clientes e lançamentos de teste foram apagados.');
await import('./seed.js');
