-- Migration 037 — Tabela dedicada para Rel. Estoque de Seriais "Com Saldo"
--
-- Problema: "Com Saldo" e "Todos" gravavam em rel_seriais_current; quando
-- "Todos" era importado depois do "Com Saldo", sobrescrevia deposito_atual
-- com TRIAGEM para todos os aparelhos, mascarando o depósito real.
--
-- Solução: "Com Saldo" passa a gravar em rel_seriais_saldo_current.
-- applyRelSeriaisToRepairCases prioriza essa tabela para deposito_atual.

CREATE TABLE rel_seriais_saldo_current (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  imei_norm                TEXT    NOT NULL UNIQUE,
  rel_seriais_saldo_import_id INTEGER REFERENCES rel_seriais_saldo_imports(id) ON DELETE SET NULL,
  serial                   TEXT,
  descricao                TEXT,
  codigo_comercial         TEXT,
  fabricante               TEXT,
  disponivel               TEXT,
  deposito_atual           TEXT,
  filial_atual             TEXT,
  row_hash                 TEXT,
  last_seen_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at               TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_rel_seriais_saldo_current_imei ON rel_seriais_saldo_current(imei_norm);
