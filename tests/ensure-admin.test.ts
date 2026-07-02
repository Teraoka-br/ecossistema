/**
 * Testes do comando ensure-admin e do fluxo de setup.
 * Usa banco em memória — nunca toca data/app.sqlite.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import {
  getUserCount,
  findUserByUsername,
  setupFirstUser,
  createUser,
  updateUser,
  resetUserPin,
  verifyPin,
  hashPin,
  AuthError,
} from "../src/auth/auth-service.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// Lógica de ensure-admin (extraída do script para teste unitário)
// ---------------------------------------------------------------------------
async function ensureAdmin(
  db: Db,
  params: { username: string; displayName: string; pin: string; role?: "ADMIN" | "OPERATOR" },
): Promise<{ created: boolean; userId: number }> {
  const { username, displayName, pin, role = "ADMIN" } = params;
  // Normaliza exatamente como o script faz: trim + toLowerCase
  const usernameLower = username.trim().toLowerCase();
  const existing = findUserByUsername(db, usernameLower);
  if (existing) {
    updateUser(db, existing.id, { displayName: displayName.trim(), role, active: true });
    await resetUserPin(db, existing.id, pin);
    return { created: false, userId: existing.id };
  }
  const count = getUserCount(db);
  let created;
  if (count === 0) {
    created = await setupFirstUser(db, { username, displayName, pin });
  } else {
    created = await createUser(db, { username, displayName, pin, role });
  }
  return { created: true, userId: created.id };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe("ensure-admin: banco vazio", () => {
  let db: Db;
  beforeEach(() => { db = makeDb(); });

  it("cria ADMIN quando banco está vazio", async () => {
    const { created, userId } = await ensureAdmin(db, {
      username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902",
    });
    expect(created).toBe(true);
    // username é normalizado para "fabrício" (trim + toLowerCase)
    const user = findUserByUsername(db, "fabrício")!;
    expect(user).not.toBeNull();
    expect(user.id).toBe(userId);
    expect(user.role).toBe("ADMIN");
  });

  it("usuário criado fica ativo", async () => {
    await ensureAdmin(db, { username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902" });
    const user = findUserByUsername(db, "fabrício")!;
    expect(user.active).toBe(1);
  });

  it("hash não contém o PIN em texto plano", async () => {
    await ensureAdmin(db, { username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902" });
    const row = db
      .prepare("SELECT pin_hash FROM users WHERE username = 'fabrício'")
      .get() as { pin_hash: string };
    expect(row.pin_hash).not.toContain("1902");
    expect(row.pin_hash).toMatch(/^scrypt:/);
  });
});

describe("ensure-admin: usuário já existe", () => {
  let db: Db;

  beforeEach(async () => {
    db = makeDb();
    // Usa exatamente o mesmo username normalizado que o script produziria:
    // "Fabrício".trim().toLowerCase() = "fabrício"
    await setupFirstUser(db, { username: "fabrício", displayName: "Fabricio Antigo", pin: "0000" });
  });

  it("atualiza sem duplicar", async () => {
    const { created } = await ensureAdmin(db, {
      username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902",
    });
    expect(created).toBe(false);
    expect(getUserCount(db)).toBe(1);
  });

  it("usuário atualizado fica ativo", async () => {
    // Cria segundo admin para poder desativar o primeiro sem violar a regra do último admin
    await createUser(db, { username: "admin2", displayName: "Admin 2", pin: "5678", role: "ADMIN" });
    const u = findUserByUsername(db, "fabrício")!;
    updateUser(db, u.id, { active: false });
    await ensureAdmin(db, { username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902" });
    const updated = findUserByUsername(db, "fabrício")!;
    expect(updated.active).toBe(1);
  });

  it("PIN antigo deixa de funcionar após redefinição", async () => {
    await ensureAdmin(db, { username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902" });
    const u = findUserByUsername(db, "fabrício")!;
    const pinHash = (
      db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(u.id) as { pin_hash: string }
    ).pin_hash;
    const old = await verifyPin("0000", pinHash);
    expect(old).toBe(false);
  });

  it("PIN novo funciona", async () => {
    await ensureAdmin(db, { username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902" });
    const u = findUserByUsername(db, "fabrício")!;
    const pinHash = (
      db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(u.id) as { pin_hash: string }
    ).pin_hash;
    const ok = await verifyPin("1902", pinHash);
    expect(ok).toBe(true);
  });

  it("segunda execução é idempotente — não duplica", async () => {
    await ensureAdmin(db, { username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902" });
    await ensureAdmin(db, { username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902" });
    expect(getUserCount(db)).toBe(1);
  });

  it("hash não contém o PIN em texto plano após atualização", async () => {
    await ensureAdmin(db, { username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902" });
    const row = db
      .prepare("SELECT pin_hash FROM users WHERE username = 'fabrício'")
      .get() as { pin_hash: string };
    expect(row.pin_hash).not.toContain("1902");
    expect(row.pin_hash).toMatch(/^scrypt:/);
  });

  it("não altera outros usuários", async () => {
    await createUser(db, { username: "outro", displayName: "Outro", pin: "9999", role: "OPERATOR" });
    await ensureAdmin(db, { username: "Fabrício", displayName: "Fabrício Teraoka", pin: "1902" });
    const outro = findUserByUsername(db, "outro")!;
    expect(outro).not.toBeNull();
    expect(outro.role).toBe("OPERATOR");
  });
});

describe("setup routing: fluxo de estados", () => {
  let db: Db;
  beforeEach(() => { db = makeDb(); });

  it("sem usuários → getUserCount retorna 0 (deve ir para /setup)", () => {
    expect(getUserCount(db)).toBe(0);
  });

  it("após setup → getUserCount retorna 1 (deve ir para /login ou app)", async () => {
    await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
    expect(getUserCount(db)).toBe(1);
  });

  it("setup com usuário existente lança AuthError com code SETUP_ALREADY_DONE", async () => {
    await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
    await expect(
      setupFirstUser(db, { username: "outro", displayName: "Outro", pin: "5678" }),
    ).rejects.toMatchObject({ code: "SETUP_ALREADY_DONE" });
  });

  it("hashPin não expõe PIN no hash gerado", async () => {
    const h = await hashPin("1902");
    expect(h).not.toContain("1902");
    expect(h).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
  });
});
