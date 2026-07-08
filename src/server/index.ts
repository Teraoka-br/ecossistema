import os from "node:os";
import { config } from "./config.js";
import { getDb } from "../db/database.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "./app.js";
import { processPendingRecompute } from "../match/engine-orchestrator.js";

const IS_BETA = process.env.BETA_MODE === "true";

function validateBetaEnv(): void {
  if (!IS_BETA) return;

  const dbPath = config.databasePath;
  if (!dbPath.endsWith("app-beta.sqlite")) {
    console.error("=".repeat(60));
    console.error("[server] ERRO FATAL — beta:start exige app-beta.sqlite");
    console.error("[server] DATABASE_PATH atual:", dbPath);
    console.error("[server] Defina DATABASE_PATH=data/app-beta.sqlite");
    console.error("[server] ou execute: npm run beta:init && npm run beta:start");
    console.error("=".repeat(60));
    process.exit(1);
  }
}

function printBanner(): void {
  const mode = IS_BETA ? "BETA (tsx watch)" : config.isProduction ? "PRODUÇÃO (dist/)" : "DEV";
  console.log("=".repeat(60));
  console.log(`[server] Modo          : ${mode}`);
  console.log(`[server] DATABASE_PATH : ${config.databasePath}`);
  console.log(`[server] Porta         : ${config.serverPort}`);
  if (IS_BETA) {
    console.log("[server] Frontend beta : http://localhost:5173  ← use esta URL");
    console.log("[server] API           : http://localhost:3001/api");
    console.log("[server] NUNCA acesse  : http://localhost:3001 diretamente no beta");
  }
  console.log("=".repeat(60));
}

function main(): void {
  validateBetaEnv();

  // Garante o esquema atualizado antes de aceitar requisições.
  const db = getDb();
  const outcome = runMigrations(db, { backup: true });
  if (!outcome.alreadyUpToDate) {
    console.log(`[server] ${outcome.applied.length} migration(s) aplicada(s).`);
  }

  // Dispara motor de match para recompute pendente (não-bloqueante).
  processPendingRecompute(db).catch(err =>
    console.warn("[server] match-engine startup recompute:", (err as Error).message)
  );

  const app = createApp();
  app.listen(config.serverPort, config.serverHost, () => {
    printBanner();
    if (config.serverHost === "0.0.0.0") {
      const lanIp = getLanIp();
      if (lanIp) {
        console.log(`[server] Rede LAN      : http://${lanIp}:${config.serverPort}/api`);
      }
      console.log("[server] Atenção: sem autenticação — use somente em rede local confiável.");
    }
  });
}

function getLanIp(): string | undefined {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return undefined;
}

main();
