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
  previewRelSeriais, confirmRelSeriais,
  previewSh, confirmSh,
  previewHis, confirmHis,
  previewBkp, confirmBkp,
  previewTriagemSaida, confirmTriagemSaida,
  previewPeacs, confirmPeacs,
} from "../../import-central/import-central-service.js";

export const importCentralRouter = Router();

const upload = multer({
  dest: config.uploadTmpDir,
  limits: { fileSize: config.maxUploadBytes },
});

// ---------------------------------------------------------------------------
// Status geral de todas as fontes
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

// ---------------------------------------------------------------------------
// Legado (somente leitura)
// ---------------------------------------------------------------------------

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
    const validSources: SourceKey[] = ["rel-seriais", "sh", "his", "bkp", "triagem-saida", "peacs"];
    if (!validSources.includes(source)) return res.status(400).json({ error: "Fonte inválida." });
    res.json({ history: getSourceHistory(getDb(), source) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

importCentralRouter.delete("/:source/imports/:id", requireAuth, requireAdmin, (req, res, next) => {
  try {
    const db = getDb();
    const source = req.params.source as SourceKey;
    const importId = parseInt(req.params.id);
    const userId = (req as Request).sessionUser!.id;
    cancelImport(db, source, importId, userId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ImportCentralError) {
      const status = err.code === "NOT_FOUND" ? 404 : 409;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Upload → Preview (per source)
// ---------------------------------------------------------------------------

type PreviewFn = (db: ReturnType<typeof getDb>, filePath: string, filename: string, userId: number | null) => Promise<unknown>;

const previewFns: Record<SourceKey, PreviewFn> = {
  "rel-seriais":   (db, fp, fn, uid) => previewRelSeriais(db, fp, fn, uid),
  sh:              (db, fp, fn, uid) => previewSh(db, fp, fn, uid),
  his:             (db, fp, fn, uid) => previewHis(db, fp, fn, uid),
  bkp:             (db, fp, fn, uid) => previewBkp(db, fp, fn, uid),
  "triagem-saida": (db, fp, fn, uid) => previewTriagemSaida(db, fp, fn, uid),
  peacs:           (db, fp, fn, uid) => previewPeacs(db, fp, fn, uid),
};

importCentralRouter.post(
  "/:source/preview",
  requireAuth, requireAdmin,
  upload.single("file"),
  async (req, res, next) => {
    const source = req.params.source as SourceKey;
    const validSources = Object.keys(previewFns) as SourceKey[];
    if (!validSources.includes(source)) return res.status(400).json({ error: "Fonte inválida." });
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado." });

    const userId = (req as Request).sessionUser!.id;
    const filePath = req.file.path;
    const filename = req.file.originalname;

    // Stage the file for confirm step (move to named location so it survives temp cleanup)
    const stagedPath = path.join(config.uploadTmpDir, `import-central-${source}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.copyFileSync(filePath, stagedPath);
    fs.unlinkSync(filePath);

    try {
      const db = getDb();
      const result = await previewFns[source](db, stagedPath, filename, userId);

      // Store staged file path in-memory (preview→confirm, same process)
      stagedFiles.set(`${source}:${(result as { importId: number }).importId}`, stagedPath);

      res.json({ ...result as object, stagedPath: undefined });
    } catch (err) {
      // Clean up staged file on error
      try { fs.unlinkSync(stagedPath); } catch { /* ignore */ }
      if (err instanceof ImportCentralError) {
        return res.status(422).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  },
);

// In-memory map: "source:importId" → staged file path
// Fine for single-process usage; restarts lose pending previews (user must re-upload)
const stagedFiles = new Map<string, string>();

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

type ConfirmFn = (db: ReturnType<typeof getDb>, importId: number, filePath: string, userId: number | null) => unknown;

const confirmFns: Record<SourceKey, ConfirmFn> = {
  "rel-seriais":   (db, id, fp, uid) => confirmRelSeriais(db, id, fp, uid),
  sh:              (db, id, fp, uid) => confirmSh(db, id, fp, uid),
  his:             (db, id, fp, uid) => confirmHis(db, id, fp, uid),
  bkp:             (db, id, fp, uid) => confirmBkp(db, id, fp, uid),
  "triagem-saida": (db, id, fp, uid) => confirmTriagemSaida(db, id, fp, uid),
  peacs:           (db, id, fp, uid) => confirmPeacs(db, id, fp, uid),
};

importCentralRouter.post("/:source/confirm", requireAuth, requireAdmin, (req, res, next) => {
  const source = req.params.source as SourceKey;
  const validSources = Object.keys(confirmFns) as SourceKey[];
  if (!validSources.includes(source)) return res.status(400).json({ error: "Fonte inválida." });

  const { importId } = req.body as { importId?: number };
  if (!importId) return res.status(400).json({ error: "importId obrigatório." });

  const stagedKey = `${source}:${importId}`;
  const stagedPath = stagedFiles.get(stagedKey);
  if (!stagedPath || !fs.existsSync(stagedPath)) {
    return res.status(410).json({ error: "Arquivo temporário não encontrado. Faça o upload novamente.", code: "STAGED_FILE_GONE" });
  }

  const userId = (req as Request).sessionUser!.id;

  try {
    const db = getDb();
    const result = confirmFns[source](db, importId, stagedPath, userId);
    stagedFiles.delete(stagedKey);
    try { fs.unlinkSync(stagedPath); } catch { /* ignore */ }
    res.json({ ok: true, ...(result as object) });
  } catch (err) {
    if (err instanceof ImportCentralError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "ALREADY_IMPORTED" ? 409 : 422;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});
