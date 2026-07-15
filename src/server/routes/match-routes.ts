import { Router } from "express";
import { z } from "zod";
import { getDb } from "../../db/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth-middleware.js";

function normalizeChave(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, " ");
}
import {
  runMatch,
  getLatestRun,
  getCurrentState,
  getMatchRun,
  listMatchRuns,
  listDeviceResults,
  listLineResults,
  getLineResultsForDevice,
  getStockSummaryFromResults,
  getFullComparisonData,
  exportResultsCsv,
  isRunStale,
  MatchError,
  MatchConfigError,
} from "../../match/match-service.js";
import { computeCurrentFingerprint } from "../../match/match-fingerprint.js";

export const matchRouter = Router();

function handleError(err: unknown, res: import("express").Response): void {
  if (err instanceof MatchError) {
    res.status(err.statusCode).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof MatchConfigError) {
    res.status(422).json({ error: err.message, code: "CONFIG_ERROR" });
    return;
  }
  res.status(500).json({ error: (err as Error).message || "Erro interno." });
}

function idParam(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new MatchError(400, `ID inválido: "${raw}".`);
  return n;
}

function paginationParams(query: Record<string, unknown>) {
  const limit = Math.min(Number(query.limit) || 50, 200);
  const offset = Number(query.offset) || 0;
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Regra de decisão ativa
// ---------------------------------------------------------------------------

matchRouter.get("/decision-rules/active", (_req, res) => {
  try {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM decision_rules WHERE active = 1 ORDER BY id")
      .all() as unknown as object[];
    if (rows.length === 0) {
      res.status(404).json({ error: "Nenhuma regra de decisão ativa encontrada." });
      return;
    }
    res.json({ rule: rows[0], count: rows.length });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Estado atual (fingerprint, estoque, regra)
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs/current-state", (_req, res) => {
  try {
    const state = getCurrentState(getDb());
    const latest = getLatestRun(getDb());
    res.json({ state, latest });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Criar / reutilizar execução
// ---------------------------------------------------------------------------

const createRunSchema = z.object({
  createdBy: z.string().min(1, "createdBy é obrigatório"),
  notes: z.string().optional().nullable(),
  force: z.boolean().optional().default(false),
});

matchRouter.post("/match-runs", (req, res) => {
  try {
    const body = createRunSchema.parse(req.body);
    const db = getDb();
    const result = runMatch(db, {
      createdBy: body.createdBy,
      notes: body.notes,
      force: body.force,
    });
    const run = result.run;
    const stale = isRunStale(db, run);
    const { hash: currentHash } = computeCurrentFingerprint(db);
    res.status(result.reused ? 200 : 201).json({
      run,
      reused: result.reused,
      stale,
      currentHash,
      message: result.reused
        ? "Resultado reutilizado — o estado não mudou desde a última execução."
        : "Execução concluída.",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Listar execuções
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs", (req, res) => {
  try {
    const { limit, offset } = paginationParams(req.query as Record<string, unknown>);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const { runs, total } = listMatchRuns(getDb(), { limit, offset, status });
    const db = getDb();
    let currentHash = "";
    try {
      currentHash = computeCurrentFingerprint(db).hash;
    } catch { /* sem regra ativa */ }
    const runsWithStale = runs.map((r) => ({
      ...r,
      stale: isRunStale(db, r),
    }));
    res.json({ runs: runsWithStale, total, limit, offset, currentHash });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Última execução concluída
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs/latest", (_req, res) => {
  try {
    const db = getDb();
    const run = getLatestRun(db);
    if (!run) {
      res.status(404).json({ error: "Nenhuma execução concluída encontrada." });
      return;
    }
    res.json({ run });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Execução por ID
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs/:id", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    const run = getMatchRun(db, id);
    if (!run) {
      res.status(404).json({ error: `Execução ${id} não encontrada.` });
      return;
    }
    const stale = isRunStale(db, run);
    let currentHash = "";
    try { currentHash = computeCurrentFingerprint(db).hash; } catch { /* ignore */ }
    res.json({ run: { ...run, stale }, currentHash });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Aparelhos de uma execução
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs/:id/devices", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    if (!getMatchRun(db, id)) {
      res.status(404).json({ error: `Execução ${id} não encontrada.` });
      return;
    }
    const { limit, offset } = paginationParams(req.query as Record<string, unknown>);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const kitStatus = typeof req.query.kitStatus === "string" ? req.query.kitStatus : undefined;
    const { devices, total } = listDeviceResults(db, id, { limit, offset, search, kitStatus });
    res.json({ devices, total, limit, offset });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Linhas de resultado de uma execução
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs/:id/results", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    if (!getMatchRun(db, id)) {
      res.status(404).json({ error: `Execução ${id} não encontrada.` });
      return;
    }
    const { limit, offset } = paginationParams(req.query as Record<string, unknown>);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const phase = typeof req.query.phase === "string" ? req.query.phase : undefined;
    const onlyDivergent = req.query.onlyDivergent === "true";
    const { results, total } = listLineResults(db, id, {
      limit,
      offset,
      search,
      status,
      phase,
      onlyDivergent,
    });
    res.json({ results, total, limit, offset });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Linhas de um aparelho específico (item 2)
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs/:runId/devices/:deviceResultId/results", (req, res) => {
  try {
    const runId = idParam(req.params.runId);
    const deviceResultId = idParam(req.params.deviceResultId);
    const db = getDb();

    if (!getMatchRun(db, runId)) {
      res.status(404).json({ error: `Execução ${runId} não encontrada.` });
      return;
    }
    const device = db
      .prepare("SELECT id, match_run_id FROM match_device_results WHERE id = ?")
      .get(deviceResultId) as { id: number; match_run_id: number } | undefined;
    if (!device) {
      res.status(404).json({ error: `Aparelho ${deviceResultId} não encontrado.` });
      return;
    }
    if (device.match_run_id !== runId) {
      res.status(400).json({ error: `Aparelho ${deviceResultId} não pertence à execução ${runId}.` });
      return;
    }
    const lines = getLineResultsForDevice(db, runId, deviceResultId);
    res.json({ lines });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Resumo de estoque de uma execução
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs/:id/stock-summary", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    if (!getMatchRun(db, id)) {
      res.status(404).json({ error: `Execução ${id} não encontrada.` });
      return;
    }
    const summary = getStockSummaryFromResults(db, id);
    res.json({ summary });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Comparação com legado
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs/:id/comparison", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    if (!getMatchRun(db, id)) {
      res.status(404).json({ error: `Execução ${id} não encontrada.` });
      return;
    }
    const { limit, offset } = paginationParams(req.query as Record<string, unknown>);
    const onlyDivergent = req.query.onlyDivergent === "true";
    const search = typeof req.query.search === "string" ? req.query.search : undefined;

    const { rows, total, summary } = getFullComparisonData(db, id, {
      limit,
      offset,
      onlyDivergent,
      search,
    });
    res.json({ results: rows, total, limit, offset, summary });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Export CSV
// ---------------------------------------------------------------------------

matchRouter.get("/match-runs/:id/export-csv", (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    if (!getMatchRun(db, id)) {
      res.status(404).json({ error: `Execução ${id} não encontrada.` });
      return;
    }
    const onlyDivergent = req.query.onlyDivergent === "true";
    const csv = exportResultsCsv(db, id, onlyDivergent);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="match-${id}${onlyDivergent ? "-divergencias" : ""}.csv"`,
    );
    res.send(csv);
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Aliases de chave de peça (admin)
// ---------------------------------------------------------------------------

const aliasCreateSchema = z.object({
  requestedChavePeca: z.string().min(1),
  stockChavePeca: z.string().min(1),
  reason: z.string().optional().nullable(),
});

matchRouter.get("/part-key-aliases", requireAuth, requireAdmin, (_req, res) => {
  try {
    const rows = getDb().prepare(
      "SELECT * FROM part_key_aliases ORDER BY created_at DESC",
    ).all();
    res.json({ aliases: rows });
  } catch (err) {
    handleError(err, res);
  }
});

matchRouter.post("/part-key-aliases", requireAuth, requireAdmin, (req, res) => {
  try {
    const body = aliasCreateSchema.parse(req.body);
    const db = getDb();
    const reqNorm = normalizeChave(body.requestedChavePeca);
    const stNorm = normalizeChave(body.stockChavePeca);
    const existing = db.prepare(
      "SELECT id FROM part_key_aliases WHERE requested_chave_peca_norm = ? AND active = 1",
    ).get(reqNorm) as { id: number } | undefined;
    if (existing) {
      res.status(409).json({ error: "Já existe um alias ativo para essa chave solicitada." });
      return;
    }
    const result = db.prepare(`
      INSERT INTO part_key_aliases
        (requested_chave_peca, requested_chave_peca_norm, stock_chave_peca, stock_chave_peca_norm, reason, active, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      body.requestedChavePeca, reqNorm,
      body.stockChavePeca, stNorm,
      body.reason ?? null,
      (req as unknown as { sessionUser?: { id: number } }).sessionUser?.id ?? null,
    );
    const row = db.prepare("SELECT * FROM part_key_aliases WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json({ alias: row });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Dados inválidos.", details: err.errors });
      return;
    }
    handleError(err, res);
  }
});

matchRouter.delete("/part-key-aliases/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = idParam(req.params.id);
    const db = getDb();
    const row = db.prepare("SELECT id FROM part_key_aliases WHERE id = ?").get(id) as { id: number } | undefined;
    if (!row) {
      res.status(404).json({ error: "Alias não encontrado." });
      return;
    }
    db.prepare("UPDATE part_key_aliases SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});
