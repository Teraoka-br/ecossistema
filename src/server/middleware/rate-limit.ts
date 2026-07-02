import type { Request, Response, NextFunction } from "express";

const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_ATTEMPTS = 10;

interface Entry { count: number; resetAt: number }
const store = new Map<string, Entry>();

function key(ip: string, username: string): string {
  return `${ip}::${username.toLowerCase().slice(0, 64)}`;
}

export function rateLimitLogin(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const username = (req.body?.username as string | undefined) ?? "";
  const k = key(ip, username);
  const now = Date.now();
  const entry = store.get(k);

  if (entry && now < entry.resetAt) {
    if (entry.count >= MAX_ATTEMPTS) {
      res.status(429).json({ error: "Muitas tentativas. Aguarde e tente novamente.", code: "RATE_LIMITED" });
      return;
    }
    entry.count++;
  } else {
    store.set(k, { count: 1, resetAt: now + WINDOW_MS });
  }
  next();
}

export function clearRateLimit(ip: string, username: string): void {
  store.delete(key(ip, username));
}

// Limpeza periódica de entradas expiradas (evita memory leak em execução longa)
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store) {
    if (now >= e.resetAt) store.delete(k);
  }
}, WINDOW_MS);
