import os from "node:os";
import { config } from "./config.js";
import { getDb } from "../db/database.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "./app.js";
import { processPendingRecompute } from "../match/engine-orchestrator.js";

function main(): void {
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
    console.log(`[server] banco: ${config.databasePath}`);
    console.log(`[server] Local:   http://localhost:${config.serverPort}`);
    if (config.serverHost === "0.0.0.0") {
      const lanIp = getLanIp();
      if (lanIp) {
        console.log(`[server] Rede:    http://${lanIp}:${config.serverPort}`);
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
