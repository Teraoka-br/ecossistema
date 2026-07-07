/**
 * beta-start-prod — Inicia o servidor beta em modo produção a partir de dist/.
 * Exige que dist/ exista (npm run build deve ter sido executado antes).
 *
 * Uso: npm run beta:start:prod
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const BETA_PATH  = path.join(ROOT, "data", "app-beta.sqlite");
const SERVER_JS  = path.join(ROOT, "dist", "server", "server", "index.js");

if (!fs.existsSync(BETA_PATH)) {
  console.error(`Banco beta não encontrado: ${BETA_PATH}`);
  console.error("Execute primeiro: npm run beta:init");
  process.exit(1);
}

if (!fs.existsSync(SERVER_JS)) {
  console.error(`dist/ não encontrado: ${SERVER_JS}`);
  console.error("Execute primeiro: npm run build");
  process.exit(1);
}

const env = { ...process.env, DATABASE_PATH: BETA_PATH };

console.log("[beta:start:prod] Modo produção (dist/). DATABASE_PATH =", BETA_PATH);
const child = spawn("node", [SERVER_JS], { cwd: ROOT, env, stdio: "inherit", shell: false });

child.on("exit", (code) => process.exit(code ?? 0));
