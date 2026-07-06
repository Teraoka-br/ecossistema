-- Migration 020 — PEACS: chave por MARCA/MODELO em vez de FAMÍLIA+MEMÓRIA.
--
-- Problema: UNIQUE em (brand_norm, model_norm, capacity_norm) causava colisão quando
-- duas linhas tinham MARCA/MODELO distintos mas MEMÓRIA idêntica (ex: MOTO EDGE 50 256GB
-- e MOTO EDGE 50 512GB ambas com MEMÓRIA=256GB).
--
-- Solução: chave natural principal = MARCA/MODELO normalizado (marca_modelo_norm).
-- brand/model/capacity continuam como atributos auxiliares derivados de FAMÍLIA+MEMÓRIA.
-- Adicionamos marca_modelo, marca_modelo_norm, familia, memoria_src, updated_at.

-- 1. Adicionar colunas novas (brand/model antigos ficam por compatibilidade)
ALTER TABLE peacs_catalog ADD COLUMN marca_modelo      TEXT;
ALTER TABLE peacs_catalog ADD COLUMN marca_modelo_norm TEXT;
ALTER TABLE peacs_catalog ADD COLUMN familia           TEXT;
ALTER TABLE peacs_catalog ADD COLUMN memoria_src       TEXT;
ALTER TABLE peacs_catalog ADD COLUMN updated_at        TEXT DEFAULT (datetime('now'));

-- 2. Remover índice único antigo (brand_norm, model_norm, capacity_norm)
DROP INDEX IF EXISTS idx_peacs_catalog_key;

-- 3. Criar novo índice único por marca_modelo_norm WHERE active=1
--    Rows antigas (sem marca_modelo_norm) ficam com NULL e não participam da restrição.
CREATE UNIQUE INDEX idx_peacs_catalog_marca_modelo
  ON peacs_catalog(marca_modelo_norm)
  WHERE active = 1 AND marca_modelo_norm IS NOT NULL;
