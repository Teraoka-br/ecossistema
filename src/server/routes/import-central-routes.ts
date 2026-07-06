import { Router, type Request } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { getDb } from "../../db/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth-middleware.js";
import { config } from "../config.js";
import {
  ImportCentralError,
  type SourceKey,
  getAllSourcesStatus,
  getSourceHistory,
  cancelImport,
  getLegadoStatus,
  cancelStaging,
  listStagingBySource,
  expireOldStagings,
  previewHis, confirmHis,
  previewRelSeriais, confirmRelSeriais,
  previewAnaliseMi, confirmAnaliseMi,
  previewPedidos, confirmPedidos,
  previewBkp, confirmBkp,
  previewTriagemSaida, confirmTriagemSaida,
  previewSh, confirmSh,
} from "../../import-central/import-central-service.js";
import {
  applyHisToRepairCases,
  applyRelSeriaisToRepairCases,
  applyAnaliseMiToRepairCases,
  applyBipagemToStock,
  applyPeacsToRepairCases,
  applyPedidosReconciliation,
} from "../../import-central/operational-sync-service.js";

export const importCentralRouter = Router();

const VALID_SOURCES: SourceKey[] = [
  "his", "rel-seriais", "analise-mi", "pedidos", "bkp", "triagem-saida", "sh",
];

const upload = multer({
  dest: config.uploadTmpDir,
  limits: { fileSize: config.maxUploadBytes },
});

// ---------------------------------------------------------------------------
// Status geral
// ---------------------------------------------------------------------------

importCentralRouter.get("/status", requireAuth, requireAdmin, (_req, res, next) => {
  try {
    const db = getDb();
    const status = getAllSourcesStatus(db);
    const legado = getLegadoStatus(db);
    res.json({ status, legado });
  } catch (err) {
    next(err);
  }
});

