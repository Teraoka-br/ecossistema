/**
 * Libera reservas ACTIVE em operational_reservations cujo part_request_id
 * é NULL ou aponta para um part_request inexistente (dados corrompidos).
 *
 * Uso:
 *   npm run cleanup:invalid-reservations -- --dry-run   (apenas exibe)
 *   npm run cleanup:invalid-reservations -- --apply     (aplica)
 */

import { getDb } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run") || !args.includes("--apply");

const db = getDb();
runMigrations(db);

// Reservas ACTIVE sem part_request válido
const invalid = db.prepare(`
  SELECT op.id, op.part_request_id, op.repair_case_id, op.chave_peca_norm
  FROM operational_reservations op
  WHERE op.status = 'ACTIVE'
    AND (
      op.part_request_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM part_requests pr WHERE pr.id = op.part_request_id)
    )
`).all() as { id: number; part_request_id: number | null; repair_case_id: number; chave_peca_norm: string }[];

if (invalid.length === 0) {
  console.log("[cleanup] Nenhuma reserva inválida encontrada.");
  process.exit(0);
}

console.log(`[cleanup] ${invalid.length} reserva(s) inválida(s) encontrada(s):`);
for (const r of invalid) {
  console.log(`  id=${r.id}  part_request_id=${r.part_request_id ?? "NULL"}  repair_case_id=${r.repair_case_id}  chave=${r.chave_peca_norm}`);
}

if (isDryRun) {
  console.log("[cleanup] Modo dry-run — nenhuma alteração aplicada. Use --apply para corrigir.");
  process.exit(0);
}

db.exec("BEGIN");
try {
  for (const r of invalid) {
    db.prepare(`
      UPDATE operational_reservations SET
        status = 'RELEASED',
        cancel_reason = 'Liberação automática: part_request inválido ou ausente',
        cancel_reason_code = 'INVALID_PART_REQUEST',
        released_at = datetime('now')
      WHERE id = ?
    `).run(r.id);
  }
  db.exec("COMMIT");
  console.log(`[cleanup] ${invalid.length} reserva(s) liberada(s).`);
} catch (err) {
  db.exec("ROLLBACK");
  console.error("[cleanup] Erro ao liberar reservas:", err);
  process.exit(1);
}
