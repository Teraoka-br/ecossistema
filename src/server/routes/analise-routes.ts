/**
 * Rotas de análise de aparelho.
 *
 * GET  /api/analise/prefill?q={imeiOuOs}
 * POST /api/analise/complete
 */

import { Router, type Request } from "express";
import { getDb } from "../../db/database.js";
import { requireAuth } from "../middleware/auth-middleware.js";
import { getPrefill } from "../../analise/prefill-service.js";
import { normalizeKey } from "../../domain/text.js";
import { recordOperationalEvent } from "../../operational/operational-event-service.js";

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
    const userId = (req as Request).sessionUser?.id ?? null;
    const responsibleName = (req as Request).sessionUser?.displayName ?? null;

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
      recordOperationalEvent(db, {
        repairCaseId: caseId,
        eventType: "ANALYSIS_COMPLETED",
        newStatus: "PEDIR_PECA",
        responsibleName,
      });

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

    // Nomes de peça (peca_nome = nome sem modelo)
    const fromPecaNome = db.prepare(
      `SELECT DISTINCT peca_nome AS text FROM part_requests
       WHERE peca_nome IS NOT NULL AND upper(peca_nome) LIKE ? LIMIT 15`,
    ).all(pattern) as { text: string }[];

    // CHAVEPECAs completas (já incluem modelo — não concatenar modelo novamente)
    const fromChave = db.prepare(
      `SELECT DISTINCT chave_peca AS text FROM part_requests
       WHERE chave_peca IS NOT NULL AND upper(chave_peca) LIKE ? LIMIT 10`,
    ).all(pattern) as { text: string }[];

    // Nomes da Análise MI
    const fromMi = db.prepare(
      `SELECT DISTINCT peca_solicitada AS text FROM analise_mi_rows
       WHERE peca_solicitada IS NOT NULL AND upper(peca_solicitada) LIKE ? LIMIT 10`,
    ).all(pattern) as { text: string }[];

    const seen = new Set<string>();
    const suggestions: { text: string; type: "nome" | "chave" }[] = [];

    for (const { text } of fromPecaNome) {
      const t = text.trim().toUpperCase();
      if (t && !seen.has(t)) { seen.add(t); suggestions.push({ text: t, type: "nome" }); }
      if (suggestions.length >= 15) break;
    }
    for (const { text } of fromMi) {
      const t = text.trim().toUpperCase();
      if (t && !seen.has(t)) { seen.add(t); suggestions.push({ text: t, type: "nome" }); }
      if (suggestions.length >= 20) break;
    }
    for (const { text } of fromChave) {
      const t = text.trim().toUpperCase();
      if (t && !seen.has(t)) { seen.add(t); suggestions.push({ text: t, type: "chave" }); }
      if (suggestions.length >= 25) break;
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
