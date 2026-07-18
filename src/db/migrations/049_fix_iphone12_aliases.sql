-- Corrige aliases de compatibilidade iPhone 12 / 12 Pro configurados incorretamente.

-- 1. Reativa alias "BATERIA IPHONE 12 PRO" → PC-QA15247 (estava desativado)
UPDATE part_key_aliases
SET active = 1, updated_at = datetime('now')
WHERE id = 4;

-- 2. Desativa alias invertido: "FRONTAL IPHONE 12/12 PRO" → "FRONTAL IPHONE 12 PRO"
--    (mapeava a chave do ESTOQUE para a chave dos CASOS — sentido errado)
UPDATE part_key_aliases
SET active = 0, updated_at = datetime('now')
WHERE id = 6;

-- 3. Adiciona alias faltante: "FRONTAL IPHONE 12 PRO" → "FRONTAL IPHONE 12/12 PRO"
INSERT OR IGNORE INTO part_key_aliases
  (requested_chave_peca, requested_chave_peca_norm, stock_chave_peca, stock_chave_peca_norm, reason, active, created_by_user_id)
VALUES
  ('FRONTAL IPHONE 12 PRO', 'FRONTAL IPHONE 12 PRO', 'FRONTAL IPHONE 12/12 PRO', 'FRONTAL IPHONE 12/12 PRO', 'frontal 12 e 12 pro são compatíveis', 1, 3);
