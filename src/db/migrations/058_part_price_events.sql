-- 058: Tabela canônica de eventos de preço de peças.
-- Cada registro é imutável — correções criam novos eventos.
-- Fonte de verdade para histórico de custos, resolução de custo efetivo,
-- auditoria de preços e cálculo de margem de reparo.

CREATE TABLE IF NOT EXISTS part_price_events (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  chave_peca                TEXT    NOT NULL,
  chave_peca_norm           TEXT    NOT NULL,
  source_type               TEXT    NOT NULL
    CHECK (source_type IN (
      'COTACAO',
      'APPROVED_COTACAO',
      'PURCHASE_ORDER',
      'GOODS_RECEIPT',
      'MANUAL_OVERRIDE',
      'COST_CORRECTION',
      'BACKFILL_COTACAO',
      'BACKFILL_ORDER',
      'BACKFILL_RECEIPT'
    )),
  unit_price                REAL    NOT NULL,
  effective_unit_cost       REAL,
  quantity                  INTEGER,
  supplier                  TEXT,
  cotacao_id                INTEGER REFERENCES cotacoes(id),
  cotacao_item_id           INTEGER,
  purchase_order_id         INTEGER REFERENCES purchase_orders(id),
  purchase_order_item_id    INTEGER,
  goods_receipt_id          INTEGER,
  goods_receipt_item_id     INTEGER,
  confidence                TEXT    NOT NULL DEFAULT 'MEDIUM'
    CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  previous_price            REAL,
  notes                     TEXT,
  created_by                TEXT,
  occurred_at               TEXT    NOT NULL,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ppe_chave_norm
  ON part_price_events(chave_peca_norm, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_ppe_source
  ON part_price_events(source_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_ppe_cotacao
  ON part_price_events(cotacao_id) WHERE cotacao_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ppe_po
  ON part_price_events(purchase_order_id) WHERE purchase_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ppe_receipt
  ON part_price_events(goods_receipt_id) WHERE goods_receipt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ppe_supplier
  ON part_price_events(supplier, chave_peca_norm) WHERE supplier IS NOT NULL;
