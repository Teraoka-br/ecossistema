import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { importRouter } from "./routes/import-routes.js";
import { dataRouter } from "./routes/data-routes.js";
import { countingRouter } from "./routes/counting-routes.js";
import { procurementRouter } from "./routes/procurement-routes.js";
import { partKeyAliasRouter } from "./routes/part-key-alias-routes.js";
import { partCompatibilityRouter } from "./routes/part-compatibility-routes.js";
import { authRouter } from "./routes/auth-routes.js";
import { staffRouter } from "./routes/staff-routes.js";
import { repairRouter } from "./routes/repair-routes.js";
import { datasysRouter } from "./routes/datasys-routes.js";
import { repairQueueRouter } from "./routes/repair-queue-routes.js";
import { importCentralRouter } from "./routes/import-central-routes.js";
import { analiseRouter } from "./routes/analise-routes.js";
import { dashboardsRouter } from "./routes/dashboards-routes.js";
import { issueRouter } from "./routes/issue-routes.js";
import { notificationsRouter } from "./routes/notifications-routes.js";
import { requireAuth } from "./middleware/auth-middleware.js";
import { getDb } from "../db/database.js";

export function createApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));

  // ─── Públicas (não exigem auth) ──────────────────────────────────────────
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/runtime-info", (_req, res) => {
    const dbPath = config.databasePath;
    const dbFile = dbPath === ":memory:" ? ":memory:" : path.basename(dbPath);
    res.json({
      mode: process.env.BETA_MODE === "true" ? "BETA" : process.env.NODE_ENV === "production" ? "PRODUCAO" : "DEV",
      databasePath: dbPath,
      databaseFile: dbFile,
      apiPort: config.serverPort,
      nodeEnv: process.env.NODE_ENV ?? "development",
    });
  });

  app.get("/api/ready", (_req, res) => {
    const checks: Record<string, boolean | string | number> = {};
    try {
      const db = getDb();
      const migrations = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
      checks.db = true;
      checks.migrations = migrations.c;

      const tables = ["repair_cases", "repair_match_results", "operational_reservations", "stock_movements"];
      for (const t of tables) {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
        checks[t] = !!row;
      }

      const cols = db.prepare("PRAGMA table_info(repair_match_results)").all() as { name: string }[];
      checks.allocated_reference_norm_col = cols.some(c => c.name === "allocated_reference_norm");

      const allOk = Object.values(checks).every(v => v === true || typeof v === "number" && v > 0);
      res.status(allOk ? 200 : 503).json({ ok: allOk, checks });
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message, checks });
    }
  });
  app.use("/api/auth", authRouter);

  // ─── Protegidas ──────────────────────────────────────────────────────────
  app.use("/api/importar", requireAuth, importRouter);
  app.use("/api", requireAuth, dataRouter);
  app.use("/api", requireAuth, countingRouter);
  app.use("/api", requireAuth, procurementRouter);
  app.use("/api", requireAuth, partKeyAliasRouter);
  app.use("/api", requireAuth, partCompatibilityRouter);
  app.use("/api", staffRouter);          // middleware requireAuth aplicado internamente
  app.use("/api", repairRouter);         // idem
  app.use("/api", datasysRouter);        // idem
  app.use("/api", repairQueueRouter);   // fila, reservas, motor, regras
  app.use("/api/import-central", importCentralRouter);  // central de dados
  app.use("/api/analise", analiseRouter);               // análise de aparelho
  app.use("/api", dashboardsRouter);                    // dashboards administrativos
  app.use("/api", requireAuth, issueRouter);            // central de problemas
  app.use("/api", requireAuth, notificationsRouter);    // notificações

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
