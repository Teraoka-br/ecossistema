-- Migration 003 — contabiliza conflitos de forma independente de warnings/erros.

ALTER TABLE import_batches ADD COLUMN conflicts_count INTEGER NOT NULL DEFAULT 0;
