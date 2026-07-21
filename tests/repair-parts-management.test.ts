/**
 * 18 testes de gerenciamento de peças em casos existentes.
 * Cobre addPart, updatePart, cancelPart e regras de negócio associadas.
 * Usa banco em memória — nunca toca data/app.sqlite.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import {
  createRepairCase, addPart, updatePart, cancelPart,
  getRepairCaseWithParts, RepairError,
} from "../src/repair/repair-service.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

function seedUser(db: Db): number {
  return (db.prepare(
    "INSERT INTO users (username, display_name, pin_hash, role) VALUES ('op','Operador','x','OPERATOR')"
  ).run()).lastInsertRowid as number;
}

function seedCase(db: Db, userId: number, overrides: Record<string, unknown> = {}) {
  return createRepairCase(db, {
    imei: `IMEI${Date.now()}${Math.random()}`,
    os: null,
    createdByUserId: userId,
    ...overrides,
  });
}

// ─── addPart ──────────────────────────────────────────────────────────────────

describe("addPart", () => {
  let db: Db;
  let userId: number;

  beforeEach(() => { db = makeDb(); userId = seedUser(db); });

  it("adiciona peça com description e chavePeca", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Tela", chavePeca: "TELA A32", createdByUserId: userId });
    expect(p.id).toBeGreaterThan(0);
    expect(p.chavePeca).toBe("TELA A32");
    expect(p.description).toBe("Tela");
  });

  it("armazena chavePeca exatamente como passado (normalização é responsabilidade do chamador)", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Bateria", chavePeca: "BATERIA A32", createdByUserId: userId });
    expect(p.chavePeca).toBe("BATERIA A32");
  });

  it("permite adicionar múltiplas peças ao mesmo caso", () => {
    const rc = seedCase(db, userId);
    addPart(db, rc.id, { description: "Tela", chavePeca: "TELA A32", createdByUserId: userId });
    addPart(db, rc.id, { description: "Bateria", chavePeca: "BATERIA A32", createdByUserId: userId });
    const detail = getRepairCaseWithParts(db, rc.id);
    expect(detail?.parts.length).toBe(2);
  });

  it("lança NOT_FOUND para caso inexistente", () => {
    expect(() =>
      addPart(db, 99999, { description: "Tela", chavePeca: "TELA", createdByUserId: userId })
    ).toThrow(RepairError);
  });

  it("nova peça nasce com status PEDIR_PECA", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Tela", chavePeca: "TELA", createdByUserId: userId });
    expect(p.status).toBe("PEDIR_PECA");
  });

  it("permite adicionar peça sem chavePeca (só description)", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Peça genérica", createdByUserId: userId });
    expect(p.id).toBeGreaterThan(0);
    expect(p.description).toBe("Peça genérica");
  });

  it("chave_peca_norm é gerado automaticamente pelo serviço a partir de chavePeca", () => {
    const rc = seedCase(db, userId);
    addPart(db, rc.id, { description: "Tela", chavePeca: "ALTO FALANTE A54", createdByUserId: userId });
    const row = db.prepare("SELECT chave_peca_norm FROM part_requests WHERE repair_case_id=?").get(rc.id) as { chave_peca_norm: string };
    expect(row.chave_peca_norm).toBeTruthy();
  });

  it("permite adicionar peça mesmo em caso CONCLUIDO (validação de negócio é no route handler)", () => {
    const rc = seedCase(db, userId);
    db.prepare("UPDATE repair_cases SET workflow_status='CONCLUIDO' WHERE id=?").run(rc.id);
    // addPart não bloqueia por workflow_status; a restrição fica no endpoint
    const p = addPart(db, rc.id, { description: "Tela", chavePeca: "TELA", createdByUserId: userId });
    expect(p.id).toBeGreaterThan(0);
  });
});

// ─── updatePart ───────────────────────────────────────────────────────────────

describe("updatePart", () => {
  let db: Db;
  let userId: number;

  beforeEach(() => { db = makeDb(); userId = seedUser(db); });

  it("atualiza chavePeca de peça existente", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Tela", chavePeca: "TELA A32", createdByUserId: userId });
    const updated = updatePart(db, p.id, { chavePeca: "TELA A32 PRETA", updatedByUserId: userId });
    expect(updated.chavePeca).toBe("TELA A32 PRETA");
  });

  it("atualiza description de peça", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Bateria original", createdByUserId: userId });
    const updated = updatePart(db, p.id, { description: "Bateria compatível", updatedByUserId: userId });
    expect(updated.description).toBe("Bateria compatível");
  });

  it("lança NOT_FOUND para peça inexistente", () => {
    expect(() =>
      updatePart(db, 99999, { chavePeca: "TELA", updatedByUserId: userId })
    ).toThrow(RepairError);
  });

  it("não permite editar peça já cancelada", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Tela", chavePeca: "TELA", createdByUserId: userId });
    cancelPart(db, p.id, userId);
    expect(() =>
      updatePart(db, p.id, { chavePeca: "TELA NOVA", updatedByUserId: userId })
    ).toThrow(RepairError);
  });

  it("getRepairCaseWithParts reflete a edição", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Tela", chavePeca: "TELA A54", createdByUserId: userId });
    updatePart(db, p.id, { chavePeca: "TELA A54 PRETA", updatedByUserId: userId });
    const detail = getRepairCaseWithParts(db, rc.id);
    const found = detail?.parts.find(pr => pr.id === p.id);
    expect(found?.chavePeca).toBe("TELA A54 PRETA");
  });
});

// ─── cancelPart ───────────────────────────────────────────────────────────────

describe("cancelPart", () => {
  let db: Db;
  let userId: number;

  beforeEach(() => { db = makeDb(); userId = seedUser(db); });

  it("cancela peça e muda status para CANCELADA", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Tela", chavePeca: "TELA", createdByUserId: userId });
    const cancelled = cancelPart(db, p.id, userId);
    expect(cancelled.status).toBe("CANCELADA");
  });

  it("lança NOT_FOUND para peça inexistente", () => {
    expect(() => cancelPart(db, 99999, userId)).toThrow(RepairError);
  });

  it("cancelar peça já cancelada é idempotente (retorna a peça sem lançar erro)", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Tela", createdByUserId: userId });
    cancelPart(db, p.id, userId);
    const result = cancelPart(db, p.id, userId);
    expect(result.status).toBe("CANCELADA");
  });

  it("cancelar peça libera reserva (status da peça muda independente de reserva)", () => {
    const rc = seedCase(db, userId);
    const p = addPart(db, rc.id, { description: "Tela", chavePeca: "TELA", createdByUserId: userId });
    db.prepare("UPDATE part_requests SET status='RESERVADA' WHERE id=?").run(p.id);
    const cancelled = cancelPart(db, p.id, userId);
    expect(cancelled.status).toBe("CANCELADA");
  });

  it("peças canceladas não aparecem em status ativo", () => {
    const rc = seedCase(db, userId);
    addPart(db, rc.id, { description: "Tela", chavePeca: "TELA", createdByUserId: userId });
    const p2 = addPart(db, rc.id, { description: "Bateria", chavePeca: "BATERIA", createdByUserId: userId });
    cancelPart(db, p2.id, userId);
    const detail = getRepairCaseWithParts(db, rc.id);
    const active = detail?.parts.filter(p => p.status !== "CANCELADA") ?? [];
    expect(active).toHaveLength(1);
    expect(active[0].chavePeca).toBe("TELA");
  });
});
