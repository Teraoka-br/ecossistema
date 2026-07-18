/**
 * Clona o banco de produção (app-beta.sqlite) para o banco de dev (app.sqlite).
 * Use antes de testar migrações ou mudanças destrutivas em desenvolvimento.
 * Após os testes, delete data/app.sqlite — ele será recriado vazio pelo servidor.
 *
 *   node scripts/clone-dev-db.mjs
 */
import { copyFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src  = join(root, "data", "app-beta.sqlite");
const dest = join(root, "data", "app.sqlite");

if (!existsSync(src)) {
  console.error("[clone-dev-db] banco de produção não encontrado:", src);
  process.exit(1);
}

if (existsSync(dest)) {
  const size = (statSync(dest).size / 1024 / 1024).toFixed(1);
  console.warn(`[clone-dev-db] app.sqlite já existe (${size} MB) — sobrescrevendo.`);
}

copyFileSync(src, dest);
const size = (statSync(dest).size / 1024 / 1024).toFixed(1);
console.log(`[clone-dev-db] clonado: ${dest} (${size} MB)`);
console.log("[clone-dev-db] Após os testes, delete data/app.sqlite para liberar espaço.");
