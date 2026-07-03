-- Migration 017 — padroniza nome da coluna allocated_reference_norm em repair_match_results.
--
-- A migration 013 criou a coluna como `allocated_ref_norm`.
-- O motor (engine-orchestrator.ts) tenta gravar em `allocated_reference_norm`.
-- Esta migration adiciona a coluna padronizada e retrocopia dados existentes.
-- É idempotente: ALTER TABLE ADD COLUMN é no-op se a coluna já existir (por guarda externa).
--
-- Estratégia segura (sem reconstrução de tabela):
--   1. Adicionar coluna `allocated_reference_norm` via ADD COLUMN.
--   2. Copiar dados existentes de `allocated_ref_norm` → `allocated_reference_norm`.
--   A coluna antiga é mantida para não quebrar consultas legadas.

ALTER TABLE repair_match_results ADD COLUMN allocated_reference_norm TEXT;

-- Retrocopiar dados existentes (se houver resultados anteriores)
UPDATE repair_match_results
   SET allocated_reference_norm = allocated_ref_norm
 WHERE allocated_ref_norm IS NOT NULL
   AND allocated_reference_norm IS NULL;
