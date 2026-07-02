/**
 * Testes de staff (técnicos).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import { listStaff, createStaff, updateStaff, StaffError } from "../src/staff/staff-service.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

describe("CRUD de técnicos", () => {
  let db: Db;
  beforeEach(() => { db = makeDb(); });

  it("cria técnico com tipo padrão TECHNICIAN", () => {
    const s = createStaff(db, { name: "João" });
    expect(s.type).toBe("TECHNICIAN");
    expect(s.active).toBe(true);
  });

  it("lista técnicos", () => {
    createStaff(db, { name: "Maria" });
    createStaff(db, { name: "Pedro" });
    expect(listStaff(db).length).toBe(2);
  });

  it("edita nome", () => {
    const s = createStaff(db, { name: "Carlos" });
    const updated = updateStaff(db, s.id, { name: "Carlos Silva" });
    expect(updated.name).toBe("Carlos Silva");
  });

  it("desativa técnico (não exclui)", () => {
    const s = createStaff(db, { name: "Ana" });
    updateStaff(db, s.id, { active: false });
    const all = listStaff(db);
    const found = all.find((x) => x.id === s.id);
    expect(found?.active).toBe(false);
  });

  it("erro quando técnico não existe", () => {
    expect(() => updateStaff(db, 9999, { name: "X" })).toThrow(StaffError);
  });

  it("erro quando nome vazio", () => {
    expect(() => createStaff(db, { name: "" })).toThrow(StaffError);
  });
});
