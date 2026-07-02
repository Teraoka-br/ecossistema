import type { Request, Response, NextFunction } from "express";
import { validateSession } from "../../auth/auth-service.js";
import { getDb } from "../../db/database.js";
import type { SessionUser } from "../../auth/auth-service.js";

export const SESSION_COOKIE = "sid";

declare global {
  namespace Express {
    interface Request {
      sessionUser?: SessionUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) {
    res.status(401).json({ error: "Não autenticado." });
    return;
  }
  const user = validateSession(getDb(), token);
  if (!user) {
    res.clearCookie(SESSION_COOKIE);
    res.status(401).json({ error: "Sessão inválida ou expirada." });
    return;
  }
  req.sessionUser = user;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) {
    const user = validateSession(getDb(), token);
    if (user) req.sessionUser = user;
  }
  next();
}
