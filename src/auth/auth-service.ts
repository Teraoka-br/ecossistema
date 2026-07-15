import crypto from "node:crypto";
import type { Db } from "../db/database.js";

// Formato do hash armazenado: "scrypt:<salt_hex>:<hash_hex>"
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, dkLen: 32 };
const SESSION_BYTES = 48;

// Expiração padrão: 12 horas em milissegundos
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type UserRole = "ADMIN" | "OPERATOR" | "TECHNICIAN";

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  active: number;
}

export interface SessionUser extends AuthUser {
  sessionId: number;
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// ---------------------------------------------------------------------------
// PIN hashing
// ---------------------------------------------------------------------------

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, SCRYPT_PARAMS.dkLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `scrypt:${salt}:${hash.toString("hex")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = crypto.scryptSync(pin, salt, expected.length, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  // Timing-safe comparison
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// User queries
// ---------------------------------------------------------------------------

export function getUserCount(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  return row.c;
}

export function findUserByUsername(db: Db, username: string): (AuthUser & { pinHash: string }) | null {
  const row = db
    .prepare("SELECT id, username, display_name, pin_hash, role, active FROM users WHERE username = ? COLLATE NOCASE")
    .get(username) as { id: number; username: string; display_name: string; pin_hash: string; role: string; active: number } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    pinHash: row.pin_hash,
    role: row.role as UserRole,
    active: row.active,
  };
}

export function getUserById(db: Db, id: number): AuthUser | null {
  const row = db
    .prepare("SELECT id, username, display_name, role, active FROM users WHERE id = ?")
    .get(id) as { id: number; username: string; display_name: string; role: string; active: number } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as UserRole,
    active: row.active,
  };
}

export function listUsers(db: Db): AuthUser[] {
  const rows = db
    .prepare("SELECT id, username, display_name, role, active FROM users ORDER BY id")
    .all() as { id: number; username: string; display_name: string; role: string; active: number }[];
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role as UserRole,
    active: r.active,
  }));
}

// ---------------------------------------------------------------------------
// Setup (primeiro usuário)
// ---------------------------------------------------------------------------

export async function setupFirstUser(
  db: Db,
  params: { username: string; displayName: string; pin: string },
): Promise<AuthUser> {
  if (getUserCount(db) > 0) {
    throw new AuthError("SETUP_ALREADY_DONE", "Sistema já possui usuários cadastrados.");
  }
  validatePin(params.pin);
  validateUsername(params.username);
  const pinHash = await hashPin(params.pin);
  const res = db
    .prepare(
      "INSERT INTO users (username, display_name, pin_hash, role) VALUES (?, ?, ?, 'ADMIN')",
    )
    .run(params.username.trim().toLowerCase(), params.displayName.trim(), pinHash);
  return getUserById(db, res.lastInsertRowid as number)!;
}

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------

export async function login(
  db: Db,
  params: { username: string; pin: string; ttlMs?: number },
): Promise<{ token: string; user: AuthUser }> {
  const user = findUserByUsername(db, params.username);
  if (!user) {
    // Mesmo tempo de resposta mesmo quando o usuário não existe
    await hashPin("000000");
    throw new AuthError("INVALID_CREDENTIALS", "Usuário ou PIN inválidos.");
  }
  if (!user.active) {
    throw new AuthError("USER_INACTIVE", "Usuário inativo.");
  }
  const ok = await verifyPin(params.pin, user.pinHash);
  if (!ok) {
    throw new AuthError("INVALID_CREDENTIALS", "Usuário ou PIN inválidos.");
  }

  const token = crypto.randomBytes(SESSION_BYTES).toString("hex");
  const tokenHash = hashToken(token);
  const ttl = params.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  // SQLite datetime('now') usa formato "YYYY-MM-DD HH:MM:SS" (sem T, sem Z).
  // Usamos o mesmo formato para que a comparação de strings funcione corretamente.
  const expiresAt = new Date(Date.now() + ttl).toISOString().replace("T", " ").slice(0, 19);

  db.prepare(
    "INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
  ).run(user.id, tokenHash, expiresAt);

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);

  const { pinHash: _ph, ...safeUser } = user;
  return { token, user: safeUser as AuthUser };
}

export function logout(db: Db, token: string): void {
  const tokenHash = hashToken(token);
  db.prepare(
    "UPDATE user_sessions SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL",
  ).run(tokenHash);
}

// ---------------------------------------------------------------------------
// Session validation
// ---------------------------------------------------------------------------

export function validateSession(db: Db, token: string): SessionUser | null {
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT s.id as session_id, u.id, u.username, u.display_name, u.role, u.active
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > datetime('now')`,
    )
    .get(tokenHash) as
    | { session_id: number; id: number; username: string; display_name: string; role: string; active: number }
    | undefined;

  if (!row) return null;
  if (!row.active) return null;

  // Atualiza last_seen
  db.prepare(
    "UPDATE user_sessions SET last_seen_at = datetime('now') WHERE id = ?",
  ).run(row.session_id);

  return {
    sessionId: row.session_id,
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as UserRole,
    active: row.active,
  };
}

