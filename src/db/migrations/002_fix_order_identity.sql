-- Migration 002 — corrige a identidade do domínio.
--
-- ID_PEDIDO é a identidade ESTÁVEL de uma solicitação de peça (única por linha).
-- O aparelho/kit é identificado pelo IMEI; várias linhas com o mesmo IMEI são
-- várias peças do mesmo aparelho (NÃO é duplicidade).
--
-- Antes: UNIQUE(import_batch_id, id_pedido, chave_peca_norm).
-- Agora: UNIQUE(import_batch_id, id_pedido).
--
-- source_order_parts é um snapshot reimportável. Recriamos a tabela com a nova
-- restrição preservando as linhas válidas (INSERT OR IGNORE descarta eventuais
-- id_pedido repetidos do modelo antigo; o runner faz backup antes de migrar).

ALTER TABLE source_order_parts RENAME TO source_order_parts_old;

CREATE TABLE source_order_parts (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id             INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  id_pedido                   TEXT    NOT NULL,
  imei                        TEXT,
  os                          TEXT,
  concat_peca                 TEXT,
  chave_peca                  TEXT,
  chave_peca_norm             TEXT,
  referencia                  TEXT,
  status_atual_legado         TEXT,
  status_atual_label          TEXT,
  status_kit_legado           TEXT,
  prioridade_kit_legado       INTEGER,
  quantidade_pecas_aparelho   INTEGER,
  idade                       INTEGER,
  custo                       REAL,
  venda                       REAL,
  margem_legada               REAL,
  nota_idade_legada           INTEGER,
  nota_margem_legada          INTEGER,
  score_legado                INTEGER,
  ordem_consumo_legada        INTEGER,
  quantidade_estoque_legada   INTEGER,
  pecas_sem_estoque_legada    INTEGER,
  raw_json                    TEXT    NOT NULL,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (import_batch_id, id_pedido)
);

INSERT OR IGNORE INTO source_order_parts (
  id, import_batch_id, id_pedido, imei, os, concat_peca, chave_peca, chave_peca_norm, referencia,
  status_atual_legado, status_atual_label, status_kit_legado, prioridade_kit_legado,
  quantidade_pecas_aparelho, idade, custo, venda, margem_legada,
  nota_idade_legada, nota_margem_legada, score_legado, ordem_consumo_legada,
  quantidade_estoque_legada, pecas_sem_estoque_legada, raw_json, created_at
)
SELECT
  id, import_batch_id, id_pedido, imei, os, concat_peca, chave_peca, chave_peca_norm, referencia,
  status_atual_legado, status_atual_label, status_kit_legado, prioridade_kit_legado,
  quantidade_pecas_aparelho, idade, custo, venda, margem_legada,
  nota_idade_legada, nota_margem_legada, score_legado, ordem_consumo_legada,
  quantidade_estoque_legada, pecas_sem_estoque_legada, raw_json, created_at
FROM source_order_parts_old;

DROP TABLE source_order_parts_old;

CREATE INDEX idx_order_parts_batch ON source_order_parts(import_batch_id);
CREATE INDEX idx_order_parts_imei ON source_order_parts(import_batch_id, imei);
CREATE INDEX idx_order_parts_pedido ON source_order_parts(import_batch_id, id_pedido);
CREATE INDEX idx_order_parts_chave ON source_order_parts(import_batch_id, chave_peca_norm);
CREATE INDEX idx_order_parts_status ON source_order_parts(import_batch_id, status_atual_legado);
