-- Migration 021 — Sync operacional: localização/disponibilidade em repair_cases,
-- vínculo part_request ↔ purchase_request.

-- Colunas de localização vindas do Rel Seriais
ALTER TABLE repair_cases ADD COLUMN deposito_atual TEXT;
ALTER TABLE repair_cases ADD COLUMN filial_atual TEXT;
ALTER TABLE repair_cases ADD COLUMN source_disponivel TEXT;
ALTER TABLE repair_cases ADD COLUMN last_seen_in_source_at TEXT; -- ISO datetime

-- Vínculo part_request ↔ purchase_request (one active per part_request)
ALTER TABLE purchase_requests ADD COLUMN part_request_id INTEGER REFERENCES part_requests(id);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_pr_part_request_active
  ON purchase_requests(part_request_id)
  WHERE part_request_id IS NOT NULL
    AND status NOT IN ('CANCELADO', 'CANCELADA');
