import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import { config } from "./config.js";
import { importRouter } from "./routes/import-routes.js";
import { dataRouter } from "./routes/data-routes.js";
import { countingRouter } from "./routes/counting-routes.js";
import { procurementRouter } from "./routes/procurement-routes.js";
import { matchRouter } from "./routes/match-routes.js";
import { separationRouter } from "./routes/separation-routes.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/importar", importRouter);
  app.use("/api", dataRouter);
  app.use("/api", countingRouter);
  app.use("/api", procurementRouter);
  app.use("/api", matchRouter);
  app.use("/api", separationRouter);

  // Em produção, serve o frontend compilado e faz fallback de SPA.
  if (fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(config.clientDist, "index.html"));
    });
  }

  // Handler de erro final (ex.: arquivo acima do limite do multer).
  app.use(
    (err: Error & { status?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = err.status ?? (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
      res.status(status).json({ error: err.message || "Erro interno." });
    },
  );

  return app;
}
