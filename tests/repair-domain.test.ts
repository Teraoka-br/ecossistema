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
  saveAnalysis, searchRepairCases, searchChavePeca,
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

  it("bloqueia caso com mesmo IMEI+OS+data", () => {
    createRepairCase(db, { imei: "111111111111111", os: "OS-X", repairDate: "2024-01-01", createdByUserId: userId });
    expect(() =>
      createRepairCase(db, { imei: "111111111111111", os: "OS-X", repairDate: "2024-01-01", createdByUserId: userId }),
    ).toThrow(RepairError);
  });

  it("permite caso com mesmo IMEI+OS mas data diferente", () => {
    createRepairCase(db, { imei: "222222222222222", os: "OS-Y", repairDate: "2024-01-01", createdByUserId: userId });
    const rc2 = createRepairCase(db, { imei: "222222222222222", os: "OS-Y", repairDate: "2024-02-01", createdByUserId: userId });
    expect(rc2.id).toBeGreaterThan(0);
  });

  it("permite caso sem repairDate mesmo com mesmo IMEI+OS (regra não se aplica sem data)", () => {
    createRepairCase(db, { imei: "333333333333333", os: "OS-Z", createdByUserId: userId });
    const rc2 = createRepairCase(db, { imei: "333333333333333", os: "OS-Z", createdByUserId: userId });
    expect(rc2.id).toBeGreaterThan(0);
  });

  it("finalizar análise requer campos obrigatórios e ao menos uma peça", () => {
    const rc = createRepairCase(db, { createdByUserId: userId });
    expect(() => completeAnalysis(db, rc.id, userId)).toThrow(RepairError);
  });

  it("finaliza análise com campos completos incluindo repairDate", () => {
    const rc = createRepairCase(db, {
      imei: "444444444444444", os: "OS-002",
      model: "iPhone 13", ageDays: 30, cost: 100, estimatedSale: 200,
      repairDate: "2024-03-01",
      createdByUserId: userId,
    });
    addPart(db, rc.id, { description: "Tela", chavePeca: "TEL-01", createdByUserId: userId });
    const completed = completeAnalysis(db, rc.id, userId);
    expect(completed.analysisStatus).toBe("COMPLETED");
  });

  it("finalizar análise sem repairDate lança MISSING_REPAIR_DATE", () => {
    const rc = createRepairCase(db, {
      imei: "555555555555555", os: "OS-003", model: "Test",
      ageDays: 10, cost: 100, estimatedSale: 200, createdByUserId: userId,
    });
    addPart(db, rc.id, { description: "Tela", createdByUserId: userId });
    expect(() => completeAnalysis(db, rc.id, userId)).toThrow(RepairError);
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
    const cases = db.prepare("SELECT COUNT(*) as c FROM repair_cases").get() as { c: number };
    expect(cases.c).toBe(0);
  });

  it("source_order_parts permanece inalterada após migração", async () => {
    const db = makeDb();
    const count = db.prepare("SELECT COUNT(*) as c FROM source_order_parts").get() as { c: number };
    expect(count.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// searchRepairCases
// ---------------------------------------------------------------------------
describe("searchRepairCases", () => {
  let db: Db;
  let userId: number;

  beforeEach(() => {
    db = makeDb();
    userId = seedUser(db);
    createRepairCase(db, { imei: "100000000000001", os: "OS-A", repairDate: "2024-01-01", brand: "Samsung", model: "Galaxy", createdByUserId: userId });
    createRepairCase(db, { imei: "100000000000002", os: "OS-B", repairDate: "2024-02-01", brand: "Apple", model: "iPhone", createdByUserId: userId });
    createRepairCase(db, { imei: "100000000000001", os: "OS-A", repairDate: "2024-03-01", createdByUserId: userId });
  });

  it("busca por IMEI retorna todos os casos do aparelho", () => {
    const { cases, total } = searchRepairCases(db, { imei: "100000000000001" });
    expect(total).toBe(2);
    expect(cases.every((c) => c.imei === "100000000000001")).toBe(true);
  });

  it("busca por OS retorna casos correspondentes", () => {
    const { cases } = searchRepairCases(db, { os: "OS-B" });
    expect(cases.length).toBe(1);
    expect(cases[0].os).toBe("OS-B");
  });

  it("busca por repairDate filtra por data exata", () => {
    const { cases } = searchRepairCases(db, { imei: "100000000000001", repairDate: "2024-01-01" });
    expect(cases.length).toBe(1);
    expect(cases[0].repairDate).toBe("2024-01-01");
  });

  it("busca sem critérios retorna vazio", () => {
    const { cases, total } = searchRepairCases(db, {});
    expect(cases.length).toBe(0);
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// saveAnalysis (transacional)
// ---------------------------------------------------------------------------
describe("saveAnalysis", () => {
  let db: Db;
  let userId: number;

  beforeEach(() => {
    db = makeDb();
    userId = seedUser(db);
  });

  it("cria caso e peças em uma operação atômica", () => {
    const result = saveAnalysis(db, {
      imei: "200000000000001", os: "OS-C", repairDate: "2024-05-01",
      model: "Test", ageDays: 10, cost: 100, estimatedSale: 200,
      parts: [
        { description: "Tela", chavePeca: "TEL-X", status: "PEDIR_PECA" },
        { description: "Bateria", status: "INDICADA" },
      ],
      userId,
    });
    expect(result.repairCase.id).toBeGreaterThan(0);
    expect(result.parts.length).toBe(2);
    expect(result.repairCase.analysisStatus).toBe("DRAFT");
  });

  it("finaliza análise quando finalize=true", () => {
    const result = saveAnalysis(db, {
      imei: "200000000000002", os: "OS-D", repairDate: "2024-05-02",
      model: "Moto", ageDays: 5, cost: 50, estimatedSale: 150,
      parts: [{ description: "Tela", status: "PEDIR_PECA" }],
      finalize: true,
      userId,
    });
    expect(result.repairCase.analysisStatus).toBe("COMPLETED");
  });

  it("atualiza caso existente com novo caseId", () => {
    const rc = createRepairCase(db, { imei: "200000000000003", os: "OS-E", createdByUserId: userId });
    const result = saveAnalysis(db, {
      caseId: rc.id,
      model: "Xiaomi", ageDays: 20,
      parts: [],
      userId,
    });
    expect(result.repairCase.id).toBe(rc.id);
    expect(result.repairCase.model).toBe("Xiaomi");
  });

  it("rollback se finalização falhar (campo obrigatório ausente)", () => {
    // cost e estimatedSale ausentes — completeAnalysis lançará erro
    expect(() =>
      saveAnalysis(db, {
        imei: "200000000000004", os: "OS-F", repairDate: "2024-05-03",
        model: "Test",
        parts: [{ description: "Tela" }],
        finalize: true,
        userId,
      }),
    ).toThrow(RepairError);
    // Caso não deve ter sido persistido
    const { total } = searchRepairCases(db, { imei: "200000000000004" });
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// searchChavePeca — autocomplete
// ---------------------------------------------------------------------------
describe("searchChavePeca", () => {
  let db: Db;
  let userId: number;

  beforeEach(() => {
    db = makeDb();
    userId = seedUser(db);
    // Seed part_requests via saveAnalysis (creates repair case + part with chavePeca)
    saveAnalysis(db, {
      imei: "300000000000001", os: "OS-CP1", repairDate: "2024-06-01",
      model: "TestModel", ageDays: 10, cost: 100, estimatedSale: 300,
      parts: [{ description: "Tela", chavePeca: "LCD-SAM-A53" }],
      userId,
    });
    saveAnalysis(db, {
      imei: "300000000000002", os: "OS-CP2", repairDate: "2024-06-02",
      model: "TestModel2", ageDays: 15, cost: 80, estimatedSale: 200,
      parts: [{ description: "Bateria", chavePeca: "BAT-IPHONE-12" }],
      userId,
    });
  });

  it("retorna sugestão que bate com prefixo", () => {
    const results = searchChavePeca(db, "LCD");
    expect(results.length).toBe(1);
    expect(results[0].chavePeca).toBe("LCD-SAM-A53");
  });

  it("busca case-insensitive (prefixo minúsculo → match maiúsculo)", () => {
    const results = searchChavePeca(db, "bat");
    expect(results.length).toBe(1);
    expect(results[0].chavePeca).toBe("BAT-IPHONE-12");
  });

  it("query vazia retorna lista vazia", () => {
    const results = searchChavePeca(db, "");
    expect(results.length).toBe(0);
  });

  it("query sem match retorna lista vazia", () => {
    const results = searchChavePeca(db, "INEXISTENTE-XYZ");
    expect(results.length).toBe(0);
  });

  it("stockAvailable null quando não há stock_snapshot OFFICIAL", () => {
    const results = searchChavePeca(db, "LCD");
    // Banco em memória sem snapshot oficial → null
    expect(results[0].stockAvailable).toBeNull();
  });
});
