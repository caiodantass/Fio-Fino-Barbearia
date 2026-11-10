import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(process.env.DB_PATH || './data/fiofino.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

/**
 * Conexão única (síncrona) com SQLite em modo WAL.
 * Por ser um único processo Node com driver síncrono, cada transação é atômica
 * e serializada — o que elimina condições de corrida entre Site e WhatsApp.
 * Para escalar horizontalmente, migrar para PostgreSQL (o schema é compatível
 * com ajustes mínimos) e usar SELECT ... FOR UPDATE / constraint EXCLUDE.
 */
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`);

db.exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf8'));

/** Executa `fn` dentro de uma transação de escrita exclusiva. */
export function transacao(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
}
