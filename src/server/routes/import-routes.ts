import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import { getDb } from "../../db/database.js";
import { preview, confirm, ImportError, type FileInput } from "../../import/import-service.js";
import { allowLegacyReimport, getSystemState } from "../../system/system-service.js";

const incomingDir = path.join(config.uploadTmpDir, "incoming");
fs.mkdirSync(incomingDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, incomingDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\- ]+/g, "_");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes, files: 2 },
});

export const importRouter = Router();

// /importar fica somente leitura depois da inicialização — informa o estado
// para o frontend decidir se mostra o formulário ou o aviso somente-leitura.
importRouter.get("/state", (_req, res) => {
  const db = getDb();
  res.json({ state: getSystemState(db), allowLegacyReimport: allowLegacyReimport() });
});

interface UploadedFiles {
  ordersFile?: Express.Multer.File[];
  analysisFile?: Express.Multer.File[];
}

function cleanup(files: Express.Multer.File[]): void {
  for (const f of files) {
    try {
      fs.rmSync(f.path, { force: true });
    } catch {
      /* ignore */
    }
  }
}

importRouter.post(
  "/preview",
  upload.fields([
    { name: "ordersFile", maxCount: 1 },
    { name: "analysisFile", maxCount: 1 },
  ]),
  (req, res) => {
    const files = req.files as UploadedFiles | undefined;
    const ordersUp = files?.ordersFile?.[0];
    const analysisUp = files?.analysisFile?.[0];
    const all = [ordersUp, analysisUp].filter(Boolean) as Express.Multer.File[];

    if (!ordersUp || !analysisUp) {
      cleanup(all);
      return res.status(400).json({
        error: "Envie os dois arquivos: 'ordersFile' (PEDIDOS) e 'analysisFile' (ANALISE MI).",
      });
    }

    let ordersName = ordersUp.originalname;
    let analysisName = analysisUp.originalname;
    if (ordersName === analysisName) analysisName = `${analysisName} (análise)`;

    const orders: FileInput = { filePath: ordersUp.path, fileName: ordersName };
    const analysis: FileInput = { filePath: analysisUp.path, fileName: analysisName };

    try {
      const result = preview(getDb(), orders, analysis);
      res.json(result);
    } catch (err) {
      const status = err instanceof ImportError ? err.statusCode : 500;
      res.status(status).json({ error: (err as Error).message });
    } finally {
      cleanup(all); // o serviço já copiou os arquivos para o diretório do lote
    }
  },
);

const confirmSchema = z.object({ previewBatchId: z.number().int().positive() });

importRouter.post("/confirmar", (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "previewBatchId inválido.", details: parsed.error.flatten() });
  }
  try {
    const result = confirm(getDb(), parsed.data.previewBatchId);
    res.json(result);
  } catch (err) {
    const status = err instanceof ImportError ? err.statusCode : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});
