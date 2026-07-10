/**
 * Rotas de análise de aparelho.
 *
 * GET  /api/analise/prefill?q={imeiOuOs}
 * POST /api/analise/complete      — finaliza análise (COMPLETED + motor)
 * POST /api/analise/save-draft    — salva rascunho em transação única
 * GET  /api/analise/part-suggestions?q=...
 */

import { Router, type Request } from "express";
import { getDb } from "../../db/database.js";
import { requireAuth } from "../middleware/auth-middleware.js";
import { getPrefill } from "../../analise/prefill-service.js";
import { saveAnalysis, AnaliseError, type PartPayload } from "../../analise/analise-service.js";

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
// Shared input parsing for complete and save-draft
// ---------------------------------------------------------------------------

interface AnaliseBody {
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
  parts?: Array<{
    pecaNome: string;
    incluirCor: boolean;
    corUsada: string;
    chavePeca: string;
  }>;
}

function validateAndExtract(
  req: Request,
  requireParts: boolean,
): { input: Parameters<typeof saveAnalysis>[1]; err?: never } | { err: { status: number; message: string }; input?: never } {
  const body = req.body as AnaliseBody;
  const {
    existingCaseId,
    imei, os, brand, model, color, ageDays, cost, estimatedSale,
    problema, notes, fieldOrigins, parts,
  } = body;

  if (!imei && !os) return { err: { status: 400, message: "IMEI ou OS obrigatório." } };
  if (!model) return { err: { status: 400, message: "Modelo obrigatório." } };
  if (!cost || cost <= 0) return { err: { status: 400, message: "Custo deve ser maior que zero." } };
  if (!estimatedSale || estimatedSale <= 0) return { err: { status: 400, message: "Venda estimada deve ser maior que zero." } };

  const validParts: PartPayload[] = (parts ?? []).filter((p) => p.pecaNome?.trim());

  if (requireParts) {
    if (validParts.length === 0) return { err: { status: 400, message: "Ao menos uma peça é obrigatória." } };
    for (const p of validParts) {
      if (p.incluirCor && !p.corUsada) {
        return { err: { status: 400, message: `Cor obrigatória para peça "${p.pecaNome}" (checkbox marcada).` } };
      }
    }
  }

  const sessionUser = (req as Request).sessionUser!;

  return {
    input: {
      userId: sessionUser.id,
      userRole: sessionUser.role,
      responsibleName: sessionUser.displayName ?? null,
      existingCaseId: existingCaseId ?? null,
      imei: imei ?? null,
      os: os ?? null,
      brand: brand ?? null,
      model,
      color: color ?? null,
      ageDays: ageDays ?? null,
      cost,
      estimatedSale,
      problema: problema ?? null,
      notes: notes ?? null,
      fieldOrigins: fieldOrigins ?? null,
      parts: validParts,
      finalize: false, // overridden by caller
    },
  };
}

function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    result[camel] = v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// POST /api/analise/complete — finaliza análise (COMPLETED)
// ---------------------------------------------------------------------------

analiseRouter.post("/complete", requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const parsed = validateAndExtract(req, true);
    if (parsed.err) return res.status(parsed.err.status).json({ error: parsed.err.message });

    const input = { ...parsed.input!, finalize: true };

    const caseRow = saveAnalysis(db, input);

    // Disparar motor uma única vez após commit (não bloqueante)
    import("../../match/engine-orchestrator.js")
      .then(async ({ requestMatchRecompute, processPendingRecompute }) => {
        requestMatchRecompute(db, `ANALYSIS_${caseRow["id"]}`, "repair_case", caseRow["id"] as number);
        await processPendingRecompute(db);
      })
      .catch(() => { /* motor não é crítico */ });

    res.json({ ok: true, repairCase: snakeToCamel(caseRow) });
  } catch (err) {
    if (err instanceof AnaliseError) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/analise/save-draft — salva rascunho em transação única
// ---------------------------------------------------------------------------

analiseRouter.post("/save-draft", requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const parsed = validateAndExtract(req, false);
    if (parsed.err) return res.status(parsed.err.status).json({ error: parsed.err.message });

    const input = { ...parsed.input!, finalize: false };
    const caseRow = saveAnalysis(db, input);

    res.json({ ok: true, repairCase: snakeToCamel(caseRow) });
  } catch (err) {
    if (err instanceof AnaliseError) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/analise/part-suggestions?q=...
// ---------------------------------------------------------------------------

function escapeLike(q: string): string {
  return q.replace(/[%_\\]/g, "\\$&");
}

analiseRouter.get("/part-suggestions", requireAuth, (req, res, next) => {
  try {
    const q = String(req.query["q"] ?? "").trim();
    if (q.length < 2) return res.json({ suggestions: [] });
    const db = getDb();
    const escaped = escapeLike(q.toUpperCase());
    const pattern = `%${escaped}%`;

    const fromPecaNome = db
      .prepare(
        `SELECT DISTINCT peca_nome AS text FROM part_requests
         WHERE peca_nome IS NOT NULL AND upper(peca_nome) LIKE ? ESCAPE '\\' LIMIT 15`,
      )
      .all(pattern) as { text: string }[];

    const fromChave = db
      .prepare(
        `SELECT DISTINCT chave_peca AS text FROM part_requests
         WHERE chave_peca IS NOT NULL AND upper(chave_peca) LIKE ? ESCAPE '\\' LIMIT 10`,
      )
      .all(pattern) as { text: string }[];

    const fromMi = db
      .prepare(
        `SELECT DISTINCT peca_solicitada AS text FROM analise_mi_rows
         WHERE peca_solicitada IS NOT NULL AND upper(peca_solicitada) LIKE ? ESCAPE '\\' LIMIT 10`,
      )
      .all(pattern) as { text: string }[];

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
