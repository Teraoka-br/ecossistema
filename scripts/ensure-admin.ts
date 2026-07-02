/**
 * Garante que existe um usuário ADMIN no banco operacional.
 * Cria ou atualiza (nunca duplica).
 *
 * Uso:
 *   npm run user:ensure-admin -- --username "Fabrício" --display-name "Fabrício Teraoka"
 *   ADMIN_PIN=<pin> npm run user:ensure-admin -- --username "Fabrício" --display-name "..."
 *
 * Se --pin não for fornecido e ADMIN_PIN não estiver definido, o PIN é solicitado
 * interativamente via stdin (sem eco).
 *
 * Nunca imprime o PIN. Nunca toca outros usuários.
 */

import * as readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  findUserByUsername,
  resetUserPin,
  createUser,
  updateUser,
  getUserCount,
} from "../src/auth/auth-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/app.sqlite");

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(): { username: string; displayName: string; pin: string | null } {
  const args = process.argv.slice(2);
  function get(flag: string): string | null {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  }
  const username = get("--username");
  const displayName = get("--display-name");
  const pin = process.env.ADMIN_PIN ?? get("--pin") ?? null;
  if (!username) { console.error("Erro: --username é obrigatório."); process.exit(1); }
  if (!displayName) { console.error("Erro: --display-name é obrigatório."); process.exit(1); }
  return { username, displayName, pin };
}

// ---------------------------------------------------------------------------
// PIN input seguro via stdin (sem eco)
// ---------------------------------------------------------------------------
async function readPinFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write("PIN (4–8 dígitos numéricos, sem eco): ");

    // Tenta desligar o eco (funciona em TTY reais; em pipes não é necessário)
    const stdin = process.stdin as NodeJS.ReadStream & { _handle?: { setBlocking?: (b: boolean) => void } };
    if ((process.stdin as NodeJS.ReadStream).isTTY) {
      (stdin as unknown as { setRawMode?: (b: boolean) => void }).setRawMode?.(true);
    }

    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", (char) => {
      const c = String(char);
      if (c === "\n" || c === "\r") {
        process.stdout.write("\n");
        rl.close();
        resolve(input);
      } else if (c === "") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (c === "" || c === "\b") {
        if (input.length > 0) input = input.slice(0, -1);
      } else {
        input += c;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Confirmação explícita
// ---------------------------------------------------------------------------
async function confirm(msg: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${msg} [s/N] `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "s");
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { username, displayName, pin: pinArg } = parseArgs();

  const pin = pinArg ?? (await readPinFromStdin());

  if (!/^\d{4,8}$/.test(pin)) {
    console.error("Erro: PIN deve ter entre 4 e 8 dígitos numéricos.");
    process.exit(1);
  }

  console.log(`\nBanco alvo: ${DB_PATH}`);
  console.log(`Username : ${username}`);
  console.log(`Nome     : ${displayName}`);
  console.log(`Papel    : ADMIN`);
  console.log("");

  const ok = await confirm(`Prestes a modificar "${DB_PATH}". Continuar?`);
  if (!ok) { console.log("Abortado."); process.exit(0); }

  const db = openDatabase(DB_PATH);
  runMigrations(db, { backup: false });

  const usernameLower = username.trim().toLowerCase();
  const existing = findUserByUsername(db, usernameLower);

  if (existing) {
    console.log(`\nUsuário encontrado (id=${existing.id}, username="${existing.username}"). Atualizando…`);
    // Atualiza display_name, role e active
    updateUser(db, existing.id, { displayName: displayName.trim(), role: "ADMIN", active: true });
    // Redefine PIN usando o serviço real (hash scrypt)
    await resetUserPin(db, existing.id, pin);
    console.log(`Usuário atualizado: display_name="${displayName}", role=ADMIN, active=true, PIN redefinido.`);
  } else {
    const count = getUserCount(db);
    if (count > 0) {
      // Não há usuário com esse username, mas há outros — cria normalmente
      const created = await createUser(db, { username, displayName, pin, role: "ADMIN" });
      console.log(`\nNovo usuário criado: id=${created.id}, username="${created.username}".`);
    } else {
      // Banco vazio — usa setup para criar o primeiro usuário
      const { setupFirstUser } = await import("../src/auth/auth-service.js");
      const created = await setupFirstUser(db, { username, displayName, pin });
      console.log(`\nPrimeiro usuário criado (setup): id=${created.id}, username="${created.username}".`);
    }
    console.log(`role=ADMIN, active=true, PIN definido.`);
  }

  db.close();
  console.log("\nConcluído. O PIN não foi exibido em nenhum momento.");
  console.log(`Para fazer login, use o campo "Nome de usuário" com o valor: ${username.trim().toLowerCase()}`);
}

main().catch((err) => {
  console.error("Erro fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
