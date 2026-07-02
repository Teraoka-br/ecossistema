import fs from "node:fs";
import { Router } from "express";
import multer from "multer";
import {
  previewDatasysImport, confirmDatasysImport,
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
      });
      res.json(result);
    } catch (err) {
      cleanupFile(req.file?.path);
      if (err instanceof DatasysError) { res.status(422).json({ error: err.message, code: err.code }); return; }
      next(err);
    }
    // Mantém o arquivo temporário até o confirm
  },
);

datasysRouter.post("/datasys/import/confirm", requireAuth, async (req, res, next) => {
  const { importId } = req.body as { importId: number };
  if (!importId) { res.status(400).json({ error: "importId obrigatório." }); return; }

  // Localiza o arquivo temporário do upload (por import_id/filename)
  const imp = (getDb().prepare("SELECT filename FROM datasys_imports WHERE id = ?").get(importId) as { filename: string } | undefined);
  if (!imp) { res.status(404).json({ error: "Importação não encontrada." }); return; }

  // O arquivo foi salvo com o nome dado pelo multer — precisamos encontrá-lo
  // A estratégia é: o preview deve ter retornado o importId após salvar;
  // o arquivo temporário é referenciado via uma convenção simples: busca
  // qualquer arquivo em uploadTmpDir que foi criado recentemente.
  // Por simplicidade nesta fase, aceitamos o filePath no body (do preview).
  const { filePath } = req.body as { importId: number; filePath: string };
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(400).json({ error: "Caminho do arquivo não encontrado. Faça upload novamente." });
    return;
  }

  try {
    const result = await confirmDatasysImport(getDb(), {
      importId,
      filePath,
      userId: req.sessionUser!.id,
    });
    cleanupFile(filePath);
    logAudit(getDb(), {
      userId: req.sessionUser!.id,
      action: "DATASYS_IMPORT_CONFIRMED",
      entityType: "DATASYS_IMPORT",
      entityId: String(importId),
      meta: result,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof DatasysError) { res.status(err.code === "NOT_FOUND" ? 404 : 409).json({ error: err.message, code: err.code }); return; }
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

function cleanupFile(filePath: string | undefined): void {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}
