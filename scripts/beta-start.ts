/**
 * beta-start — Inicia o servidor beta SEMPRE em modo desenvolvimento.
 * Usa dois processos separados: tsx watch (backend) + vite (frontend).
 * Nunca usa dist/.
 *
 * Frontend oficial : http://localhost:5173  (--port 5173 --strictPort)
 * Backend/API      : http://localhost:3001/api (SERVER_PORT=3001)
 * Banco            : data/app-beta.sqlite
 *
 * Se as portas 5173 ou 3001 estiverem ocupadas, o script ABORTA — nunca
 * usa porta alternativa silenciosamente.
 *
 * Uso: npm run beta:start
 * Para parar: npm run beta:stop  (ou Ctrl+C)
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const BETA_PATH = path.join(ROOT, "data", "app-beta.sqlite");
const PID_FILE  = path.join(ROOT, ".beta-pids");

const BACKEND_PORT  = 3001;
const FRONTEND_PORT = 5173;

// ---------------------------------------------------------------------------
// Verifica se uma porta TCP está ocupada
// ---------------------------------------------------------------------------

function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => { srv.close(); resolve(false); });
    srv.listen(port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------
// Validações iniciais
// ---------------------------------------------------------------------------

if (!fs.existsSync(BETA_PATH)) {
  console.error("[beta:start] ERRO: banco beta não encontrado:", BETA_PATH);
  console.error("[beta:start] Execute primeiro: npm run beta:init");
  process.exit(1);
}

// Verifica portas ANTES de tentar spawnar qualquer processo
const [backendBusy, frontendBusy] = await Promise.all([
  isPortBusy(BACKEND_PORT),
  isPortBusy(FRONTEND_PORT),
]);

if (backendBusy) {
  console.error("=".repeat(60));
  console.error(`[beta:start] ERRO: porta ${BACKEND_PORT} já está em uso.`);
  console.error("[beta:start] Rode: npm run beta:stop");
  console.error("[beta:start] Alternativa: taskkill /F /IM node.exe");
  console.error("=".repeat(60));
  process.exit(1);
}

if (frontendBusy) {
  console.error("=".repeat(60));
  console.error(`[beta:start] ERRO: porta ${FRONTEND_PORT} já está em uso.`);
  console.error("[beta:start] Rode: npm run beta:stop");
  console.error("[beta:start] Alternativa: taskkill /F /IM node.exe");
  console.error("=".repeat(60));
  process.exit(1);
}

// Usa npx.cmd no Windows para garantir que o executável seja encontrado
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const env = {
  ...process.env,
  DATABASE_PATH: BETA_PATH,
  BETA_MODE: "true",
  SERVER_PORT: String(BACKEND_PORT),
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
// Iniciar frontend (vite) — porta fixa 5173 com strictPort
// ---------------------------------------------------------------------------

const client: ChildProcess = spawn(
  npx,
  ["vite", "--host", "0.0.0.0", "--port", String(FRONTEND_PORT), "--strictPort"],
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
  if (code === 1) {
    console.error("=".repeat(60));
    console.error(`[beta:start] ERRO: Vite encerrou com código ${code}.`);
    console.error(`[beta:start] Porta ${FRONTEND_PORT} pode ter sido ocupada após a verificação.`);
    console.error("[beta:start] Rode: npm run beta:stop");
    console.error("=".repeat(60));
  } else {
    console.log("[beta:start] frontend encerrado (código", code, ")");
  }
  killAll();
  process.exit(code ?? 0);
});

process.on("SIGINT",  killAll);
process.on("SIGTERM", killAll);
