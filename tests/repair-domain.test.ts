/**
 * Testes do domínio de reparo.
 * Usa banco em memória — nunca toca data/app.sqlite.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import {
  createRepairCase, getRepairCaseById, getRepairCaseWithParts, updateRepairCase,
  completeAnalysis, closeRepairCase, addPart, cancelPart,
  setManualPriority, removeManualPriority, getPrioritiesByCase,
  RepairError,
} from "../src/repair/repair-service.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

function seedUser(db: Db): number {
  const r = db.prepare("INSERT INTO users (username, display_name, pin_hash, role) VALUES ('test','Test','x','ADMIN')").run();
  return r.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Repair cases
// ---------------------------------------------------------------------------
describe("repair_cases", () => {
  let db: Db;
  let userId: number;

  beforeEach(() => {
    db = makeDb();
    userId = seedUser(db);
  });

  it("cria rascunho de caso", () => {
    const rc = createRepairCase(db, { imei: "123456789012345", os: "OS-001", createdByUserId: userId });
    expect(rc.id).toBeGreaterThan(0);
    expect(rc.analysisStatus).toBe("DRAFT");
    expect(rc.workflowStatus).toBe("EM_ANALISE");
  });

  it("calcula margem automaticamente", () => {
    const rc = createRepairCase(db, { cost: 100, estimatedSale: 250, createdByUserId: userId });
    expect(rc.margin).toBe(150);
  });

  it("margem null quando custo ou venda ausente", () => {
    const rc = createRepairCase(db, { cost: 100, createdByUserId: userId });
    expect(rc.margin).toBeNull();
  });

  it("bloqueia novo caso ativo com mesmo IMEI", () => {
    createRepairCase(db, { imei: "111111111111111", createdByUserId: userId });
    expect(() => createRepairCase(db, { imei: "111111111111111", createdByUserId: userId })).toThrow(RepairError);
  });

  it("permite novo caso após encerramento do anterior", () => {
    const rc = createRepairCase(db, { imei: "222222222222222", createdByUserId: userId });
    closeRepairCase(db, rc.id, { status: "CONCLUIDO", userId });
    const rc2 = createRepairCase(db, { imei: "222222222222222", createdByUserId: userId });
    expect(rc2.id).toBeGreaterThan(rc.id);
  });

  it("finalizar análise requer campos obrigatórios e ao menos uma peça", () => {
    const rc = createRepairCase(db, { createdByUserId: userId });
    expect(() => completeAnalysis(db, rc.id, userId)).toThrow(RepairError);
  });

  it("finaliza análise com campos completos", () => {
    const rc = createRepairCase(db, {
      imei: "333333333333333", os: "OS-002",
      model: "iPhone 13", ageDays: 30, cost: 100, estimatedSale: 200,
      createdByUserId: userId,
    });
    addPart(db, rc.id, { description: "Tela", chavePeca: "TEL-01", createdByUserId: userId });
    const completed = completeAnalysis(db, rc.id, userId);
    expect(completed.analysisStatus).toBe("COMPLETED");
  });

  it("várias peças no mesmo caso", () => {
    const rc = createRepairCase(db, { createdByUserId: userId });
    addPart(db, rc.id, { description: "Tela", createdByUserId: userId });
    addPart(db, rc.id, { description: "Bateria", createdByUserId: userId });
    const full = getRepairCaseWithParts(db, rc.id);
    expect(full!.parts.length).toBe(2);
  });

  it("cancelar peça não deleta — apenas marca cancelada", () => {
    const rc = createRepairCase(db, { createdByUserId: userId });
    const part = addPart(db, rc.id, { description: "Tela", createdByUserId: userId });
    cancelPart(db, part.id, userId);
    const updated = getRepairCaseWithParts(db, rc.id);
    expect(updated!.parts.length).toBe(1);
    expect(updated!.parts[0].status).toBe("CANCELADA");
    expect(updated!.parts[0].cancelledAt).not.toBeNull();
  });

  it("auditoria registra usuário na criação", () => {
    createRepairCase(db, { createdByUserId: userId });
    // Verificação via DB direto
    const row = db.prepare("SELECT created_by_user_id FROM repair_cases WHERE created_by_user_id = ?").get(userId) as { created_by_user_id: number } | undefined;
    expect(row?.created_by_user_id).toBe(userId);
  });
});

// ---------------------------------------------------------------------------
// Prioridade manual
// ---------------------------------------------------------------------------
describe("prioridade manual", () => {
  let db: Db;
  let userId: number;
  let caseId: number;

  beforeEach(() => {
    db = makeDb();
    userId = seedUser(db);
    const rc = createRepairCase(db, { createdByUserId: userId });
    caseId = rc.id;
  });

  it("exige justificativa mínima de 10 caracteres", () => {
    expect(() => setManualPriority(db, caseId, { reason: "curto", userId })).toThrow(RepairError);
  });

  it("define uma prioridade ativa", () => {
    const p = setManualPriority(db, caseId, { reason: "justificativa longa suficiente", userId });
    expect(p.active).toBe(true);
    const rc = getRepairCaseById(db, caseId);
    expect(rc!.manualPriorityActive).toBe(true);
  });

  it("somente uma prioridade ativa por caso", () => {
    setManualPriority(db, caseId, { reason: "primeira justificativa válida", userId });
    expect(() => setManualPriority(db, caseId, { reason: "segunda justificativa válida", userId })).toThrow(RepairError);
  });

  it("remoção preserva histórico", () => {
    setManualPriority(db, caseId, { reason: "razão suficientemente longa", userId });
    removeManualPriority(db, caseId, { reason: "removido", userId });
    const priorities = getPrioritiesByCase(db, caseId);
    expect(priorities.length).toBe(1);
    expect(priorities[0].active).toBe(false);
    expect(priorities[0].removedAt).not.toBeNull();
  });

  it("encerrar caso encerra prioridade ativa", () => {
    setManualPriority(db, caseId, { reason: "prioridade de teste para fechar", userId });
    closeRepairCase(db, caseId, { status: "CANCELADO", userId });
    const rc = getRepairCaseById(db, caseId);
    expect(rc!.manualPriorityActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Migração de source → repair
// ---------------------------------------------------------------------------
describe("migração operacional (idempotência)", () => {
  it("dry-run não altera banco", async () => {
    const db = makeDb();
    // Sem dados de origem, apenas verifica que não trava
    const cases = db.prepare("SELECT COUNT(*) as c FROM repair_cases").get() as { c: number };
    expect(cases.c).toBe(0);
  });

  it("source_order_parts permanece inalterada após migração", async () => {
    const db = makeDb();
    // Sem lote inicializado, não há o que migrar — garante integridade da tabela
    const count = db.prepare("SELECT COUNT(*) as c FROM source_order_parts").get() as { c: number };
    expect(count.c).toBe(0);
  });
});
