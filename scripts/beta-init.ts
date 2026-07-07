/**
 * beta-init — Cria data/app-beta.sqlite do zero com todas as migrations.
 *
 * Uso:
 *   npm run beta:init               # cria o banco beta; recusa se já existir
 *   npm run beta:init -- --force    # sobrescreve banco beta existente
 *
 * Após criado, iniciar o servidor com o banco beta:
 *   npm run beta:start
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { getUserCount } from "../src/auth/auth-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const DATA_DIR   = path.join(ROOT, "data");
const BETA_PATH  = path.join(DATA_DIR, "app-beta.sqlite");
const PROD_PATH  = path.join(DATA_DIR, "app.sqlite");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

const force = process.argv.includes("--force");

async function main(): Promise<void> {
  // Garantir diretório de dados
  fs.mkdirSync(DATA_DIR,   { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Backup do banco de produção (não-destrutivo)
  if (fs.existsSync(PROD_PATH)) {
    const stamp   = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const bkpPath = path.join(BACKUP_DIR, `app.sqlite.bkp-${stamp}`);
    fs.copyFileSync(PROD_PATH, bkpPath);
    console.log(`Backup do banco de produção criado: ${bkpPath}`);
  }

  // Recusar sobrescrever sem --force
  if (fs.existsSync(BETA_PATH)) {
    if (!force) {
      console.error(`Banco beta já existe em: ${BETA_PATH}`);
      console.error("Use --force para sobrescrever: npm run beta:init -- --force");
      process.exit(1);
    }
    fs.unlinkSync(BETA_PATH);
    // Remover WAL/SHM residuais
    for (const ext of ["-wal", "-shm"]) {
      const f = BETA_PATH + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    console.log("Banco beta anterior removido.");
  }

  // Abrir banco beta e aplicar todas as migrations
  const db = openDatabase(BETA_PATH);
  runMigrations(db, { backup: false });
  console.log("Migrations aplicadas.");

  // Criar usuário administrador padrão
  const count = getUserCount(db);
  if (count === 0) {
    const DEFAULT_PIN = process.env.BETA_ADMIN_PIN ?? "1234";
    const { setupFirstUser } = await import("../src/auth/auth-service.js");
    await setupFirstUser(db, {
      username:    "admin",
      displayName: "Administrador Beta",
      pin:         DEFAULT_PIN,
    });
    console.log(`Usuário admin criado. PIN: ${DEFAULT_PIN}  (altere via BETA_ADMIN_PIN=xxxx)`);
  } else {
    console.log(`Banco já tem ${count} usuário(s) — não criou usuário padrão.`);
  }

  db.close();
  console.log(`\nBanco beta pronto: ${BETA_PATH}`);
  console.log("Para iniciar com este banco execute:  npm run beta:start");
}

main().catch((err) => {
  console.error("Erro fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
