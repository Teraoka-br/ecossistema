/**
 * Compatibilidade manual de referências (part_key_aliases).
 *
 * Vincula uma chave de peça solicitada a uma chave compatível existente no
 * estoque (ex.: BATERIA IPHONE 12 → BATERIA IPHONE 12/12 PRO). O motor de
 * match usa esses vínculos com prioridade sobre o catálogo. Toda criação ou
 * remoção dispara recálculo do motor (lógica em part-keys-service).
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth-middleware.js";
import {
  listPartKeyAliases,
  createPartKeyAlias,
  deactivatePartKeyAlias,
  PartKeyAliasError,
} from "../../operational/part-keys-service.js";
import { processPendingRecompute } from "../../match/engine-orchestrator.js";

export const partKeyAliasRouter = Router();

const aliasCreateSchema = z.object({
  requestedChavePeca: z.string().min(1),
  stockChavePeca: z.string().min(1),
  reason: z.string().optional().nullable(),
});

// Busca chaves e referências disponíveis no estoque (para autocomplete do campo "chave no estoque")
partKeyAliasRouter.get("/referencias/stock-keys", requireAuth, (req, res, next) => {
  try {
    const q = (typeof req.query.q === "string" ? req.query.q : "").trim().toUpperCase();
    const db = getDb();
    // Pega o snapshot OFFICIAL mais recente
    const snap = db.prepare("SELECT id FROM stock_snapshots WHERE status='OFFICIAL' ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    if (!snap) { res.json({ items: [] }); return; }
    const pattern = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    const rows = db.prepare(`
      SELECT reference, chave_peca FROM stock_snapshot_items
      WHERE snapshot_id = ?
        AND (upper(reference) LIKE ? ESCAPE '\\' OR upper(chave_peca) LIKE ? ESCAPE '\\')
      ORDER BY reference LIMIT 20
    `).all(snap.id, pattern, pattern) as { reference: string; chave_peca: string }[];
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

partKeyAliasRouter.get("/part-key-aliases", requireAuth, (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json({ aliases: listPartKeyAliases(getDb(), q) });
  } catch (err) {
    next(err);
  }
});

partKeyAliasRouter.post("/part-key-aliases", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const body = aliasCreateSchema.parse(req.body);
    const db = getDb();
    const alias = createPartKeyAlias(db, {
      requestedChavePeca: body.requestedChavePeca,
      stockChavePeca: body.stockChavePeca,
      reason: body.reason ?? null,
      userId: (req as Request).sessionUser?.id ?? null,
    });
    const recompute = await processPendingRecompute(db).catch(() => null);
    res.status(201).json({ alias, recompute });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    if (err instanceof PartKeyAliasError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
});

partKeyAliasRouter.delete("/part-key-aliases/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: `ID inválido: "${req.params.id}".` });
      return;
    }
    const db = getDb();
    const { wasActive } = deactivatePartKeyAlias(db, id);
    const recompute = wasActive ? await processPendingRecompute(db).catch(() => null) : null;
    res.json({ ok: true, recompute });
  } catch (err) {
    if (err instanceof PartKeyAliasError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
});
