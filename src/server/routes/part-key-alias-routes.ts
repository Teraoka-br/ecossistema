/**
 * Compatibilidade manual de referências (part_key_aliases).
 *
 * Vincula uma chave de peça solicitada a uma chave compatível existente no
 * estoque (ex.: BATERIA IPHONE 12 → BATERIA IPHONE 12/12 PRO). O motor de
 * match usa esses vínculos com prioridade sobre o catálogo. Toda criação ou
 * remoção dispara recálculo do motor.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth-middleware.js";
import { normalizeKey } from "../../domain/text.js";
import { requestMatchRecompute, processPendingRecompute } from "../../match/engine-orchestrator.js";

export const partKeyAliasRouter = Router();

const aliasCreateSchema = z.object({
  requestedChavePeca: z.string().min(1),
  stockChavePeca: z.string().min(1),
  reason: z.string().optional().nullable(),
});

partKeyAliasRouter.get("/part-key-aliases", requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    let rows;
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      rows = db.prepare(
        `SELECT * FROM part_key_aliases
         WHERE requested_chave_peca LIKE ? ESCAPE '\\' OR stock_chave_peca LIKE ? ESCAPE '\\'
         ORDER BY active DESC, created_at DESC`,
      ).all(like, like);
    } else {
      rows = db.prepare("SELECT * FROM part_key_aliases ORDER BY active DESC, created_at DESC").all();
    }
    res.json({ aliases: rows });
  } catch (err) {
    next(err);
  }
});

partKeyAliasRouter.post("/part-key-aliases", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const body = aliasCreateSchema.parse(req.body);
    const db = getDb();
    const reqNorm = normalizeKey(body.requestedChavePeca);
    const stNorm = normalizeKey(body.stockChavePeca);
    if (!reqNorm || !stNorm) {
      res.status(400).json({ error: "Chaves não podem ser vazias." });
      return;
    }
    if (reqNorm === stNorm) {
      res.status(400).json({ error: "A chave solicitada e a chave de estoque são iguais — vínculo desnecessário." });
      return;
    }
    // Impede vínculo duplicado / grupos conflitantes: uma chave solicitada só
    // pode apontar para UMA chave de estoque ativa.
    const existing = db.prepare(
      "SELECT id, stock_chave_peca FROM part_key_aliases WHERE requested_chave_peca_norm = ? AND active = 1",
    ).get(reqNorm) as { id: number; stock_chave_peca: string } | undefined;
    if (existing) {
      res.status(409).json({
        error: `Já existe um vínculo ativo para essa chave solicitada (→ ${existing.stock_chave_peca}). Remova-o antes de criar outro.`,
      });
      return;
    }
    // Impede ciclo direto: A→B quando já existe B→A ativo.
    const inverse = db.prepare(
      "SELECT id FROM part_key_aliases WHERE requested_chave_peca_norm = ? AND stock_chave_peca_norm = ? AND active = 1",
    ).get(stNorm, reqNorm) as { id: number } | undefined;
    if (inverse) {
      res.status(409).json({ error: "Já existe o vínculo inverso ativo — a compatibilidade é simétrica no consumo de estoque; use apenas um sentido (solicitada → estoque)." });
      return;
    }
    const result = db.prepare(`
      INSERT INTO part_key_aliases
        (requested_chave_peca, requested_chave_peca_norm, stock_chave_peca, stock_chave_peca_norm, reason, active, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      body.requestedChavePeca.trim(), reqNorm,
      body.stockChavePeca.trim(), stNorm,
      body.reason ?? null,
      (req as Request).sessionUser?.id ?? null,
    );
    const row = db.prepare("SELECT * FROM part_key_aliases WHERE id = ?").get(result.lastInsertRowid);

    requestMatchRecompute(db, `ALIAS_CREATED ${reqNorm} → ${stNorm}`, "part_key_alias", result.lastInsertRowid as number);
    await processPendingRecompute(db).catch(() => { /* motor pode estar sem regra ativa — o card de estado mostra */ });

    res.status(201).json({ alias: row });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
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
    const row = db.prepare("SELECT id, requested_chave_peca_norm, stock_chave_peca_norm, active FROM part_key_aliases WHERE id = ?").get(id) as
      | { id: number; requested_chave_peca_norm: string; stock_chave_peca_norm: string; active: number }
      | undefined;
    if (!row) {
      res.status(404).json({ error: "Vínculo não encontrado." });
      return;
    }
    // Desativação (nunca DELETE) — preserva histórico.
    db.prepare("UPDATE part_key_aliases SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);

    if (row.active === 1) {
      requestMatchRecompute(db, `ALIAS_DEACTIVATED ${row.requested_chave_peca_norm}`, "part_key_alias", id);
      await processPendingRecompute(db).catch(() => { /* idem */ });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
