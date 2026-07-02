import { Router } from "express";
import multer from "multer";
import {
  previewDatasysImport, confirmDatasysImport, cancelDatasysPreview,
  listDatasysImports, searchDatasysRecords, DatasysError,
} from "../../datasys/datasys-service.js";
import { getDb } from "../../db/database.js";
import { requireAuth } from "../middleware/auth-middleware.js";
import { logAudit } from "../../audit/audit-service.js";
import { config } from "../config.js";

export const datasysRouter = Router();

const upload = multer({
  dest: config.uploadTmpDir,
  limits: { fileSize: config.maxUploadBytes },
});

datasysRouter.post(
  "/datasys/import/preview",
  requireAuth,
  upload.single("file"),
  async (req, res, next) => {
    if (!req.file) { res.status(400).json({ error: "Arquivo não enviado." }); return; }
    try {
      const result = await previewDatasysImport(getDb(), {
        filePath: req.file.path,
        filename: req.file.originalname,
        userId: req.sessionUser!.id,
        uploadDir: config.uploadTmpDir,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof DatasysError) { res.status(422).json({ error: err.message, code: err.code }); return; }
      next(err);
    }
  },
);

datasysRouter.post("/datasys/import/confirm", requireAuth, async (req, res, next) => {
  const { importId } = req.body as { importId?: number };
  if (!importId) { res.status(400).json({ error: "importId obrigatório." }); return; }

  try {
    const result = await confirmDatasysImport(getDb(), {
      importId,
      userId: req.sessionUser!.id,
      uploadDir: config.uploadTmpDir,
    });
    logAudit(getDb(), {
      userId: req.sessionUser!.id,
      action: "DATASYS_IMPORT_CONFIRMED",
      entityType: "DATASYS_IMPORT",
      entityId: String(importId),
      meta: result,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof DatasysError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "ALREADY_IMPORTED" ? 409 : 422;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
});

datasysRouter.delete("/datasys/import/:id", requireAuth, (req, res, next) => {
  const importId = Number(req.params.id);
  try {
    cancelDatasysPreview(getDb(), importId, req.sessionUser!.id);
    logAudit(getDb(), {
      userId: req.sessionUser!.id,
      action: "DATASYS_IMPORT_CANCELLED",
      entityType: "DATASYS_IMPORT",
      entityId: String(importId),
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DatasysError) {
      const status = err.code === "NOT_FOUND" ? 404 : 409;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
});

datasysRouter.get("/datasys/imports", requireAuth, (_req, res) => {
  res.json({ imports: listDatasysImports(getDb()) });
});

datasysRouter.get("/datasys/search", requireAuth, (req, res) => {
  const imei = req.query.imei as string | undefined;
  const os = req.query.os as string | undefined;
  if (!imei && !os) { res.status(400).json({ error: "Informe imei ou os para buscar." }); return; }
  const records = searchDatasysRecords(getDb(), { imei, os });
  res.json({ records });
});
