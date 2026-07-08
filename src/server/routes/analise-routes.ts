/**
 * Rotas de análise de aparelho.
 *
 * GET  /api/analise/prefill?q={imeiOuOs}
 * POST /api/analise/complete
 */

import { Router } from "express";
import { getDb } from "../../db/database.js";
import { requireAuth } from "../middleware/auth-middleware.js";
import { getPrefill } from "../../analise/prefill-service.js";
import { normalizeKey } from "../../domain/text.js";

export const analiseRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/analise/prefill?q=...
// ---------------------------------------------------------------------------

analiseRouter.get("/prefill", requireAuth, (req, res, next) => {
  try {
    const q = String(req.query["q"] ?? "").trim();
    if (!q) return res.status(400).json({ error: "Parâmetro q obrigatório." });
    const db = getDb();
    const result = getPrefill(db, q);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/analise/complete
// Cria ou atualiza repair_case + part_requests + finaliza análise + motor
// ---------------------------------------------------------------------------

interface PartInput {
  pecaNome: string;
  incluirCor: boolean;
  corUsada: string;
  chavePeca: string;
}

analiseRouter.post("/complete", requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const userId = (req as typeof req & { sessionUser?: { id?: number } }).sessionUser?.id ?? null;

    const {
      existingCaseId,
      imei, os, brand, model, color, ageDays, cost, estimatedSale,
      problema, notes, fieldOrigins,
      parts,
    } = req.body as {
      existingCaseId?: number | null;
      imei?: string | null;
      os?: string | null;
      brand?: string | null;
      model?: string | null;
      color?: string | null;
      ageDays?: number | null;
      cost?: number | null;
      estimatedSale?: number | null;
      problema?: string | null;
      notes?: string | null;
      fieldOrigins?: Record<string, string>;
      parts?: PartInput[];
    };

    // Validation
    if (!imei && !os) return res.status(400).json({ error: "IMEI ou OS obrigatório." });
    if (!model) return res.status(400).json({ error: "Modelo obrigatório." });
    if (!cost || cost <= 0) return res.status(400).json({ error: "Custo deve ser maior que zero." });
    if (!estimatedSale || estimatedSale <= 0) return res.status(400).json({ error: "Venda estimada deve ser maior que zero." });
    if (!parts || parts.length === 0) return res.status(400).json({ error: "Ao menos uma peça é obrigatória." });

    // Validate parts with incluirCor
    for (const p of parts) {
      if (p.incluirCor && !p.corUsada) {
        return res.status(400).json({ error: `Cor obrigatória para peça "${p.pecaNome}" (checkbox marcada).` });
      }
    }

    const imeiNorm = imei ? imei.replace(/\D/g, "").trim() : null;
    const osNorm   = os   ? os.replace(/\D/g, "").trim()   : null;
    const margin   = cost && estimatedSale ? estimatedSale - cost : null;

    db.exec("BEGIN");
    try {
      let caseId: number;

      if (existingCaseId) {
        // Update existing
        db.prepare(
          `UPDATE repair_cases SET
             imei=?, imei_norm=?, os=?, os_norm=?,
             brand=?, model=?, color=?, age_days=?,
             cost=?, estimated_sale=?, margin=?,
             problema=?, notes=?,
             updated_by_user_id=?, updated_at=datetime('now')
           WHERE id=?`,
        ).run(
          imei ?? null, imeiNorm, os ?? null, osNorm,
          brand ?? null, model, color ?? null, ageDays ?? null,
          cost, estimatedSale, margin,
          problema ?? null, notes ?? null,
          userId, existingCaseId,
        );
        caseId = existingCaseId;
      } else {
        // Create new
        const r = db.prepare(
          `INSERT INTO repair_cases
             (imei, imei_norm, os, os_norm, brand, model, color, age_days,
              cost, estimated_sale, margin, problema, notes,
              analysis_status, workflow_status, created_by_user_id, updated_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   'DRAFT', 'EM_ANALISE', ?, ?)`,
        ).run(
          imei ?? null, imeiNorm, os ?? null, osNorm,
          brand ?? null, model, color ?? null, ageDays ?? null,
          cost, estimatedSale, margin,
          problema ?? null, notes ?? null,
          userId, userId,
        );
        caseId = Number(r.lastInsertRowid);
      }

      // Insert parts
      const insertPart = db.prepare(
        `INSERT INTO part_requests
           (repair_case_id, description, chave_peca, chave_peca_norm,
            peca_nome, incluir_cor, cor_usada, field_origins_json,
            status, analysis_complete_at_creation, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PEDIR_PECA', 1, ?)`,
      );

      for (const p of parts) {
        // modelo sempre vem do aparelho — nunca da peça individualmente
        const chavePeca = p.chavePeca || buildChavePeca(p.pecaNome, model!, p.incluirCor, p.corUsada);
        const chavePecaNorm = normalizeKey(chavePeca);
        insertPart.run(
          caseId,
          p.pecaNome || chavePeca,
          chavePeca,
          chavePecaNorm,
          p.pecaNome || null,
          p.incluirCor ? 1 : 0,
          p.corUsada || null,
          fieldOrigins ? JSON.stringify(fieldOrigins) : null,
          userId,
        );
      }

      // Complete analysis
      db.prepare(
        `UPDATE repair_cases SET
           analysis_status='COMPLETED',
           workflow_status='PEDIR_PECA',
           updated_at=datetime('now')
         WHERE id=? AND analysis_status='DRAFT'`,
      ).run(caseId);

      // Audit event
      db.prepare(
        `INSERT INTO operational_events (event_type, entity_type, entity_id, created_by_user_id)
         VALUES ('ANALYSIS_COMPLETED', 'repair_case', ?, ?)`,
      ).run(caseId, userId);

      db.exec("COMMIT");

      // Trigger motor once (non-blocking)
      import("../../match/engine-orchestrator.js").then(async ({ requestMatchRecompute, processPendingRecompute }) => {
        requestMatchRecompute(db, `ANALYSIS_${caseId}`, "repair_case", caseId);
        await processPendingRecompute(db);
      }).catch(() => { /* motor non-critical */ });

      const caseRow = db.prepare("SELECT * FROM repair_cases WHERE id=?").get(caseId) as Record<string, unknown>;
      res.json({ ok: true, repairCase: snakeToCamel(caseRow) });
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/analise/part-suggestions?q=...
// Sugestões de nomes de peça a partir de dados existentes
// ---------------------------------------------------------------------------

analiseRouter.get("/part-suggestions", requireAuth, (req, res, next) => {
  try {
    const q = String(req.query["q"] ?? "").trim();
    if (q.length < 2) return res.json({ suggestions: [] });
    const db = getDb();
    const pattern = `%${q.toUpperCase()}%`;

    // Nome base da peça: peca_nome preferido, description como fallback (registros legados)
    const fromParts = db.prepare(
      `SELECT DISTINCT COALESCE(peca_nome, description) AS name
       FROM part_requests
       WHERE COALESCE(peca_nome, description) IS NOT NULL
         AND upper(COALESCE(peca_nome, description)) LIKE ?
       LIMIT 20`,
    ).all(pattern) as { name: string }[];

    // Complementar com peca_solicitada da Análise MI
    const fromMi = db.prepare(
      `SELECT DISTINCT peca_solicitada AS name FROM analise_mi_rows
       WHERE peca_solicitada IS NOT NULL AND upper(peca_solicitada) LIKE ? LIMIT 10`,
    ).all(pattern) as { name: string }[];

    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const { name } of [...fromParts, ...fromMi]) {
      const trimmed = name.trim().toUpperCase();
      if (trimmed && !seen.has(trimmed)) { seen.add(trimmed); suggestions.push(trimmed); }
      if (suggestions.length >= 15) break;
    }
    res.json({ suggestions });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildChavePeca(pecaNome: string, modelo: string, incluirCor: boolean, corUsada: string): string {
  const parts = [pecaNome.trim(), modelo.trim()];
  if (incluirCor && corUsada.trim()) parts.push(corUsada.trim());
  return parts.join(" ").toUpperCase();
}

function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    result[camel] = v;
  }
  return result;
}
