-- Migration 022 — Corrige índice único em purchase_requests.part_request_id.
-- A migration 021 usou 'CANCELADO'/'CANCELADA' mas purchase_requests.status usa 'CANCELLED'.
-- Remove o índice antigo e recria com a condição correta.

DROP INDEX IF EXISTS uidx_pr_part_request_active;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_pr_part_request_active
  ON purchase_requests(part_request_id)
  WHERE part_request_id IS NOT NULL
    AND status != 'CANCELLED';
