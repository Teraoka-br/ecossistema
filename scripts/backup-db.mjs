/**
 * Backup manual do banco SQLite operacional.
 * Copia app-beta.sqlite para data/backups/app-<timestamp>.sqlite
 * e mantém apenas os 2 backups mais recentes (rotação automática).
 */
import { copyFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const KEEP = 2;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src  = join(root, "data", "app-beta.sqlite");
const dir  = join(root, "data", "backups");

if (!existsSync(src)) {
  console.error("[backup] banco não encontrado:", src);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });

const ts   = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "Z");
const dest = join(dir, `app-${ts}.sqlite`);

copyFileSync(src, dest);
console.log("[backup] criado:", dest);

// Rotação: apaga os mais antigos além do limite
const files = readdirSync(dir)
  .filter(f => f.endsWith(".sqlite"))
  .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

for (const { f } of files.slice(KEEP)) {
  unlinkSync(join(dir, f));
  console.log("[backup] rotacionado (removido):", f);
}
