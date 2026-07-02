/**
 * Testes de autenticação.
 * Usa banco em memória — nunca toca data/app.sqlite.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import {
  setupFirstUser,
  login,
  logout,
  validateSession,
  getUserCount,
  createUser,
  updateUser,
  resetUserPin,
  AuthError,
} from "../src/auth/auth-service.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
describe("setup (primeiro usuário)", () => {
  it("cria o primeiro admin sem usuários existentes", async () => {
    const db = makeDb();
    expect(getUserCount(db)).toBe(0);
    const user = await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
    expect(user.username).toBe("admin");
    expect(user.role).toBe("ADMIN");
    expect(getUserCount(db)).toBe(1);
  });

  it("bloqueia setup depois de já ter usuário", async () => {
    const db = makeDb();
    await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
    await expect(setupFirstUser(db, { username: "outro", displayName: "Outro", pin: "5678" })).rejects.toThrow(AuthError);
  });

  it("armazena o PIN como hash — nunca em texto puro", async () => {
    const db = makeDb();
    await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "9999" });
    const row = db.prepare("SELECT pin_hash FROM users WHERE username = 'admin'").get() as { pin_hash: string };
    expect(row.pin_hash).not.toBe("9999");
    expect(row.pin_hash).toMatch(/^scrypt:/);
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
describe("login", () => {
  let db: Db;
  beforeEach(async () => {
    db = makeDb();
    await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
  });

  it("login válido retorna token e user", async () => {
    const { token, user } = await login(db, { username: "admin", pin: "1234" });
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(40);
    expect(user.username).toBe("admin");
  });

  it("login com PIN errado lança AuthError", async () => {
    await expect(login(db, { username: "admin", pin: "0000" })).rejects.toThrow(AuthError);
  });

  it("login com usuário inexistente lança AuthError", async () => {
    await expect(login(db, { username: "naoexiste", pin: "1234" })).rejects.toThrow(AuthError);
  });

  it("usuário inativo não acessa", async () => {
    const u2 = await createUser(db, { username: "op", displayName: "Op", pin: "5678", role: "OPERATOR" });
    updateUser(db, u2.id, { active: false });
    await expect(login(db, { username: "op", pin: "5678" })).rejects.toThrow(AuthError);
  });
});

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
describe("sessão", () => {
  let db: Db;
  let token: string;

  beforeEach(async () => {
    db = makeDb();
    await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
    const r = await login(db, { username: "admin", pin: "1234" });
    token = r.token;
  });

  it("valida sessão recém-criada", () => {
    const user = validateSession(db, token);
    expect(user).not.toBeNull();
    expect(user!.username).toBe("admin");
  });

  it("sessão inválida retorna null", () => {
    expect(validateSession(db, "token-invalido")).toBeNull();
  });

  it("logout revoga sessão", async () => {
    logout(db, token);
    expect(validateSession(db, token)).toBeNull();
  });

  it("sessão expirada retorna null", async () => {
    // Cria sessão com TTL = 1ms (expirada imediatamente)
    const { token: t } = await login(db, { username: "admin", pin: "1234", ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(validateSession(db, t)).toBeNull();
  });

  it("rota protegida sem login retorna 401", async () => {
    // Simula verificação de middleware sem session
    const user = validateSession(db, "sem-token");
    expect(user).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gestão de usuários
// ---------------------------------------------------------------------------
describe("gestão de usuários", () => {
  let db: Db;
  beforeEach(async () => {
    db = makeDb();
    await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
  });

  it("cria novo usuário operador", async () => {
    const u = await createUser(db, { username: "op1", displayName: "Op1", pin: "4321", role: "OPERATOR" });
    expect(u.role).toBe("OPERATOR");
  });

  it("redefine PIN e invalida sessões antigas", async () => {
    const u = await createUser(db, { username: "op2", displayName: "Op2", pin: "1111", role: "OPERATOR" });
    const { token: t } = await login(db, { username: "op2", pin: "1111" });
    await resetUserPin(db, u.id, "2222");
    expect(validateSession(db, t)).toBeNull();
    const { token: t2 } = await login(db, { username: "op2", pin: "2222" });
    expect(validateSession(db, t2)).not.toBeNull();
  });

  it("não permite desativar o último admin ativo", async () => {
    const admin = db.prepare("SELECT id FROM users WHERE role='ADMIN' AND active=1 LIMIT 1").get() as { id: number };
    expect(() => updateUser(db, admin.id, { active: false })).toThrow(AuthError);
  });
});
