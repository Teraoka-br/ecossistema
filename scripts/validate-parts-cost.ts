/**
 * Validação da camada de custos numa CÓPIA do banco beta (§26 da spec).
 *
 * NUNCA toca o banco original. Uso:
 *   npx tsx scripts/validate-parts-cost.ts [caminho-da-copia]
 * (padrão: data/app-beta-copy.sqlite)
 *
 * Executa: migrations → backfill (2× para provar idempotência) → cobertura
 * de custo → comparação sombra vs legado → score real com peças (somente
 * simulado) → avaliação econômica. Imprime relatório JSON. Não altera regra
 * ativa nem workflow de nenhum caso.
 */

import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { backfillPriceEvents } from "../src/operational/part-price-backfill.js";
import { calculateRepairPartsCost } from "../src/operational/repair-parts-cost-service.js";
import { calculateRepairMargin } from "../src/match/repair-margin-service.js";
import { loadActiveRuleStrict, loadEngineInput, ENGINE_LOCKED_STATUSES } from "../src/match/engine-loader.js";
import { calculateMatch } from "../src/match/calculate-match.js";
import { evaluateEconomics } from "../src/match/economic-evaluation-service.js";

const dbPath = process.argv[2] ?? "data/app-beta-copy.sqlite";
const t0 = Date.now();
const db = openDatabase(dbPath);

// 1. Migrations (idempotente — segunda execução não aplica nada)
const mig = runMigrations(db, { backup: false });

// 2. Backfill (2ª execução prova idempotência)
const bf1 = backfillPriceEvents(db);
const bf2 = backfillPriceEvents(db);

// 3. Cobertura de custo por caso aberto
const lockedList = ENGINE_LOCKED_STATUSES.map((s) => `'${s}'`).join(",");
const cases = db.prepare(`
  SELECT id, cost, estimated_sale FROM repair_cases
  WHERE analysis_status = 'COMPLETED' AND workflow_status NOT IN (${lockedList})
`).all() as unknown as Array<{ id: number; cost: number | null; estimated_sale: number | null }>;

let fullCoverage = 0, partialCoverage = 0, noCoverage = 0, noParts = 0, marginChanged = 0;
const marginDiffs: Array<{ caseId: number; legacy: number | null; repair: number | null; ratio: number | null }> = [];
const tCost0 = Date.now();
for (const c of cases) {
  const parts = calculateRepairPartsCost(db, c.id);
  if (parts.items.length === 0) { noParts++; continue; }
  if (parts.coveragePercentage >= 100) fullCoverage++;
  else if (parts.coveragePercentage > 0) partialCoverage++;
  else noCoverage++;
  const m = calculateRepairMargin({ estimatedSale: c.estimated_sale, cost: c.cost, partsCostResult: parts });
  if (m.repairMargin !== null && m.legacyMargin !== null && m.repairMargin !== m.legacyMargin) {
    marginChanged++;
    marginDiffs.push({ caseId: c.id, legacy: m.legacyMargin, repair: m.repairMargin, ratio: m.repairCostRatio });
  }
}
const tCostMs = Date.now() - tCost0;
marginDiffs.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));

// 4. Sombra vs legado vs score real com peças (só em memória — nada persiste)
const activeRule = loadActiveRuleStrict(db);
const input = loadEngineInput(db, { ...activeRule, includePartsCost: true, shadowMode: true });
const legacyOut = calculateMatch({ ...input, activeRule: { ...activeRule, includePartsCost: false } });
const shadowOut = calculateMatch({ ...input, activeRule: { ...activeRule, includePartsCost: true, shadowMode: true } });
const realOut = calculateMatch({
  ...input,
  activeRule: { ...activeRule, includePartsCost: true, shadowMode: false, minPartsCostCoverage: 100, missingCostBehavior: "USE_LEGACY_MARGIN" },
});

let shadowIdentical = true;
for (let i = 0; i < legacyOut.cases.length; i++) {
  if (legacyOut.cases[i].result !== shadowOut.cases[i].result || legacyOut.cases[i].rank !== shadowOut.cases[i].rank) {
    shadowIdentical = false;
    break;
  }
}
const legacyByCase = new Map(legacyOut.cases.map((c) => [c.caseId, c]));
let positionChanges = 0, statusChanges = 0;
for (const c of realOut.cases) {
  const lc = legacyByCase.get(c.caseId);
  if (!lc) continue;
  if (lc.result !== c.result) statusChanges++;
  else if (lc.rank !== null && c.rank !== null && lc.rank !== c.rank) positionChanges++;
}

// 5. Avaliação econômica (na cópia)
const econ = evaluateEconomics(db);

const events = (db.prepare("SELECT COUNT(*) n FROM part_price_events").get() as { n: number }).n;
const chaves = (db.prepare("SELECT COUNT(DISTINCT chave_peca_norm) n FROM part_price_events").get() as { n: number }).n;

console.log(JSON.stringify({
  banco: dbPath,
  migrations: mig,
  backfill: bf1,
  backfillSegundaExecucao: bf2,
  totalEventosPreco: events,
  chavesComPreco: chaves,
  casosAbertos: cases.length,
  casosSemPecas: noParts,
  coberturaTotal: fullCoverage,
  coberturaParcial: partialCoverage,
  coberturaZero: noCoverage,
  casosComMargemAlterada: marginChanged,
  top30MudancasMargem: marginDiffs.slice(0, 30),
  modoSombra: { filaIdenticaAoLegado: shadowIdentical },
  scoreRealComPecasSimulado: { statusMudariam: statusChanges, posicoesMudariam: positionChanges },
  avaliacaoEconomica: econ,
  temposMs: { custoTodosCasos: tCostMs, total: Date.now() - t0 },
}, null, 2));
