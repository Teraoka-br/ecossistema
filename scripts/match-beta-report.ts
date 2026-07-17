/**
 * Relatório comparativo do motor único de match sobre uma CÓPIA do banco beta.
 *
 * Uso: npx tsx scripts/match-beta-report.ts [caminho-da-copia]
 *   (padrão: data/app-beta-copy.sqlite)
 *
 * NUNCA aponte para o banco beta real — o script aplica migrations, executa o
 * motor real e cria regras de simulação na base informada.
 */

import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { runRepairMatchEngine } from "../src/match/engine-orchestrator.js";
import { simulateMatchRules } from "../src/match/simulate-service.js";
import { createDraftRuleSet, getActiveRuleSet } from "../src/match/match-rule-service.js";
import { loadActiveRuleStrict, loadEngineInput } from "../src/match/engine-loader.js";
import { calculateMatch } from "../src/match/calculate-match.js";

const dbPath = process.argv[2] ?? "data/app-beta-copy.sqlite";
if (!fs.existsSync(dbPath)) {
  console.error(`Cópia não encontrada: ${dbPath}`);
  process.exit(1);
}
if (path.basename(dbPath) === "app-beta.sqlite" || path.basename(dbPath) === "app.sqlite") {
  console.error("Recuse-se a rodar no banco operacional — use uma cópia.");
  process.exit(1);
}

const db = openDatabase(dbPath);
runMigrations(db);

const out: string[] = [];
const w = (s = "") => { out.push(s); };
const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...(p as never[])) as { c: number }).c;

w(`# Validação do motor único de match — cópia do banco beta`);
w();
w(`> Gerado em ${new Date().toISOString()} sobre \`${dbPath}\` (o beta real não foi tocado).`);
w();

// ─── Estado atual (antes do novo motor) ────────────────────────────────────
w(`## 1. Estado atual (antes do novo motor)`);
w();
const active = getActiveRuleSet(db);
w(`- Regra ativa: **${active.name ?? `v${active.version}`}** (id ${active.id}, versão ${active.version}) — R$ ${active.marginAmountPerPoint}/pt, ${active.ageDaysPerPoint} dias/pt, teto ${active.ageMaxPoints}, pesos ${active.marginWeight}/${active.ageWeight}, margem negativa ${active.allowNegativeMarginScore ? "pune" : "não pune"}`);
const wfRows = db.prepare("SELECT workflow_status s, COUNT(*) c FROM repair_cases GROUP BY 1 ORDER BY 2 DESC").all() as { s: string; c: number }[];
w(`- Cards por workflow_status:`);
for (const r of wfRows) w(`  - ${r.s}: ${r.c}`);
w(`- Cards elegíveis p/ motor (analysis COMPLETED, fora de estados travados): ${count(`SELECT COUNT(*) c FROM repair_cases WHERE analysis_status='COMPLETED' AND workflow_status NOT IN ('APTO_REPARO','EM_SEPARACAO','DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO','CONCLUIDO','VENDA_ESTADO','CANCELADO')`)}`);
w(`- Desses, sem custo: ${count(`SELECT COUNT(*) c FROM repair_cases WHERE analysis_status='COMPLETED' AND workflow_status NOT IN ('APTO_REPARO','EM_SEPARACAO','DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO','CONCLUIDO','VENDA_ESTADO','CANCELADO') AND cost IS NULL`)}, sem venda: ${count(`SELECT COUNT(*) c FROM repair_cases WHERE analysis_status='COMPLETED' AND workflow_status NOT IN ('APTO_REPARO','EM_SEPARACAO','DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO','CONCLUIDO','VENDA_ESTADO','CANCELADO') AND estimated_sale IS NULL`)}, sem idade: ${count(`SELECT COUNT(*) c FROM repair_cases WHERE analysis_status='COMPLETED' AND workflow_status NOT IN ('APTO_REPARO','EM_SEPARACAO','DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO','CONCLUIDO','VENDA_ESTADO','CANCELADO') AND age_days IS NULL`)}`);
w(`- Sem depósito: ${count(`SELECT COUNT(*) c FROM repair_cases WHERE analysis_status='COMPLETED' AND workflow_status NOT IN ('APTO_REPARO','EM_SEPARACAO','DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO','CONCLUIDO','VENDA_ESTADO','CANCELADO') AND (deposito_atual IS NULL OR deposito_atual='')`)}, depósito fora do fluxo: ${count(`SELECT COUNT(*) c FROM repair_cases WHERE analysis_status='COMPLETED' AND workflow_status NOT IN ('APTO_REPARO','EM_SEPARACAO','DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO','CONCLUIDO','VENDA_ESTADO','CANCELADO') AND deposito_atual IS NOT NULL AND deposito_atual != '' AND UPPER(deposito_atual) NOT IN ('AGUARDANDO PECA','MANUTENCAO INTERNA')`)}`);
w();

