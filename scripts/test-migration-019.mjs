// Testa migration 019 em cópia do banco sem tocar no banco operacional
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const SRC = 'data/app.sqlite';
const COPY = 'data/app_test_mig019.sqlite';

if (fs.existsSync(COPY)) fs.unlinkSync(COPY);
fs.copyFileSync(SRC, COPY);
console.log('Banco copiado:', COPY);

const db = new DatabaseSync(COPY);
const sql = fs.readFileSync('src/db/migrations/019_central_dados_schema_fix.sql', 'utf8');

let failed = false;
try {
  db.exec(sql);
  console.log('Migration 019 aplicada sem erros.\n');
} catch (e) {
  console.error('ERRO ao aplicar migration:', e.message);
  failed = true;
}

if (!failed) {
  // Verifica tabelas criadas
  const tables = ['import_staged_files','analise_mi_imports','analise_mi_rows',
    'pedidos_imports','pedidos_reconciliation_rows','pedidos_bipagem_rows',
    'sh_catalog_imports','sh_catalog_rows','central_import_issues'];

  console.log('=== Tabelas criadas:');
  for (const t of tables) {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    console.log(' ', r ? '✓' : '✗', t);
  }

  // Verifica colunas adicionadas
  console.log('\n=== Colunas adicionadas:');
  for (const [t, col] of [
    ['his_import_rows','age_days'],
    ['his_import_rows','source_line'],
    ['rel_seriais_rows','serial'],
    ['rel_seriais_rows','deposito_atual'],
    ['rel_seriais_rows','codigo_comercial'],
    ['triagem_saida_rows','concat_key'],
    ['triagem_saida_rows','repair_effective'],
    ['triagem_saida_rows','motivo'],
  ]) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    console.log(' ', cols.includes(col) ? '✓' : '✗', `${t}.${col}`);
  }

  // Verifica índices
  console.log('\n=== Índices:');
  for (const idx of ['idx_staged_source','idx_staged_hash','idx_ami_rows_import','idx_bipagem_chave','idx_sh_cat_rows_codigo','idx_cii_import']) {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(idx);
    console.log(' ', r ? '✓' : '✗', idx);
  }
}

db.close();
fs.unlinkSync(COPY);
console.log('\nCópia removida. Migration 019:', failed ? 'FALHOU' : 'OK');
