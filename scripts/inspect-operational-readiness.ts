import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { getSystemState, initializeSystem } from "../src/system/system-service.js";
import { runMatch, exportResultsCsv } from "../src/match/match-service.js";
import { getCurrentOperationalStock } from "../src/operational/stock-service.js";

const db = openDatabase("data/tmp/test-match.sqlite");
runMigrations(db);

const stateBefore = getSystemState(db);
if (!stateBefore.initialized) {
  console.log("Not initialized. Initializing in test DB...");
  const batch = db.prepare("SELECT id FROM import_batches WHERE status IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS') ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  if (batch) {
    initializeSystem(db, batch.id, "OPERATIONAL READINESS TEST");
  }
}

const state = getSystemState(db);
console.log("Initialized:", state.initialized);

const rules = db.prepare("SELECT * FROM decision_rules WHERE active = 1").all() as any[];
console.log("Active decision rules count:", rules.length);
if (rules.length > 0) {
  console.log("Rule margin_allows_negative:", rules[0].margin_allows_negative);
}

const initialMovements = (db.prepare("SELECT COUNT(*) as c FROM stock_movements").get() as any).c;
const initialEvents = (db.prepare("SELECT COUNT(*) as c FROM operational_events").get() as any).c;

console.log("Running forced match...");
const matchResult = runMatch(db, { createdBy: "OPERATIONAL READINESS TEST", force: true });
console.log("Match run ID:", matchResult.run.id);

// Validations
const resultsCount = (db.prepare("SELECT COUNT(*) as c FROM match_results WHERE match_run_id = ?").get(matchResult.run.id) as any).c;
const sourceOrderPartsCount = (db.prepare("SELECT COUNT(*) as c FROM source_order_parts").get() as any).c;
console.log("One result per order part:", resultsCount === sourceOrderPartsCount);

const deviceCount = (db.prepare("SELECT COUNT(*) as c FROM match_device_results WHERE match_run_id = ?").get(matchResult.run.id) as any).c;
console.log("Device result count:", deviceCount);

const stockAuditCount = (db.prepare("SELECT COUNT(*) as c FROM match_stock_results WHERE match_run_id = ?").get(matchResult.run.id) as any).c;
console.log("Stock audit totals:", stockAuditCount);

const stockSummary = db.prepare("SELECT SUM(initial_quantity) as init, SUM(allocated_full + allocated_partial) as alloc, SUM(remaining_quantity) as rem FROM match_stock_results WHERE match_run_id = ?").get(matchResult.run.id) as any;

const stockObj = getCurrentOperationalStock(db);
const usableStock = stockObj.groups.filter(g => g.mapeada).reduce((sum, g) => sum + g.currentQuantity, 0);

console.log(`Debug stock - init: ${stockSummary.init}, usable: ${usableStock}, alloc: ${stockSummary.alloc}, rem: ${stockSummary.rem}`);
console.log("Stock audit initial total equals usable stock:", stockSummary.init === usableStock);
console.log("Allocated units do not exceed usable stock:", stockSummary.alloc <= usableStock);
console.log("Remaining total equals remaining usable units:", stockSummary.rem === usableStock - stockSummary.alloc);

const negativeScores = (db.prepare("SELECT COUNT(*) as c FROM match_results WHERE match_run_id = ? AND score < 0").get(matchResult.run.id) as any).c;
console.log("Negative device scores persisted:", negativeScores > 0);

const permStatuses = (db.prepare("SELECT SUM(reserved_units) as c FROM match_results WHERE match_run_id = ? AND allocation_phase = 'PRESERVED'").get(matchResult.run.id) as any).c;
console.log("Permanent statuses allocate zero:", permStatuses === 0 || permStatuses === null);

const finalMovements = (db.prepare("SELECT COUNT(*) as c FROM stock_movements").get() as any).c;
const finalEvents = (db.prepare("SELECT COUNT(*) as c FROM operational_events").get() as any).c;
console.log("No stock movement created:", initialMovements === finalMovements);
console.log("No operational event created:", initialEvents === finalEvents);

const csvFull = exportResultsCsv(db, matchResult.run.id, false).split('\n').filter(l => l.trim()).length - 1;
const csvDiv = exportResultsCsv(db, matchResult.run.id, true).split('\n').filter(l => l.trim()).length - 1;
console.log("CSV full row count:", csvFull);
console.log("CSV div row count:", csvDiv);

console.log("Running second match without force...");
const matchResult2 = runMatch(db, { createdBy: "OPERATIONAL READINESS TEST" });
console.log("Second execution reuses run:", matchResult2.run.id === matchResult.run.id);

// Check consumption order continuity
const maxConsumptionOrders = db.prepare(`
  SELECT chave_peca_norm, MAX(ordem_consumo) as mx, COUNT(ordem_consumo) as cnt
  FROM match_results 
  WHERE match_run_id = ? AND ordem_consumo IS NOT NULL
  GROUP BY chave_peca_norm
`).all(matchResult.run.id) as any[];
const isContinuous = maxConsumptionOrders.every(r => r.mx === r.cnt);
console.log("Consumption order is continuous per CHAVEPECA:", isContinuous);
