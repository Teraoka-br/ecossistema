/**
 * Testes de compatibilidade simétrica de chave de peça no motor e simulador.
 * Substituem os testes de aliases direcionais (migration 039 — grupos simétricos).
 * Spec F — 10 cenários adaptados.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import { runRepairMatchEngine } from "../src/match/engine-orchestrator.js";
import { simulateMatchRules } from "../src/match/simulate-service.js";
import {
  createCompatibilityGroup,
  addGroupMember,
} from "../src/operational/part-compatibility-service.js";

let db: Db;

beforeEach(async () => {
  db = await createDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addCase(imei = "IMEI-001", opts: { deposito?: string } = {}): number {
  const r = db.prepare(`
    INSERT INTO repair_cases
      (imei, imei_norm, model, workflow_status, analysis_status, deposito_atual,
       age_days, cost, estimated_sale, margin, created_at, updated_at)
    VALUES (?, ?, 'MODELO TESTE', 'PEDIR_PECA', 'COMPLETED', ?, 100, 0, 200, 200, datetime('now'), datetime('now'))
  `).run(imei, imei.toLowerCase(), opts.deposito ?? "AGUARDANDO PECA");
  return Number(r.lastInsertRowid);
}

function addPart(caseId: number, chaveNorm: string): number {
  const r = db.prepare(`
    INSERT INTO part_requests (repair_case_id, chave_peca, chave_peca_norm, status, created_at, updated_at)
    VALUES (?, ?, ?, 'PEDIR_PECA', datetime('now'), datetime('now'))
  `).run(caseId, chaveNorm, chaveNorm);
  return Number(r.lastInsertRowid);
}

function addStock(chaveNorm: string, qty: number): void {
  const ref = `REF-${chaveNorm.replace(/\s+/g, "-")}`;
  const refNorm = ref.toLowerCase();
  const sessId = db.prepare(`
    INSERT INTO count_sessions (responsible_name, status, started_at, finished_at)
    VALUES ('sistema', 'FINALIZED', datetime('now'), datetime('now'))
  `).run().lastInsertRowid;
  const snapId = db.prepare(`
    INSERT INTO stock_snapshots (count_session_id, status, total_units, created_at, baseline_movement_id_max)
    VALUES (?, 'OFFICIAL', ?, datetime('now'), 0)
  `).run(sessId, qty).lastInsertRowid;
  db.prepare(`
    INSERT INTO stock_snapshot_items (snapshot_id, reference, reference_norm, chave_peca, chave_peca_norm, counted_quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(snapId, ref, refNorm, chaveNorm.toUpperCase(), chaveNorm, qty);
}

/** Cria grupo de compatibilidade com dois membros. */
function addGroupCompat(keyA: string, keyB: string): void {
  const g = createCompatibilityGroup(db, { name: `${keyA} ↔ ${keyB}` });
  addGroupMember(db, g.id, { chavePeca: keyA });
  addGroupMember(db, g.id, { chavePeca: keyB });
}

// ---------------------------------------------------------------------------
// Cenário 1: sem grupo, sem estoque → nenhum match
// ---------------------------------------------------------------------------

