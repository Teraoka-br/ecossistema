/**
 * Backup manual do banco SQLite operacional.
 * Copia data/app.sqlite para data/backups/app-<timestamp>.sqlite
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "data", "app.sqlite");
const dir = join(root, "data", "backups");

if (!existsSync(src)) {
  console.error("[backup] banco nao encontrado:", src);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });

const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "Z");
const dest = join(dir, `app-${ts}.sqlite`);

copyFileSync(src, dest);
console.log("[backup] criado:", dest);
