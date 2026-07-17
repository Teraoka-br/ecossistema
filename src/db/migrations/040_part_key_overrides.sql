-- migration 040: marca chaves promovidas de importadas e preserva valores originais
-- Não altera dados existentes em custom_part_keys (são genuinamente manuais).

ALTER TABLE custom_part_keys ADD COLUMN promoted_from_import INTEGER NOT NULL DEFAULT 0 CHECK (promoted_from_import IN (0,1));
ALTER TABLE custom_part_keys ADD COLUMN original_chave_peca TEXT;
ALTER TABLE custom_part_keys ADD COLUMN original_descricao TEXT;