importCentralRouter.get("/legado/status", requireAuth, requireAdmin, (_req, res, next) => {
  try {
    res.json(getLegadoStatus(getDb()));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Histórico por fonte
// ---------------------------------------------------------------------------

importCentralRouter.get("/:source/history", requireAuth, requireAdmin, (req, res, next) => {
  try {
    const source = req.params.source as SourceKey;
    if (!VALID_SOURCES.includes(source)) return res.status(400).json({ error: "Fonte inválida." });
    res.json({ history: getSourceHistory(getDb(), source) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Staging — listar, cancelar
// ---------------------------------------------------------------------------

importCentralRouter.get("/:source/staged", requireAuth, requireAdmin, (req, res, next) => {
  try {
    const source = req.params.source as SourceKey;
    if (!VALID_SOURCES.includes(source)) return res.status(400).json({ error: "Fonte inválida." });
    res.json({ staged: listStagingBySource(getDb(), source) });
  } catch (err) {
    next(err);
  }
});

importCentralRouter.delete("/:source/staged/:id", requireAuth, requireAdmin, (req, res, next) => {
  try {
    const source = req.params.source as SourceKey;
    if (!VALID_SOURCES.includes(source)) return res.status(400).json({ error: "Fonte inválida." });
    const stagingId = parseInt(req.params.id);
    if (isNaN(stagingId)) return res.status(400).json({ error: "id inválido." });
    const { stagedPath } = cancelStaging(getDb(), stagingId);
    if (stagedPath) {
      try { fs.unlinkSync(stagedPath); } catch { /* ignore */ }
    }
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ImportCentralError) {
      return res.status(err.code === "NOT_FOUND" ? 404 : 409).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Cancel import record
// ---------------------------------------------------------------------------

importCentralRouter.delete("/:source/imports/:id", requireAuth, requireAdmin, (req, res, next) => {
  try {
    const source = req.params.source as SourceKey;
    if (!VALID_SOURCES.includes(source)) return res.status(400).json({ error: "Fonte inválida." });
    const importId = parseInt(req.params.id);
    if (isNaN(importId)) return res.status(400).json({ error: "id inválido." });
    cancelImport(getDb(), source, importId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ImportCentralError) {
      return res.status(err.code === "NOT_FOUND" ? 404 : 409).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Upload → Preview (DB-backed staging)
// ---------------------------------------------------------------------------

type PreviewFn = (
  db: ReturnType<typeof getDb>,
  filePath: string,
  filename: string,
  userId: number | null,
) => Promise<unknown>;

const previewFns: Record<SourceKey, PreviewFn> = {
  his:             (db, fp, fn, uid) => previewHis(db, fp, fn, uid),
  "rel-seriais":   (db, fp, fn, uid) => previewRelSeriais(db, fp, fn, uid),
  "analise-mi":    (db, fp, fn, uid) => previewAnaliseMi(db, fp, fn, uid),
  pedidos:         (db, fp, fn, uid) => previewPedidos(db, fp, fn, uid),
  bkp:             (db, fp, fn, uid) => previewBkp(db, fp, fn, uid),
  "triagem-saida": (db, fp, fn, uid) => previewTriagemSaida(db, fp, fn, uid),
  sh:              (db, fp, fn, uid) => previewSh(db, fp, fn, uid),
};

importCentralRouter.post(
  "/:source/preview",
  requireAuth,
  requireAdmin,
  upload.single("file"),
  async (req, res, next) => {
    const source = req.params.source as SourceKey;
    if (!VALID_SOURCES.includes(source)) return res.status(400).json({ error: "Fonte inválida." });
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado." });

    const userId = (req as Request).sessionUser!.id;

    // Move para caminho nomeado com TTL (staging persistente)
    const ext = path.extname(req.file.originalname) || "";
    const stagedPath = path.join(
      config.uploadTmpDir,
      `staged-${source}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
    );
    try {
      fs.renameSync(req.file.path, stagedPath);
    } catch {
      fs.copyFileSync(req.file.path, stagedPath);
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }

    try {
      const db = getDb();
      // Expirar previews antigos em background
      const expired = expireOldStagings(db);
      for (const p of expired) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

      const result = await previewFns[source](db, stagedPath, req.file.originalname, userId);
      res.json(result as object);
    } catch (err) {
      // O staging já foi marcado como FAILED no service; só limpa o arquivo físico
      try { fs.unlinkSync(stagedPath); } catch { /* ignore */ }
      if (err instanceof ImportCentralError) {
        return res.status(422).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Confirm (usa stagingId em vez de importId+filePath em memória)
// ---------------------------------------------------------------------------

type ConfirmFn = (
  db: ReturnType<typeof getDb>,
  stagingId: number,
  userId: number | null,
) => Promise<unknown>;

const confirmFns: Record<SourceKey, ConfirmFn> = {
  his:             async (db, sid, uid) => confirmHis(db, sid, uid),
  "rel-seriais":   (db, sid, uid) => confirmRelSeriais(db, sid, uid),
  "analise-mi":    async (db, sid, uid) => confirmAnaliseMi(db, sid, uid),
  pedidos:         async (db, sid, uid) => confirmPedidos(db, sid, uid),
  bkp:             async (db, sid, uid) => confirmBkp(db, sid, uid),
  "triagem-saida": async (db, sid, uid) => confirmTriagemSaida(db, sid, uid),
  sh:              async (db, sid, uid) => confirmSh(db, sid, uid),
};

importCentralRouter.post("/:source/confirm", requireAuth, requireAdmin, async (req, res, next) => {
  const source = req.params.source as SourceKey;
  if (!VALID_SOURCES.includes(source)) return res.status(400).json({ error: "Fonte inválida." });

  const { stagingId } = req.body as { stagingId?: number };
  if (!stagingId) return res.status(400).json({ error: "stagingId obrigatório." });

  const userId = (req as Request).sessionUser!.id;

  try {
    const db = getDb();
    const result = await confirmFns[source](db, stagingId, userId);

    // Recuperar importId criado pelo confirm (via staged_files)
    const importIdRow = db
      .prepare(`SELECT import_id_created FROM import_staged_files WHERE id = ?`)
      .get(stagingId) as { import_id_created: number | null } | undefined;
    const importId = importIdRow?.import_id_created ?? null;

    // Aplicar sync operacional e coletar resultados — falha não desfaz a importação
    const sync: Record<string, unknown> = {};
    let shouldTriggerMatch = false;

    if (importId) {
      try {
        if (source === "his") {
          sync.his = applyHisToRepairCases(db, importId);
          shouldTriggerMatch = true;
        } else if (source === "rel-seriais") {
          sync.relSeriais = applyRelSeriaisToRepairCases(db, importId);
        } else if (source === "analise-mi") {
          sync.analiseMi = applyAnaliseMiToRepairCases(db, importId);
          shouldTriggerMatch = true;
        } else if (source === "pedidos") {
          try { sync.bipagem = applyBipagemToStock(db, importId); } catch (e) { sync.bipagemError = (e as Error).message; }
          try { sync.peacs = applyPeacsToRepairCases(db); } catch (e) { sync.peacsError = (e as Error).message; }
          try { sync.reconciliacao = applyPedidosReconciliation(db, importId); } catch (e) { sync.reconciliacaoError = (e as Error).message; }
          shouldTriggerMatch = true;
        }
      } catch (syncErr) {
        sync.syncError = (syncErr as Error).message;
      }
    }

    // Disparar recompute do motor após imports relevantes — falha não desfaz a importação
    let matchTriggered = false;
    let matchError: string | null = null;
    if (shouldTriggerMatch) {
      try {
        const { requestMatchRecompute } = await import("../../match/engine-orchestrator.js");
        requestMatchRecompute(db, `IMPORT_${source}_${importId}`, "import_central", importId ?? 0);
        matchTriggered = true;
      } catch (e) {
        matchError = (e as Error).message;
      }
    }

    res.json({ ok: true, ...(result as object), sync, matchTriggered, matchError });
  } catch (err) {
    if (err instanceof ImportCentralError) {
      const status =
        err.code === "NOT_FOUND" ? 404 :
        err.code === "ALREADY_IMPORTED" ? 409 :
        err.code === "FILE_GONE" ? 410 : 422;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});
