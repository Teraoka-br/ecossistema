/**
 * beta-start — Inicia o servidor beta SEMPRE em modo desenvolvimento.
 * Usa dois processos separados: tsx watch (backend) + vite (frontend).
 * Nunca usa dist/.
 *
 * Frontend oficial : http://localhost:5173
 * Backend/API      : http://localhost:3001/api
 * Banco            : data/app-beta.sqlite
 *
 * Uso: npm run beta:start
 * Para parar: npm run beta:stop  (ou Ctrl+C)
 * Para modo produção (dist/): npm run beta:start:prod
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const BETA_PATH = path.join(ROOT, "data", "app-beta.sqlite");
const PID_FILE  = path.join(ROOT, ".beta-pids");

// ---------------------------------------------------------------------------
// Validações iniciais
// ---------------------------------------------------------------------------

if (!fs.existsSync(BETA_PATH)) {
  console.error("[beta:start] ERRO: banco beta não encontrado:", BETA_PATH);
  console.error("[beta:start] Execute primeiro: npm run beta:init");
  process.exit(1);
}

// Usa npx.cmd no Windows para garantir que o executável seja encontrado
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const env = {
  ...process.env,
  DATABASE_PATH: BETA_PATH,
  BETA_MODE: "true",
};

console.log("=".repeat(60));
console.log("[beta:start] Modo: desenvolvimento (tsx watch + Vite)");
console.log("[beta:start] DATABASE_PATH :", BETA_PATH);
console.log("[beta:start] Frontend       : http://localhost:5173");
console.log("[beta:start] Backend/API    : http://localhost:3001/api");
console.log("[beta:start] NUNCA abra     : http://localhost:3001 diretamente");
console.log("=".repeat(60));

// ---------------------------------------------------------------------------
// Iniciar backend: tsx watch src/server/index.ts
// ---------------------------------------------------------------------------

const server: ChildProcess = spawn(
  npx,
  ["tsx", "watch", "src/server/index.ts"],
  { cwd: ROOT, env, stdio: "inherit", shell: false },
);

// ---------------------------------------------------------------------------
// Iniciar frontend (vite)
// ---------------------------------------------------------------------------

const client: ChildProcess = spawn(
  npx,
  ["vite", "--host", "0.0.0.0"],
  { cwd: ROOT, env, stdio: "inherit", shell: false },
);

// ---------------------------------------------------------------------------
// Registra PIDs para beta:stop
// ---------------------------------------------------------------------------

function writePids(): void {
  const pids = [server.pid, client.pid].filter(Boolean).join("\n");
  try { fs.writeFileSync(PID_FILE, pids, "utf8"); } catch { /* ignore */ }
}

server.on("spawn", writePids);
client.on("spawn", writePids);

// ---------------------------------------------------------------------------
// Propagação de saída
// ---------------------------------------------------------------------------

function killAll(): void {
  try { server.kill(); } catch { /* já morto */ }
  try { client.kill(); } catch { /* já morto */ }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

server.on("exit", (code) => {
  console.log("[beta:start] backend encerrado (código", code, ")");
  killAll();
  process.exit(code ?? 0);
});

client.on("exit", (code) => {
  console.log("[beta:start] frontend encerrado (código", code, ")");
  killAll();
  process.exit(code ?? 0);
});

process.on("SIGINT",  killAll);
process.on("SIGTERM", killAll);
