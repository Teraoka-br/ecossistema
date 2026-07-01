import { openDatabase } from "../src/db/database.js";

const db = openDatabase("data/app.sqlite");

const state = db.prepare("SELECT * FROM system_state").get() as any;
console.log("system_state.initialized =", state.initialized);
console.log("system_state.initial_import_batch_id =", state.initial_import_batch_id);
console.log("system_state.initialized_by =", state.initialized_by);

const prCount = (db.prepare("SELECT COUNT(*) as c FROM purchase_requests").get() as any).c;
console.log("purchase_requests =", prCount);

const invalidOriginCount = (db.prepare("SELECT COUNT(*) as c FROM purchase_requests WHERE source_quotation_id IS NULL").get() as any).c;
console.log("invalid_origins =", invalidOriginCount);

const duplicateQuotations = db.prepare("SELECT source_quotation_id, COUNT(*) as c FROM purchase_requests GROUP BY source_quotation_id HAVING c > 1").all() as any[];
console.log("duplicate_source_quotation_id =", duplicateQuotations.length);

const sopCount = (db.prepare("SELECT COUNT(*) as c FROM source_order_parts").get() as any).c;
console.log("source_order_parts =", sopCount);

const siiCount = (db.prepare("SELECT COUNT(*) as c FROM source_inventory_items").get() as any).c;
console.log("source_inventory_items =", siiCount);

const sqCount = (db.prepare("SELECT COUNT(*) as c FROM source_quotations").get() as any).c;
console.log("source_quotations =", sqCount);

const stockMovCount = (db.prepare("SELECT COUNT(*) as c FROM stock_movements").get() as any).c;
console.log("stock_movements =", stockMovCount);

const opEventsCount = (db.prepare("SELECT COUNT(*) as c FROM operational_events").get() as any).c;
console.log("operational_events =", opEventsCount);

const countSessionsCount = (db.prepare("SELECT COUNT(*) as c FROM count_sessions").get() as any).c;
console.log("count_sessions =", countSessionsCount);

const matchRunsCount = (db.prepare("SELECT COUNT(*) as c FROM match_runs").get() as any).c;
console.log("match_runs =", matchRunsCount);

const rules = db.prepare("SELECT * FROM decision_rules WHERE active = 1").all() as any[];
if (rules.length === 1) {
  const r = rules[0];
  console.log("decision_rule_active_count = 1");
  console.log(`age_days_per_point > 0 = ${r.age_days_per_point > 0}`);
  console.log(`age_max_points >= 0 = ${r.age_max_points >= 0}`);
  console.log(`margin_per_point > 0 = ${r.margin_per_point > 0}`);
  console.log(`margin_allows_negative = ${r.margin_allows_negative}`);
} else {
  console.log("decision_rule_active_count =", rules.length);
}
