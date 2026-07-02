import { Router } from "express";
import { z } from "zod";
import {
  getUserCount,
  setupFirstUser,
  login,
  logout,
  createUser,
  updateUser,
  resetUserPin,
  listUsers,
  AuthError,
} from "../../auth/auth-service.js";
import { getDb } from "../../db/database.js";
import { requireAuth, SESSION_COOKIE } from "../middleware/auth-middleware.js";
import { logAudit } from "../../audit/audit-service.js";

export const authRouter = Router();

const COOKIE_MAX_AGE_MS = Number(process.env.SESSION_TTL_MS ?? 12 * 60 * 60 * 1000);

function setCookie(res: import("express").Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // beta local em HTTP
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

// ─── Setup status (público) ────────────────────────────────────────────────

authRouter.get("/setup-status", (_req, res) => {
  const hasUsers = getUserCount(getDb()) > 0;
  res.json({ setupDone: hasUsers });
});

// ─── Setup (primeiro usuário — público, bloqueia depois) ──────────────────

const SetupSchema = z.object({
  username: z.string().min(2),
  displayName: z.string().min(1),
  pin: z.string().regex(/^\d{4,8}$/),
});

authRouter.post("/setup", async (req, res, next) => {
  try {
    const body = SetupSchema.parse(req.body);
    const user = await setupFirstUser(getDb(), body);
    const { token } = await login(getDb(), { username: body.username, pin: body.pin, ttlMs: COOKIE_MAX_AGE_MS });
    setCookie(res, token);
    logAudit(getDb(), { userId: user.id, action: "USER_CREATED", entityType: "USER", entityId: String(user.id), meta: { username: user.username, role: user.role, source: "setup" } });
    res.status(201).json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos.", details: err.issues }); return; }
    if (err instanceof AuthError) { res.status(409).json({ error: err.message, code: err.code }); return; }
    next(err);
  }
});

// ─── Login (público) ──────────────────────────────────────────────────────

const LoginSchema = z.object({
  username: z.string(),
  pin: z.string(),
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const body = LoginSchema.parse(req.body);
    const { token, user } = await login(getDb(), { username: body.username, pin: body.pin, ttlMs: COOKIE_MAX_AGE_MS });
    setCookie(res, token);
    logAudit(getDb(), { userId: user.id, action: "LOGIN", entityType: "USER", entityId: String(user.id) });
    res.json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if (err instanceof AuthError) {
      const status = err.code === "USER_INACTIVE" ? 403 : 401;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
});

// ─── Me (protegido) ───────────────────────────────────────────────────────

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.sessionUser });
});

// ─── Logout (protegido) ───────────────────────────────────────────────────

authRouter.post("/logout", requireAuth, (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE] as string;
  if (token) {
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "LOGOUT", entityType: "USER", entityId: String(req.sessionUser!.id) });
    logout(getDb(), token);
  }
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

// ─── Admin: gestão de usuários ────────────────────────────────────────────

authRouter.get("/users", requireAuth, (_req, res) => {
  res.json({ users: listUsers(getDb()) });
});

const CreateUserSchema = z.object({
  username: z.string().min(2),
  displayName: z.string().min(1),
  pin: z.string().regex(/^\d{4,8}$/),
  role: z.enum(["ADMIN", "OPERATOR"]).default("OPERATOR"),
});

authRouter.post("/users", requireAuth, async (req, res, next) => {
  try {
    const body = CreateUserSchema.parse(req.body);
    const user = await createUser(getDb(), body);
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "USER_CREATED", entityType: "USER", entityId: String(user.id), meta: { username: user.username, role: user.role } });
    res.status(201).json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos.", details: err.issues }); return; }
    if (err instanceof AuthError) { res.status(409).json({ error: err.message, code: err.code }); return; }
    next(err);
  }
});

const UpdateUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  role: z.enum(["ADMIN", "OPERATOR"]).optional(),
  active: z.boolean().optional(),
});

authRouter.patch("/users/:id", requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = UpdateUserSchema.parse(req.body);
    const user = updateUser(getDb(), id, body);
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "USER_UPDATED", entityType: "USER", entityId: String(id), meta: body });
    res.json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if (err instanceof AuthError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "LAST_ADMIN" ? 422 : 409;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
});

const ResetPinSchema = z.object({ pin: z.string().regex(/^\d{4,8}$/) });

authRouter.post("/users/:id/reset-pin", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { pin } = ResetPinSchema.parse(req.body);
    await resetUserPin(getDb(), id, pin);
    logAudit(getDb(), { userId: req.sessionUser!.id, action: "USER_PIN_RESET", entityType: "USER", entityId: String(id) });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Dados inválidos." }); return; }
    if (err instanceof AuthError) { res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message }); return; }
    next(err);
  }
});
