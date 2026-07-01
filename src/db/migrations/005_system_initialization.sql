-- Migration 005 — estado global de inicialização do sistema.
--
-- A importação Excel passa a ser uma INICIALIZAÇÃO ÚNICA: a primeira importação
-- confirmada carrega o estado atual da operação e marca o sistema como
-- inicializado. Depois disso, o sistema é a fonte operacional oficial — novas
-- importações são bloqueadas (salvo ALLOW_LEGACY_REIMPORT em dev/teste).
--
-- As tabelas source_* continuam existindo como FOTOGRAFIA IMUTÁVEL da carga
-- inicial (histórico/estoque/origem de solicitações), nunca mais como fonte
-- operacional mutável.

CREATE TABLE system_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1), -- linha única
  initialized              INTEGER NOT NULL DEFAULT 0,
  initial_import_batch_id  INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  initialized_at           TEXT,
  initialized_by           TEXT,
  operational_started_at   TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Estado global único, começando como NÃO inicializado.
INSERT INTO system_state (id, initialized) VALUES (1, 0);
