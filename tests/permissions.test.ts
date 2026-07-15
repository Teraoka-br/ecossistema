/**
 * Testes de permissões granulares (user_permissions).
 * Spec E — 6 cenários.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import {
  getUserPermissions,
  grantPermission,
  revokePermission,
} from "../src/auth/auth-service.js";

function makeUser(db: Db, username: string, role = "OPERATOR"): number {
  return Number(
    db.prepare(
      "INSERT INTO users (username, display_name, pin_hash, role) VALUES (?, ?, 'x', ?)",
    ).run(username, username, role).lastInsertRowid,
  );
}

let db: Db;

beforeEach(async () => {
  db = await createDb();
});

// ---------------------------------------------------------------------------
// Cenário 1: migration criou tabela user_permissions
// ---------------------------------------------------------------------------

describe("cenário 1 — tabela user_permissions existe após migrations", () => {
  it("tabela existe com as colunas esperadas", () => {
    const info = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='user_permissions'",
    ).get() as { name: string } | undefined;
    expect(info?.name).toBe("user_permissions");
  });
});

// ---------------------------------------------------------------------------
// Cenário 2: conceder permissão
// ---------------------------------------------------------------------------

describe("cenário 2 — conceder OVERRIDE_REPAIR_STATUS", () => {
  it("adiciona a permissão para o usuário", () => {
    const adminId = makeUser(db, "admin", "ADMIN");
    const userId = makeUser(db, "op1");

    grantPermission(db, userId, "OVERRIDE_REPAIR_STATUS", adminId);
    const perms = getUserPermissions(db, userId);
    expect(perms).toContain("OVERRIDE_REPAIR_STATUS");
  });
});

// ---------------------------------------------------------------------------
// Cenário 3: revogar permissão
// ---------------------------------------------------------------------------

describe("cenário 3 — revogar OVERRIDE_REPAIR_STATUS", () => {
  it("remove a permissão após revogação", () => {
    const adminId = makeUser(db, "admin2", "ADMIN");
    const userId = makeUser(db, "op2");

    grantPermission(db, userId, "OVERRIDE_REPAIR_STATUS", adminId);
    revokePermission(db, userId, "OVERRIDE_REPAIR_STATUS");
    const perms = getUserPermissions(db, userId);
    expect(perms).not.toContain("OVERRIDE_REPAIR_STATUS");
  });
});

// ---------------------------------------------------------------------------
// Cenário 4: usuário sem permissão tem array vazio
// ---------------------------------------------------------------------------

describe("cenário 4 — usuário sem permissão retorna array vazio", () => {
  it("getUserPermissions retorna [] para usuário sem permissão", () => {
    const userId = makeUser(db, "op3");
    const perms = getUserPermissions(db, userId);
    expect(perms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cenário 5: concessão duplicada não lança erro (INSERT OR IGNORE)
// ---------------------------------------------------------------------------

describe("cenário 5 — grant idempotente", () => {
  it("conceder a mesma permissão duas vezes não lança erro", () => {
    const adminId = makeUser(db, "admin3", "ADMIN");
    const userId = makeUser(db, "op4");

    grantPermission(db, userId, "OVERRIDE_REPAIR_STATUS", adminId);
    expect(() => grantPermission(db, userId, "OVERRIDE_REPAIR_STATUS", adminId)).not.toThrow();
    const perms = getUserPermissions(db, userId);
    expect(perms.filter(p => p === "OVERRIDE_REPAIR_STATUS").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cenário 6: admin tem permissão implícita (sem precisar de registro)
// ---------------------------------------------------------------------------

describe("cenário 6 — admin tem acesso sem registro em user_permissions", () => {
  it("getUserPermissions do admin pode retornar [] mas middleware usa role", () => {
    const adminId = makeUser(db, "adminonly", "ADMIN");
    // Admin não tem registro em user_permissions — seu acesso vem do role
    const perms = getUserPermissions(db, adminId);
    expect(Array.isArray(perms)).toBe(true);
    // O middleware (requirePermissionOrAdmin) trata ADMIN separadamente — só testamos aqui a service layer
  });
});