describe("cenário 1 — sem grupo, sem estoque correspondente", () => {
  it("não produz match quando chave_peca_norm não existe no estoque e não há grupo", async () => {
    const c = addCase();
    addPart(c, "BATERIA IPHONE 12");
    addStock("BATERIA IPHONE 12 PRO", 3); // chave diferente, sem grupo

    const result = await runRepairMatchEngine(db);
    const row = db.prepare(
      "SELECT result_status, alias_stock_chave_norm FROM repair_match_results WHERE repair_case_id = ?",
    ).get(c) as { result_status: string; alias_stock_chave_norm: string | null } | undefined;
    expect(row?.result_status).not.toBe("MATCH");
    expect(row?.alias_stock_chave_norm).toBeNull();
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cenário 2: com grupo → MATCH via membro compatível
// ---------------------------------------------------------------------------

describe("cenário 2 — grupo mapeia chave solicitada para chave do estoque", () => {
  it("produz MATCH via grupo de compatibilidade simétrica", async () => {
    addStock("BATERIA IPHONE 12 PRO", 2);
    addGroupCompat("BATERIA IPHONE 12", "BATERIA IPHONE 12 PRO");
    const c = addCase();
    addPart(c, "BATERIA IPHONE 12");

    await runRepairMatchEngine(db);
    const row = db.prepare(
      "SELECT result_status, alias_stock_chave_norm FROM repair_match_results WHERE repair_case_id = ?",
    ).get(c) as { result_status: string; alias_stock_chave_norm: string | null };
    expect(row.result_status).toBe("MATCH");
    expect(row.alias_stock_chave_norm).toBe("BATERIA IPHONE 12 PRO");
  });
});

// ---------------------------------------------------------------------------
// Cenário 3: grupo deduz estoque do membro corretamente
// ---------------------------------------------------------------------------

describe("cenário 3 — grupo deduz do estoque do membro compatível", () => {
  it("esgota o estoque do membro após alocação via grupo", async () => {
    addStock("TELA SAMSUNG A32", 1);
    addGroupCompat("DISPLAY A32", "TELA SAMSUNG A32");

    const c1 = addCase("IMEI-A1");
    addPart(c1, "DISPLAY A32");
    const c2 = addCase("IMEI-A2");
    addPart(c2, "DISPLAY A32");

    await runRepairMatchEngine(db);
    const rows = db.prepare(
      "SELECT repair_case_id, result_status FROM repair_match_results ORDER BY repair_case_id",
    ).all() as { repair_case_id: number; result_status: string }[];

    const statuses = rows.map(r => r.result_status);
    expect(statuses.filter(s => s === "MATCH").length).toBe(1);
    expect(statuses.filter(s => s !== "MATCH").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cenário 4: membro removido do grupo não é usado
// ---------------------------------------------------------------------------

describe("cenário 4 — membro inativo (removed_at) não produz match", () => {
  it("não resolve via grupo quando membro foi removido", async () => {
    addStock("BATERIA MODELO X", 2);
    // Insere membro já removido diretamente (sem usar o service)
    const g = db.prepare("INSERT INTO part_compatibility_groups (name) VALUES ('G4')").run();
    db.prepare(`
      INSERT INTO part_compatibility_group_members
        (group_id, chave_peca, chave_peca_norm, removed_at)
      VALUES (?, 'BAT X OLD', 'BAT X OLD', datetime('now'))
    `).run(g.lastInsertRowid);
    db.prepare(`
      INSERT INTO part_compatibility_group_members
        (group_id, chave_peca, chave_peca_norm)
      VALUES (?, 'BATERIA MODELO X', 'BATERIA MODELO X')
    `).run(g.lastInsertRowid);

    const c = addCase();
    addPart(c, "BAT X OLD");

    await runRepairMatchEngine(db);
    // Com apenas 1 membro ativo no grupo (BATERIA MODELO X), BAT X OLD não pertence
    // a nenhum grupo ativo — sem match.
    const row = db.prepare(
      "SELECT result_status FROM repair_match_results WHERE repair_case_id = ?",
    ).get(c) as { result_status: string } | undefined;
    expect(row?.result_status).not.toBe("MATCH");
  });
});

// ---------------------------------------------------------------------------
// Cenário 5: repair_match_results grava alias_stock_chave_norm
// ---------------------------------------------------------------------------

describe("cenário 5 — alias_stock_chave_norm gravado quando grupo é usado", () => {
  it("campo alias_stock_chave_norm é preenchido quando alocação usa membro do grupo", async () => {
    addStock("CONECTOR CARGA A53", 5);
    addGroupCompat("FLEX CARGA A53", "CONECTOR CARGA A53");
    const c = addCase();
    addPart(c, "FLEX CARGA A53");

    await runRepairMatchEngine(db);
    const row = db.prepare(
      "SELECT alias_stock_chave_norm FROM repair_match_results WHERE repair_case_id = ?",
    ).get(c) as { alias_stock_chave_norm: string | null };
    expect(row.alias_stock_chave_norm).toBe("CONECTOR CARGA A53");
  });
});

// ---------------------------------------------------------------------------
// Cenário 6: alocação direta não preenche alias_stock_chave_norm
// ---------------------------------------------------------------------------

describe("cenário 6 — alocação direta deixa alias_stock_chave_norm nulo", () => {
  it("campo alias_stock_chave_norm é NULL em alocação sem compatibilidade", async () => {
    addStock("BATERIA DIRETA", 3);
    const c = addCase();
    addPart(c, "BATERIA DIRETA");

    await runRepairMatchEngine(db);
    const row = db.prepare(
      "SELECT result_status, alias_stock_chave_norm FROM repair_match_results WHERE repair_case_id = ?",
    ).get(c) as { result_status: string; alias_stock_chave_norm: string | null };
    expect(row.result_status).toBe("MATCH");
    expect(row.alias_stock_chave_norm).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cenário 7: kit completo com grupo em múltiplas peças
// ---------------------------------------------------------------------------

describe("cenário 7 — kit completo via grupo em múltiplas peças", () => {
  it("MATCH em kit de 2 peças ambas via grupo de compatibilidade", async () => {
    addStock("TELA X10", 1);
    addStock("CONECTOR X10", 1);
    addGroupCompat("DISPLAY X10", "TELA X10");
    addGroupCompat("FLEX X10", "CONECTOR X10");

    const c = addCase();
    addPart(c, "DISPLAY X10");
    addPart(c, "FLEX X10");

    await runRepairMatchEngine(db);
    const rows = db.prepare(
      "SELECT result_status, alias_stock_chave_norm FROM repair_match_results WHERE repair_case_id = ?",
    ).all() as { result_status: string; alias_stock_chave_norm: string | null }[];
    expect(rows.every(r => r.result_status === "MATCH")).toBe(true);
    expect(rows.every(r => r.alias_stock_chave_norm !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cenário 8: simulação dry-run segura (não altera banco)
// ---------------------------------------------------------------------------

describe("cenário 8 — simulação dry-run não persiste dados", () => {
  it("simulate não cria repair_match_results", async () => {
    addStock("BATERIA SIM", 2);
    addGroupCompat("BAT SIM", "BATERIA SIM");
    const c = addCase();
    addPart(c, "BAT SIM");

    await simulateMatchRules(db, {});

    const count = (db.prepare("SELECT COUNT(*) as c FROM repair_match_results").get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cenário 9: simulação reporta fullKitsFound via grupo
// ---------------------------------------------------------------------------

describe("cenário 9 — simulação conta kits resolvidos via grupo", () => {
  it("fullKitsFound > 0 quando grupo viabiliza o kit", async () => {
    addStock("TELA SIM-TEST", 3);
    addGroupCompat("DISPLAY SIM-TEST", "TELA SIM-TEST");
    const c = addCase();
    addPart(c, "DISPLAY SIM-TEST");

    const result = await simulateMatchRules(db, {});
    expect(result.fullKitsFound).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Cenário 10: motor e simulador concordam nos resultados
// ---------------------------------------------------------------------------

describe("cenário 10 — motor e simulador produzem o mesmo status via grupo", () => {
  it("resultado do motor e da simulação concordam", async () => {
    addStock("BATERIA CONCORD", 1);
    addGroupCompat("BAT CONCORD", "BATERIA CONCORD");
    const c = addCase();
    addPart(c, "BAT CONCORD");

    const sim = await simulateMatchRules(db, {});
    await runRepairMatchEngine(db);

    const row = db.prepare(
      "SELECT result_status FROM repair_match_results WHERE repair_case_id = ?",
    ).get(c) as { result_status: string };

    if (sim.fullKitsFound > 0) {
      expect(row.result_status).toBe("MATCH");
    } else {
      expect(row.result_status).not.toBe("MATCH");
    }
  });
});
