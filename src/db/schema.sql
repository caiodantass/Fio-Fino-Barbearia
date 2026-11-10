-- ════════════════════════════════════════════════════════════════════════════
--  FIO FINO BARBEARIA — Esquema do banco de dados (SQLite / compatível com PG)
--
--  Convenções:
--   • Dinheiro SEMPRE em centavos (INTEGER) → sem erro de ponto flutuante.
--   • Datas/horas da agenda em horário local da barbearia (America/Fortaleza),
--     formato ISO sem fuso: 'YYYY-MM-DDTHH:MM'. Ordenação lexicográfica = cronológica.
--   • Timestamps de auditoria (criado_em/atualizado_em) em UTC.
--   • O WhatsApp normalizado (E.164 sem '+', ex: 5583999998888) é a chave do cliente.
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────── CLIENTES ───────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes (
  whatsapp       TEXT PRIMARY KEY
                 CHECK (whatsapp GLOB '55[0-9]*' AND length(whatsapp) BETWEEN 12 AND 13),
  nome           TEXT NOT NULL CHECK (length(trim(nome)) >= 2),
  origem         TEXT NOT NULL DEFAULT 'site' CHECK (origem IN ('site','whatsapp','admin')),
  observacoes    TEXT,
  criado_em      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  atualizado_em  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ─────────────────────────────── BARBEIROS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS barbeiros (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  nome                 TEXT NOT NULL,
  telefone             TEXT,
  foto_url             TEXT,
  bio                  TEXT,
  -- Preparado para o futuro módulo financeiro (repasse/comissão por profissional)
  comissao_percentual  REAL NOT NULL DEFAULT 0 CHECK (comissao_percentual BETWEEN 0 AND 100),
  ativo                INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  criado_em            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Expediente semanal de cada barbeiro (permite turnos: manhã/tarde)
CREATE TABLE IF NOT EXISTS expedientes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  barbeiro_id  INTEGER NOT NULL REFERENCES barbeiros(id) ON DELETE CASCADE,
  dia_semana   INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6), -- 0 = domingo
  inicio       TEXT NOT NULL CHECK (inicio GLOB '[0-2][0-9]:[0-5][0-9]'),
  fim          TEXT NOT NULL CHECK (fim    GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (fim > inicio),
  UNIQUE (barbeiro_id, dia_semana, inicio)
);

-- Folgas, feriados, almoços estendidos etc. barbeiro_id NULL = barbearia inteira.
CREATE TABLE IF NOT EXISTS bloqueios (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  barbeiro_id  INTEGER REFERENCES barbeiros(id) ON DELETE CASCADE,
  inicio       TEXT NOT NULL,  -- 'YYYY-MM-DDTHH:MM'
  fim          TEXT NOT NULL,
  motivo       TEXT,
  CHECK (fim > inicio)
);
CREATE INDEX IF NOT EXISTS ix_bloqueios_periodo ON bloqueios (inicio, fim);

-- ─────────────────────────────── SERVIÇOS ───────────────────────────────────
CREATE TABLE IF NOT EXISTS servicos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  nome            TEXT NOT NULL,
  descricao       TEXT,
  preco_centavos  INTEGER NOT NULL CHECK (preco_centavos >= 0),
  preco_a_partir  INTEGER NOT NULL DEFAULT 0 CHECK (preco_a_partir IN (0,1)), -- "a partir de"
  duracao_min     INTEGER NOT NULL CHECK (duracao_min > 0),
  ordem           INTEGER NOT NULL DEFAULT 0,
  ativo           INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  atualizado_em   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ────────────────────────────── AGENDAMENTOS ────────────────────────────────
CREATE TABLE IF NOT EXISTS agendamentos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_whatsapp  TEXT    NOT NULL REFERENCES clientes(whatsapp) ON UPDATE CASCADE,
  barbeiro_id       INTEGER NOT NULL REFERENCES barbeiros(id),
  servico_id        INTEGER NOT NULL REFERENCES servicos(id),

  inicio            TEXT NOT NULL CHECK (inicio GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
  fim               TEXT NOT NULL,
  data              TEXT GENERATED ALWAYS AS (substr(inicio, 1, 10)) STORED,

  -- SNAPSHOT do serviço no ato do agendamento: se o preço mudar amanhã,
  -- o histórico financeiro continua correto.
  servico_nome      TEXT    NOT NULL,
  valor_centavos    INTEGER NOT NULL CHECK (valor_centavos >= 0),
  duracao_min       INTEGER NOT NULL,

  status            TEXT NOT NULL DEFAULT 'confirmado'
                    CHECK (status IN ('confirmado','concluido','cancelado','nao_compareceu')),
  origem            TEXT NOT NULL CHECK (origem IN ('site','whatsapp','admin')),
  forma_pagamento   TEXT CHECK (forma_pagamento IN ('dinheiro','pix','debito','credito','outro')),
  observacoes       TEXT,

  criado_em         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  atualizado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (fim > inicio)
);

-- Consulta da agenda do dia por barbeiro (rota mais quente do sistema)
CREATE INDEX IF NOT EXISTS ix_ag_barbeiro_data ON agendamentos (barbeiro_id, data, status);
-- Contexto da IA: "próximos agendamentos deste número"
CREATE INDEX IF NOT EXISTS ix_ag_cliente_inicio ON agendamentos (cliente_whatsapp, inicio);
-- Relatórios
CREATE INDEX IF NOT EXISTS ix_ag_data_status ON agendamentos (data, status);
-- Trava física contra double-booking no mesmo horário de início
CREATE UNIQUE INDEX IF NOT EXISTS ux_ag_slot_ativo
  ON agendamentos (barbeiro_id, inicio) WHERE status IN ('confirmado','concluido');

-- Trilha de auditoria (quem criou/remarcou/cancelou e por qual canal)
CREATE TABLE IF NOT EXISTS agendamento_eventos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id  INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('criado','remarcado','cancelado','status')),
  origem          TEXT NOT NULL,
  dados_json      TEXT,
  criado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_ag_eventos_ag ON agendamento_eventos (agendamento_id);

