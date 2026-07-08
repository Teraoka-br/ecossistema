import type { Db } from "../db/database.js";

export interface RecordEventInput {
  repairCaseId: number;
  eventType: string;
  previousStatus?: string | null;
  newStatus?: string | null;
  responsibleName?: string | null;
  notes?: string | null;
  stockMovementId?: number | null;
}

/**
 * Grava um evento em operational_events para entity_type='repair_case'.
 * Deve ser chamado dentro da transação do serviço chamador — não abre transação própria.
 */
export function recordOperationalEvent(db: Db, input: RecordEventInput): number {
  const result = db.prepare(`
    INSERT INTO operational_events (
      entity_type, entity_id, event_type,
      previous_status, new_status,
      responsible_name, notes, stock_movement_id,
      created_at
    ) VALUES (
      'repair_case', ?, ?,
      ?, ?,
      ?, ?, ?,
      datetime('now')
    )
  `).run(
    String(input.repairCaseId),
    input.eventType,
    input.previousStatus ?? null,
    input.newStatus ?? null,
    input.responsibleName ?? null,
    input.notes ?? null,
    input.stockMovementId ?? null,
  );
  return result.lastInsertRowid as number;
}