// snapshot dos workflows antes
const before = new Map(
  (db.prepare("SELECT id, workflow_status FROM repair_cases").all() as { id: number; workflow_status: string }[])
    .map(r => [r.id, r.workflow_status]),
);

// ─── Novo motor com a regra ativa (execução REAL na cópia) ────────────────
w(`## 2. Novo motor executado na cópia (regra ativa ${active.name ?? `v${active.version}`})`);
w();
const run = await runRepairMatchEngine(db, { triggerReason: "BETA_VALIDATION_COPY" });
w(`- Run #${run.runId} em ${run.durationMs} ms`);
w(`- Cards avaliados: ${run.casesEvaluated}`);
w(`- MATCH: ${run.fullKitsFound} · MATCH_PARCIAL: ${run.partialKitsFound} · VERIFICAR: ${run.verificarCount}`);
const runStatuses = db.prepare(
  "SELECT result_status s, COUNT(*) c FROM repair_match_case_results WHERE run_id = ? GROUP BY 1 ORDER BY 2 DESC",
).all(run.runId) as { s: string; c: number }[];
w(`- Resultado canônico por card:`);
for (const r of runStatuses) w(`  - ${r.s}: ${r.c}`);
w(`- Workflows alterados: ${run.casesChanged}`);

const changedRows = (db.prepare("SELECT id, workflow_status FROM repair_cases").all() as { id: number; workflow_status: string }[])
  .filter(r => before.get(r.id) !== r.workflow_status);
const enteringMatch = changedRows.filter(r => r.workflow_status === "MATCH").map(r => r.id);
const leavingMatch = changedRows.filter(r => before.get(r.id) === "MATCH").map(r => r.id);
w(`- Entraram em MATCH: ${enteringMatch.length}${enteringMatch.length ? ` (${enteringMatch.slice(0, 20).map(i => `#${i}`).join(", ")}${enteringMatch.length > 20 ? "…" : ""})` : ""}`);
w(`- Saíram de MATCH: ${leavingMatch.length}${leavingMatch.length ? ` (${leavingMatch.slice(0, 20).map(i => `#${i}`).join(", ")}${leavingMatch.length > 20 ? "…" : ""})` : ""}`);

