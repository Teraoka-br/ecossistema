/**
 * Testes de rate-limit de login e proteção do último ADMIN.
 * Usa banco em memória — nunca toca data/app.sqlite.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import {
  setupFirstUser, createUser, updateUser, AuthError,
} from "../src/auth/auth-service.js";
import { rateLimitLogin, clearRateLimit } from "../src/server/middleware/rate-limit.js";
import type { Request, Response, NextFunction } from "express";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// Proteção do último ADMIN
// ---------------------------------------------------------------------------
describe("updateUser: proteção do último ADMIN", () => {
  let db: Db;

  beforeEach(async () => {
    db = makeDb();
    await setupFirstUser(db, { username: "admin", displayName: "Admin", pin: "1234" });
  });

  it("não permite desativar o único ADMIN ativo", async () => {
    const u = db.prepare("SELECT id FROM users WHERE role = 'ADMIN'").get() as { id: number };
    expect(() => updateUser(db, u.id, { active: false })).toThrow(AuthError);
    const err = (() => { try { updateUser(db, u.id, { active: false }); } catch (e) { return e as AuthError; } })();
    expect(err?.code).toBe("LAST_ADMIN");
  });

  it("não permite rebaixar o único ADMIN para OPERATOR", async () => {
    const u = db.prepare("SELECT id FROM users WHERE role = 'ADMIN'").get() as { id: number };
    expect(() => updateUser(db, u.id, { role: "OPERATOR" })).toThrow(AuthError);
  });

  it("permite rebaixar ADMIN se há outro ADMIN ativo", async () => {
    await createUser(db, { username: "admin2", displayName: "Admin 2", pin: "5678", role: "ADMIN" });
    const u = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number };
    expect(() => updateUser(db, u.id, { role: "OPERATOR" })).not.toThrow();
  });

  it("permite desativar ADMIN se há outro ADMIN ativo", async () => {
    await createUser(db, { username: "admin2", displayName: "Admin 2", pin: "5678", role: "ADMIN" });
    const u = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number };
    expect(() => updateUser(db, u.id, { active: false })).not.toThrow();
  });

  it("rebaixar usuário OPERATOR nunca é bloqueado pela regra de último ADMIN", async () => {
    await createUser(db, { username: "op", displayName: "Operator", pin: "4321", role: "OPERATOR" });
    const u = db.prepare("SELECT id FROM users WHERE username = 'op'").get() as { id: number };
    // Rebaixar de OPERATOR para OPERATOR (sem mudança) — não deve lançar
    expect(() => updateUser(db, u.id, { role: "OPERATOR" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
describe("rateLimitLogin", () => {
  function makeReq(ip: string, username: string): Partial<Request> {
    return { ip, socket: { remoteAddress: ip } as any, body: { username } };
  }

  function callMiddleware(req: Partial<Request>): { blocked: boolean; status?: number } {
    let blocked = false;
    let status: number | undefined;
    const res = {
      status(s: number) { status = s; return res; },
      json() { blocked = true; return res; },
    } as unknown as Response;
    const next: NextFunction = () => { /* allowed */ };
    rateLimitLogin(req as Request, res, next);
    return { blocked, status };
  }

  it("primeira tentativa é permitida", () => {
    const { blocked } = callMiddleware(makeReq("1.1.1.1", "user-rate-test-a"));
    expect(blocked).toBe(false);
  });

  it("bloqueia após 10 tentativas com mesmo IP+username", () => {
    const ip = "2.2.2.2";
    const username = "user-rate-test-b";
    for (let i = 0; i < 10; i++) {
      callMiddleware(makeReq(ip, username));
    }
    const { blocked, status } = callMiddleware(makeReq(ip, username));
    expect(blocked).toBe(true);
    expect(status).toBe(429);
  });

  it("IPs diferentes não compartilham limite", () => {
    const username = "user-rate-test-c";
    for (let i = 0; i < 10; i++) {
      callMiddleware(makeReq("3.3.3.3", username));
    }
    const { blocked } = callMiddleware(makeReq("4.4.4.4", username));
    expect(blocked).toBe(false);
  });

  it("clearRateLimit reseta o contador", () => {
    const ip = "5.5.5.5";
    const username = "user-rate-test-d";
    for (let i = 0; i < 10; i++) {
      callMiddleware(makeReq(ip, username));
    }
    clearRateLimit(ip, username);
    const { blocked } = callMiddleware(makeReq(ip, username));
    expect(blocked).toBe(false);
  });
});
