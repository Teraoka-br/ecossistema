import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/app.sqlite');
for (const t of ['import_staged_files','analise_mi_imports','pedidos_imports','sh_catalog_rows']) {
  const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  console.log(t + ':', r ? 'EXISTS' : 'MISSING');
}
