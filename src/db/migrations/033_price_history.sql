-- 033: histórico de preços por chave de peça
-- Gravado automaticamente quando uma cotação é aprovada.
-- Fonte de dados para dashboard de variação de preço.

CREATE TABLE price_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chave_peca     TEXT    NOT NULL,
  supplier       TEXT    NOT NULL,
  valor_unitario REAL    NOT NULL,
  cotacao_id     INTEGER NOT NULL REFERENCES cotacoes(id),
  recorded_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_price_history_chave ON price_history(chave_peca, recorded_at);
