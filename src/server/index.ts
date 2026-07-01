import { config } from "./config.js";
import { getDb } from "../db/database.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "./app.js";

function main(): void {
  // Garante o esquema atualizado antes de aceitar requisições.
  const db = getDb();
  const outcome = runMigrations(db, { backup: true });
  if (!outcome.alreadyUpToDate) {
    console.log(`[server] ${outcome.applied.length} migration(s) aplicada(s).`);
  }

  const app = createApp();
  app.listen(config.serverPort, config.serverHost, () => {
    console.log(`[server] API ouvindo em http://${config.serverHost}:${config.serverPort}`);
    console.log(`[server] banco: ${config.databasePath}`);
    if (config.serverHost === "127.0.0.1" || config.serverHost === "localhost") {
      console.log("[server] beta local — somente arquivos confiáveis, sem autenticação.");
    }
  });
}

main();
