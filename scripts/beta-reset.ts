/**
 * beta-reset — Arquiva o banco beta atual e cria um banco beta limpo.
 *
 * Uso: npm run beta:reset
 *
 * Comportamento:
 *  1. Move data/app-beta.sqlite → data/archive/app-beta-YYYYMMDD-HHmmss.sqlite
 *  2. Cria novo data/app-beta.sqlite com todas as migrations aplicadas
 *  3. Cria usuário admin padrão (PIN: BETA_ADMIN_PIN ou "1234")
 *
 * Nunca toca data/app.sqlite.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { setupFirstUser } from "../src/auth/auth-service.js";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT        = path.resolve(__dirname, "..");
const DATA_DIR    = path.join(ROOT, "data");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const BETA_PATH   = path.join(DATA_DIR, "app-beta.sqlite");

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR,    { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  // 1. Arquivar banco beta atual (se existir)
  let archivePath: string | null = null;
  if (fs.existsSync(BETA_PATH)) {
    archivePath = path.join(ARCHIVE_DIR, `app-beta-${stamp()}.sqlite`);
    fs.renameSync(BETA_PATH, archivePath);
    for (const ext of ["-wal", "-shm"]) {
      const f = BETA_PATH + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    console.log(`Banco anterior arquivado: ${archivePath}`);
  } else {
    console.log("Nenhum banco beta existente — criando do zero.");
  }

  // 2. Criar banco beta limpo com todas as migrations
  const db = openDatabase(BETA_PATH);
  runMigrations(db, { backup: false });
  console.log("Migrations aplicadas.");

  // 3. Criar usuário administrador padrão
  const DEFAULT_PIN = process.env.BETA_ADMIN_PIN ?? "1234";
  await setupFirstUser(db, {
    username:    "admin",
    displayName: "Administrador Beta",
    pin:         DEFAULT_PIN,
  });
  console.log(`Usuário admin criado. PIN: ${DEFAULT_PIN}  (altere via BETA_ADMIN_PIN=xxxx)`);

  db.close();

  console.log(`\nBanco beta resetado : ${BETA_PATH}`);
  if (archivePath) console.log(`Backup arquivado    : ${archivePath}`);
  console.log("Para iniciar execute: npm run beta:start");
}

main().catch((err) => {
  console.error("Erro fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