// motivos de VERIFICAR
const reasonCounts = new Map<string, number>();
for (const row of db.prepare("SELECT verify_reasons_json j FROM repair_match_case_results WHERE run_id = ? AND verify_reasons_json IS NOT NULL").all(run.runId) as { j: string }[]) {
  for (const reason of JSON.parse(row.j) as string[]) {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
}
w(`- Motivos de VERIFICAR (um card pode ter vários):`);
for (const [reason, c] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) w(`  - ${reason}: ${c}`);
w();

// idempotência: segunda execução
const run2 = await runRepairMatchEngine(db, { triggerReason: "BETA_VALIDATION_IDEMPOTENCY" });
w(`- Idempotência: segunda execução alterou ${run2.casesChanged} workflow(s) (esperado 0) e repetiu MATCH=${run2.fullKitsFound}, PARCIAL=${run2.partialKitsFound}, VERIFICAR=${run2.verificarCount}`);
w();

// disputa + top 30 usando a função pura diretamente
const rule = loadActiveRuleStrict(db);
const input = loadEngineInput(db, rule);
const pure = calculateMatch(input);
w(`- Referências mais disputadas (demanda > disponível): ${pure.disputedKeys.length}`);
for (const d of pure.disputedKeys.slice(0, 10)) w(`  - ${d.stockChaveNorm}: ${d.demanded} pedem / ${d.available} disponível`);
w();
w(`### Top 30 cards por score (regra ativa)`);
w();
w(`| # | Caso | Resultado | Margem | Pts margem | Pts idade | Score |`);
w(`|---|------|-----------|--------|-----------|-----------|-------|`);
const ranked = pure.cases.filter(c => c.rank !== null).sort((a, b) => a.rank! - b.rank!).slice(0, 30);
for (const c of ranked) {
  w(`| ${c.rank} | #${c.caseId} | ${c.result} | ${c.margin?.toFixed(2) ?? "—"} | ${c.marginPoints?.toFixed(3) ?? "—"} | ${c.agePoints?.toFixed(3) ?? "—"} | ${c.score?.toFixed(3) ?? "—"} |`);
}
w();

// ─── Regra 1 da especificação (teto 12) — simulação ───────────────────────
w(`## 3. Regra 1 da especificação (150/30, pesos 1/1, teto 12) — simulação`);
w();
const regra1 = createDraftRuleSet(db, {
  name: "Regra 1 (spec)", marginAmountPerPoint: 150, ageDaysPerPoint: 30,
  ageMaxPoints: 12, marginWeight: 1, ageWeight: 1, allowNegativeMarginScore: true,
  reason: "Simulação de validação — não ativar",
});
const simR1 = await simulateMatchRules(db, { ruleSetId: regra1.id, compareWithActive: true });
w(`- MATCH: ${simR1.fullKitsFound} · PARCIAL: ${simR1.partialKitsFound} · PEDIR_PEÇA: ${simR1.pedirPecaCount} · AGUARDANDO: ${simR1.aguardandoCount} · VERIFICAR: ${simR1.verificarCount}`);
w(`- Cards que mudariam vs. regra ativa: ${simR1.changedComparedToActive} (MATCH completo: ${simR1.changedFullMatchMembership}, parcial: ${simR1.changedPartialMembership}, posição: ${simR1.positionChanges})`);
if (simR1.enteringMatch.length) w(`- Entrariam em MATCH: ${simR1.enteringMatch.map(i => `#${i}`).join(", ")}`);
if (simR1.leavingMatch.length) w(`- Sairiam de MATCH: ${simR1.leavingMatch.map(i => `#${i}`).join(", ")}`);
w();

// ─── Foco em margem — simulação ────────────────────────────────────────────
w(`## 4. Regra com foco em margem (100/pt, 60 dias/pt, pesos 2/0,5, teto 12) — simulação`);
w();
const focoMargem = createDraftRuleSet(db, {
  name: "Foco em margem (simulação)", marginAmountPerPoint: 100, ageDaysPerPoint: 60,
  ageMaxPoints: 12, marginWeight: 2, ageWeight: 0.5, allowNegativeMarginScore: true,
  reason: "Simulação de validação — não ativar",
});
const simM = await simulateMatchRules(db, { ruleSetId: focoMargem.id, compareWithActive: true });
w(`- MATCH: ${simM.fullKitsFound} · PARCIAL: ${simM.partialKitsFound} · PEDIR_PEÇA: ${simM.pedirPecaCount} · AGUARDANDO: ${simM.aguardandoCount} · VERIFICAR: ${simM.verificarCount}`);
w(`- Cards que mudariam vs. regra ativa: ${simM.changedComparedToActive} (MATCH completo: ${simM.changedFullMatchMembership}, parcial: ${simM.changedPartialMembership}, posição: ${simM.positionChanges})`);
if (simM.enteringMatch.length) w(`- Ganhariam prioridade (entram em MATCH): ${simM.enteringMatch.map(i => `#${i}`).join(", ")}`);
if (simM.leavingMatch.length) w(`- Perderiam (saem de MATCH): ${simM.leavingMatch.map(i => `#${i}`).join(", ")}`);
w(`- Top mudanças por score:`);
for (const t of simM.topChangedCases) w(`  - #${t.caseId}: ${t.prevStatusActive} → ${t.newStatusSimulated} (score ${t.scoreActive?.toFixed(2) ?? "—"} → ${t.scoreSimulated?.toFixed(2) ?? "—"})`);
w();

// ─── Foco em aging — simulação ─────────────────────────────────────────────
w(`## 5. Regra com foco em aging (300/pt, 15 dias/pt, pesos 0,5/2, teto 12) — simulação`);
w();
const focoAging = createDraftRuleSet(db, {
  name: "Foco em aging (simulação)", marginAmountPerPoint: 300, ageDaysPerPoint: 15,
  ageMaxPoints: 12, marginWeight: 0.5, ageWeight: 2, allowNegativeMarginScore: true,
  reason: "Simulação de validação — não ativar",
});
const simA = await simulateMatchRules(db, { ruleSetId: focoAging.id, compareWithActive: true });
w(`- MATCH: ${simA.fullKitsFound} · PARCIAL: ${simA.partialKitsFound} · PEDIR_PEÇA: ${simA.pedirPecaCount} · AGUARDANDO: ${simA.aguardandoCount} · VERIFICAR: ${simA.verificarCount}`);
w(`- Cards que mudariam vs. regra ativa: ${simA.changedComparedToActive} (MATCH completo: ${simA.changedFullMatchMembership}, parcial: ${simA.changedPartialMembership}, posição: ${simA.positionChanges})`);
if (simA.enteringMatch.length) w(`- Ganhariam prioridade (entram em MATCH): ${simA.enteringMatch.map(i => `#${i}`).join(", ")}`);
if (simA.leavingMatch.length) w(`- Perderiam (saem de MATCH): ${simA.leavingMatch.map(i => `#${i}`).join(", ")}`);
w(`- Top mudanças por score:`);
for (const t of simA.topChangedCases) w(`  - #${t.caseId}: ${t.prevStatusActive} → ${t.newStatusSimulated} (score ${t.scoreActive?.toFixed(2) ?? "—"} → ${t.scoreSimulated?.toFixed(2) ?? "—"})`);
w();

// ─── Simulação == motor real ───────────────────────────────────────────────
w(`## 6. Simulação da regra ativa × motor real`);
w();
const simActive = await simulateMatchRules(db, {});
const matches = simActive.fullKitsFound === run2.fullKitsFound
  && simActive.partialKitsFound === run2.partialKitsFound
  && simActive.verificarCount === run2.verificarCount;
w(`- Simulação (mesma função pura): MATCH=${simActive.fullKitsFound}, PARCIAL=${simActive.partialKitsFound}, VERIFICAR=${simActive.verificarCount}`);
w(`- Motor real (última run): MATCH=${run2.fullKitsFound}, PARCIAL=${run2.partialKitsFound}, VERIFICAR=${run2.verificarCount}`);
w(`- **${matches ? "IDÊNTICOS ✓" : "DIVERGENTES ✗ — investigar"}**`);
w();
w(`> As regras "Regra 1 (spec)", "Foco em margem" e "Foco em aging" foram criadas apenas como RASCUNHO nesta cópia para simulação — nada foi ativado, e o banco beta real não foi alterado.`);

db.close();

const reportPath = "docs/MATCH_BETA_VALIDATION.md";
fs.writeFileSync(reportPath, out.join("\n") + "\n", "utf8");
console.log(out.join("\n"));
console.log(`\n[relatório salvo em ${reportPath}]`);
