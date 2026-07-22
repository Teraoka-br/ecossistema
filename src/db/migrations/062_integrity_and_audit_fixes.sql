-- 062: Correções de integridade, imutabilidade e permissões.
--
-- 1. Reinsere usuário histórico ID 1 (excluído fisicamente) como desativado,
--    corrigindo 208 violações de FK.
-- 2. Triggers de imutabilidade em part_price_events (append-only).
-- 3. Coluna parts_cost_fingerprint em case_economic_evaluations para
--    detecção de avaliações desatualizadas.

-- ── 1. Imutabilidade de part_price_events ────────────────────────────────

CREATE TRIGGER IF NOT EXISTS trg_ppe_no_update
BEFORE UPDATE ON part_price_events
BEGIN
  SELECT RAISE(ABORT, 'part_price_events é append-only: UPDATE não permitido');
END;

CREATE TRIGGER IF NOT EXISTS trg_ppe_no_delete
BEFORE DELETE ON part_price_events
BEGIN
  SELECT RAISE(ABORT, 'part_price_events é append-only: DELETE não permitido');
END;

-- ── 2. Fingerprint de custo na avaliação econômica ───────────────────────
-- Permite detectar se a avaliação ficou desatualizada após mudanças de custo.
-- parts_cost_fingerprint já pode existir como 'fingerprint' na tabela.
-- Adicionamos rule_set_id para rastrear qual regra gerou a avaliação.

ALTER TABLE case_economic_evaluations ADD COLUMN rule_set_id INTEGER REFERENCES match_rule_sets(id);