// ---------------------------------------------------------------------------
// User management (admin)
// ---------------------------------------------------------------------------

export async function createUser(
  db: Db,
  params: { username: string; displayName: string; pin: string; role: UserRole },
): Promise<AuthUser> {
  validatePin(params.pin);
  validateUsername(params.username);
  const existing = findUserByUsername(db, params.username);
  if (existing) throw new AuthError("USERNAME_TAKEN", "Nome de usuário já existe.");
  const pinHash = await hashPin(params.pin);
  const res = db
    .prepare(
      "INSERT INTO users (username, display_name, pin_hash, role) VALUES (?, ?, ?, ?)",
    )
    .run(params.username.trim().toLowerCase(), params.displayName.trim(), pinHash, params.role);
  return getUserById(db, res.lastInsertRowid as number)!;
}

export async function resetUserPin(
  db: Db,
  userId: number,
  newPin: string,
): Promise<void> {
  validatePin(newPin);
  const user = getUserById(db, userId);
  if (!user) throw new AuthError("NOT_FOUND", "Usuário não encontrado.");
  const pinHash = await hashPin(newPin);
  db.prepare("UPDATE users SET pin_hash = ?, updated_at = datetime('now') WHERE id = ?").run(
    pinHash,
    userId,
  );
  // Invalida sessões existentes
  db.prepare(
    "UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
  ).run(userId);
}

export function updateUser(
  db: Db,
  userId: number,
  params: { displayName?: string; role?: UserRole; active?: boolean },
): AuthUser {
  const user = getUserById(db, userId);
  if (!user) throw new AuthError("NOT_FOUND", "Usuário não encontrado.");

  // Impede desativar ou rebaixar o último ADMIN ativo
  const isLastAdmin = (): boolean => {
    const r = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'ADMIN' AND active = 1").get() as { c: number };
    return r.c <= 1;
  };
  if ((params.active === false || (params.role && params.role !== "ADMIN")) && user.role === "ADMIN") {
    if (isLastAdmin()) {
      const action = params.active === false ? "desativar" : "rebaixar";
      throw new AuthError("LAST_ADMIN", `Não é possível ${action} o último administrador ativo.`);
    }
  }

  if (params.displayName !== undefined) {
    db.prepare("UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?").run(
      params.displayName.trim(),
      userId,
    );
  }
  if (params.role !== undefined) {
    db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(
      params.role,
      userId,
    );
  }
  if (params.active !== undefined) {
    db.prepare("UPDATE users SET active = ?, updated_at = datetime('now') WHERE id = ?").run(
      params.active ? 1 : 0,
      userId,
    );
  }
  return getUserById(db, userId)!;
}

// ---------------------------------------------------------------------------
// User permissions
// ---------------------------------------------------------------------------

export function getUserPermissions(db: Db, userId: number): string[] {
  const rows = db
    .prepare("SELECT permission FROM user_permissions WHERE user_id = ?")
    .all(userId) as { permission: string }[];
  return rows.map((r) => r.permission);
}

export function grantPermission(db: Db, userId: number, permission: string, grantedBy: number): void {
  const user = getUserById(db, userId);
  if (!user) throw new AuthError("NOT_FOUND", "Usuário não encontrado.");
  db.prepare(
    "INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, ?)",
  ).run(userId, permission, grantedBy);
}

export function revokePermission(db: Db, userId: number, permission: string): void {
  db.prepare("DELETE FROM user_permissions WHERE user_id = ? AND permission = ?").run(userId, permission);
}

export function deleteUser(db: Db, userId: number): void {
  const user = getUserById(db, userId);
  if (!user) throw new AuthError("NOT_FOUND", "Usuário não encontrado.");
  if (user.role === "ADMIN") {
    const r = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'ADMIN' AND active = 1").get() as { c: number };
    if (r.c <= 1) throw new AuthError("LAST_ADMIN", "Não é possível excluir o último administrador ativo.");
  }
  db.prepare("UPDATE staff_members SET user_id = NULL WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validatePin(pin: string): void {
  if (!/^\d{4,8}$/.test(pin)) {
    throw new AuthError("INVALID_PIN", "O PIN deve conter entre 4 e 8 dígitos numéricos.");
  }
}

function validateUsername(username: string): void {
  if (!username || username.trim().length < 2) {
    throw new AuthError("INVALID_USERNAME", "Nome de usuário deve ter pelo menos 2 caracteres.");
  }
}
