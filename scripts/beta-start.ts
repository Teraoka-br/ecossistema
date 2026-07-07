/**
 * beta-start — Inicia o servidor apontando para data/app-beta.sqlite.
 *
 * Uso: npm run beta:start
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const BETA_PATH = path.join(ROOT, "data", "app-beta.sqlite");

if (!fs.existsSync(BETA_PATH)) {
  console.error(`Banco beta não encontrado: ${BETA_PATH}`);
  console.error("Execute primeiro: npm run beta:init");
  process.exit(1);
}

const isProduction = fs.existsSync(path.join(ROOT, "dist", "server", "server", "index.js"));
const env = { ...process.env, DATABASE_PATH: BETA_PATH };

let child;
if (isProduction) {
  console.log("[beta:start] Modo produção (dist/). DATABASE_PATH =", BETA_PATH);
  child = spawn("node", ["dist/server/server/index.js"], { cwd: ROOT, env, stdio: "inherit", shell: false });
} else {
  console.log("[beta:start] Modo dev (tsx watch). DATABASE_PATH =", BETA_PATH);
  child = spawn(
    "npx",
    ["concurrently", "-k", "-n", "server,client", "-c", "blue,magenta",
      `tsx watch src/server/index.ts`,
      `vite`,
    ],
    { cwd: ROOT, env, stdio: "inherit", shell: true },
  );
}

child.on("exit", (code) => process.exit(code ?? 0));
