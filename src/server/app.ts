import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { importRouter } from "./routes/import-routes.js";
import { dataRouter } from "./routes/data-routes.js";
import { countingRouter } from "./routes/counting-routes.js";
import { procurementRouter } from "./routes/procurement-routes.js";
import { matchRouter } from "./routes/match-routes.js";
import { separationRouter } from "./routes/separation-routes.js";
import { authRouter } from "./routes/auth-routes.js";
import { staffRouter } from "./routes/staff-routes.js";
import { repairRouter } from "./routes/repair-routes.js";
import { datasysRouter } from "./routes/datasys-routes.js";
import { repairQueueRouter } from "./routes/repair-queue-routes.js";
import { requireAuth } from "./middleware/auth-middleware.js";

export function createApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));

  // ─── Públicas (não exigem auth) ──────────────────────────────────────────
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);

  // ─── Protegidas ──────────────────────────────────────────────────────────
  app.use("/api/importar", requireAuth, importRouter);
  app.use("/api", requireAuth, dataRouter);
  app.use("/api", requireAuth, countingRouter);
  app.use("/api", requireAuth, procurementRouter);
  app.use("/api", requireAuth, matchRouter);
  app.use("/api", requireAuth, separationRouter);
  app.use("/api", staffRouter);          // middleware requireAuth aplicado internamente
  app.use("/api", repairRouter);         // idem
  app.use("/api", datasysRouter);        // idem
  app.use("/api", repairQueueRouter);   // fila, reservas, motor, regras

  // Em produção, serve o frontend compilado e faz fallback de SPA.
  if (fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(config.clientDist, "index.html"));
    });
  }

  // Handler de erro final
  app.use(
    (err: Error & { status?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = err.status ?? (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
      res.status(status).json({ error: err.message || "Erro interno." });
    },
  );

  return app;
}
