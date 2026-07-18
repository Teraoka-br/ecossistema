-- Índices para as queries mais frequentes do dashboard e fila de reparos

CREATE INDEX IF NOT EXISTS idx_repair_cases_workflow
  ON repair_cases(workflow_status);

CREATE INDEX IF NOT EXISTS idx_repair_cases_technician
  ON repair_cases(directed_technician_id)
  WHERE directed_technician_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_part_requests_status
  ON part_requests(status, cancelled_at);

CREATE INDEX IF NOT EXISTS idx_count_sessions_status_finished
  ON count_sessions(status, finished_at)
  WHERE status = 'FINALIZED';

CREATE INDEX IF NOT EXISTS idx_stock_movements_type
  ON stock_movements(movement_type, reversed_at)
  WHERE reversed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_status
  ON purchase_orders(status);
