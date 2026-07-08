/**
 * beta-stop — Encerra os processos iniciados por beta:start.
 * Lê os PIDs gravados em .beta-pids e os mata.
 *
 * Uso: npm run beta:stop
 * Alternativa Windows: taskkill /F /IM node.exe
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT     = path.resolve(__dirname, "..");
const PID_FILE = path.join(ROOT, ".beta-pids");

if (!fs.existsSync(PID_FILE)) {
  console.log("[beta:stop] Nenhum processo beta em execução (.beta-pids não encontrado).");
  process.exit(0);
}

const pids = fs.readFileSync(PID_FILE, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => !isNaN(n));

if (pids.length === 0) {
  console.log("[beta:stop] .beta-pids vazio — nada a encerrar.");
  fs.unlinkSync(PID_FILE);
  process.exit(0);
}

let killed = 0;
for (const pid of pids) {
  try {
    process.kill(pid, "SIGTERM");
    console.log("[beta:stop] Encerrado PID", pid);
    killed++;
  } catch {
    console.log("[beta:stop] PID", pid, "já encerrado ou inexistente.");
  }
}

try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }

console.log(`[beta:stop] ${killed} processo(s) encerrado(s).`);
if (killed === 0) {
  console.log("[beta:stop] Alternativa Windows: taskkill /F /IM node.exe");
}