-- ═════════════════ PREPARO PARA O MÓDULO FINANCEIRO (FUTURO) ═════════════════
-- Livro-caixa único: receitas (geradas automaticamente a partir dos atendimentos
-- concluídos) e despesas (lançadas pelo futuro site de gestão financeira).
CREATE TABLE IF NOT EXISTS categorias_financeiras (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  nome  TEXT NOT NULL,
  tipo  TEXT NOT NULL CHECK (tipo IN ('receita','despesa')),
  UNIQUE (nome, tipo)
);

CREATE TABLE IF NOT EXISTS lancamentos_financeiros (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo              TEXT    NOT NULL CHECK (tipo IN ('receita','despesa')),
  categoria_id      INTEGER REFERENCES categorias_financeiras(id),
  descricao         TEXT    NOT NULL,
  valor_centavos    INTEGER NOT NULL CHECK (valor_centavos >= 0),
  data_competencia  TEXT    NOT NULL,           -- 'YYYY-MM-DD'
  agendamento_id    INTEGER UNIQUE REFERENCES agendamentos(id) ON DELETE SET NULL,
  barbeiro_id       INTEGER REFERENCES barbeiros(id),
  forma_pagamento   TEXT,
  criado_em         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_lanc_competencia ON lancamentos_financeiros (data_competencia, tipo);

CREATE TABLE IF NOT EXISTS metas_mensais (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ano_mes     TEXT NOT NULL CHECK (ano_mes GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  indicador   TEXT NOT NULL CHECK (indicador IN ('faturamento','atendimentos','lucro_liquido')),
  valor_alvo  INTEGER NOT NULL,                  -- centavos ou quantidade
  barbeiro_id INTEGER REFERENCES barbeiros(id),  -- NULL = meta da barbearia
  UNIQUE (ano_mes, indicador, barbeiro_id)
);

-- Atendimento concluído ⇒ receita lançada automaticamente no livro-caixa.
CREATE TRIGGER IF NOT EXISTS trg_ag_concluido_gera_receita
AFTER UPDATE OF status ON agendamentos
WHEN NEW.status = 'concluido' AND OLD.status <> 'concluido'
BEGIN
  INSERT INTO lancamentos_financeiros
    (tipo, categoria_id, descricao, valor_centavos, data_competencia,
     agendamento_id, barbeiro_id, forma_pagamento)
  VALUES
    ('receita',
     (SELECT id FROM categorias_financeiras WHERE nome = 'Serviços' AND tipo = 'receita'),
     NEW.servico_nome, NEW.valor_centavos, NEW.data,
     NEW.id, NEW.barbeiro_id, NEW.forma_pagamento)
  ON CONFLICT (agendamento_id) DO UPDATE SET
     valor_centavos = excluded.valor_centavos,
     forma_pagamento = excluded.forma_pagamento;
END;

-- Atendimento "des-concluído" (correção do admin) ⇒ estorna a receita.
CREATE TRIGGER IF NOT EXISTS trg_ag_estorna_receita
AFTER UPDATE OF status ON agendamentos
WHEN OLD.status = 'concluido' AND NEW.status <> 'concluido'
BEGIN
  DELETE FROM lancamentos_financeiros WHERE agendamento_id = NEW.id;
END;

-- Visão diária pronta para o relatório atual e para o futuro dashboard financeiro
CREATE VIEW IF NOT EXISTS vw_resumo_diario AS
SELECT
  data,
  COUNT(DISTINCT CASE WHEN status = 'concluido' THEN cliente_whatsapp END)        AS clientes_atendidos,
  SUM(CASE WHEN status = 'concluido' THEN 1 ELSE 0 END)                          AS atendimentos_concluidos,
  COALESCE(SUM(CASE WHEN status = 'concluido' THEN valor_centavos END), 0)       AS faturamento_centavos,
  SUM(CASE WHEN status IN ('confirmado','concluido') THEN 1 ELSE 0 END)          AS agendamentos_previstos,
  COALESCE(SUM(CASE WHEN status IN ('confirmado','concluido') THEN valor_centavos END), 0) AS receita_prevista_centavos,
  SUM(CASE WHEN status = 'nao_compareceu' THEN 1 ELSE 0 END)                     AS faltas,
  SUM(CASE WHEN status = 'cancelado' THEN 1 ELSE 0 END)                          AS cancelamentos
FROM agendamentos
GROUP BY data;

-- ═══════════════════════════ SECRETÁRIA VIRTUAL (IA) ═════════════════════════
-- Memória curta de conversa por número
CREATE TABLE IF NOT EXISTS conversas_ia (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp   TEXT NOT NULL,
  papel      TEXT NOT NULL CHECK (papel IN ('user','assistant')),
  conteudo   TEXT NOT NULL,
  criado_em  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_conversas_whatsapp ON conversas_ia (whatsapp, id);

-- Idempotência: a Meta reenvia webhooks; cada mensagem é processada uma única vez.
CREATE TABLE IF NOT EXISTS mensagens_processadas (
  wa_message_id  TEXT PRIMARY KEY,
  recebida_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
