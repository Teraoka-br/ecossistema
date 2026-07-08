import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, PROJECT_ROOT } from "../server/config.js";
import { type Db, getDb, openDatabase } from "./database.js";

/**
 * Diretório das migrations. As migrations são lidas de `src/db/migrations`
 * relativo à raiz do projeto (funciona em dev e em produção, já que o projeto
 * é distribuído com a pasta src). Como fallback, resolve relativo a este módulo.
 */
function migrationsDir(): string {
  const fromRoot = path.join(PROJECT_ROOT, "src", "db", "migrations");
  if (fs.existsSync(fromRoot)) return fromRoot;
  return fileURLToPath(new URL("./migrations", import.meta.url));
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function appliedMigrations(db: Db): Set<string> {
  const rows = db.prepare("SELECT name FROM schema_migrations").all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

const BACKUP_RETENTION = 5;

/** Remove backups mais antigos, mantendo apenas os BACKUP_RETENTION mais recentes. */
function pruneOldBackups(): void {
  if (!fs.existsSync(config.backupDir)) return;
  const files = fs
    .readdirSync(config.backupDir)
    .filter((f) => f.endsWith(".sqlite") || f.includes(".sqlite.bkp"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(config.backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files.slice(BACKUP_RETENTION)) {
    try { fs.unlinkSync(path.join(config.backupDir, f)); } catch { /* ignore */ }
  }
}

/** Faz backup do arquivo de banco antes de aplicar migrations. */
function backupDatabase(db: Db): void {
  if (config.databasePath === ":memory:") return;
  if (!fs.existsSync(config.databasePath)) return;
  // O banco roda em modo WAL: força o checkpoint para garantir que todos os
  // dados confirmados estejam no arquivo principal antes de copiá-lo
  // (senão a cópia pode ficar sem as escritas recentes, ainda só no -wal).
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(config.backupDir, `app-${stamp}.sqlite`);
  fs.copyFileSync(config.databasePath, dest);
  console.log(`[migrate] backup criado em ${dest}`);
  pruneOldBackups();
}

export interface MigrationOutcome {
  applied: string[];
  alreadyUpToDate: boolean;
}

function tableExists(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Guarda de pré-migração para `002_fix_order_identity.sql`: essa migration
 * recria `source_order_parts` com `UNIQUE(import_batch_id, id_pedido)` usando
 * `INSERT OR IGNORE`, o que descartaria silenciosamente qualquer linha antiga
 * cujo `id_pedido` já se repita dentro do mesmo lote (resquício do modelo de
 * identidade incorreto desta fase anterior). Antes de aplicar, verificamos
 * isso explicitamente e abortamos com uma amostra, em vez de deixar o
 * `INSERT OR IGNORE` apagar dados em silêncio.
 */
function guardOrderIdentityMigration(db: Db): void {
  if (!tableExists(db, "source_order_parts")) return; // nada a proteger (tabela ainda não existe)

  const dupes = db
    .prepare(
      `SELECT import_batch_id, id_pedido, COUNT(*) AS c
       FROM source_order_parts
       GROUP BY import_batch_id, id_pedido
       HAVING COUNT(*) > 1
       ORDER BY c DESC`,
    )
    .all() as { import_batch_id: number; id_pedido: string; c: number }[];

  if (dupes.length === 0) return;

  const totalRowsAtRisk = dupes.reduce((sum, d) => sum + d.c, 0);
  const sample = dupes
    .slice(0, 10)
    .map((d) => `lote ${d.import_batch_id} / id_pedido "${d.id_pedido}" (${d.c}x)`)
    .join("; ");
  throw new Error(
    `Migration 002_fix_order_identity.sql ABORTADA: encontradas ${dupes.length} ` +
      `combinação(ões) (import_batch_id, id_pedido) duplicada(s) em source_order_parts ` +
      `(${totalRowsAtRisk} linha(s) ao todo). Aplicar a migration agora descartaria essas ` +
      `linhas silenciosamente via INSERT OR IGNORE. O banco NÃO foi alterado; o backup ` +
      `feito antes desta tentativa (se solicitado) foi preservado. Resolva as duplicidades ` +
      `manualmente antes de migrar. Amostra: ${sample}`,
  );
}

/**
 * Guardas a rodar ANTES de aplicar cada migration (fora da transação da
 * própria migration) — abortam o lote inteiro de `runMigrations` se a
 * migration nomeada não for segura de aplicar ao estado atual do banco.
 * Nunca edite uma migration já existente para corrigir um problema: adicione
 * a guarda aqui, ou crie uma nova migration.
 */
/**
 * Sinal especial que uma guarda pode lançar para indicar que a migration
 * já está efetivamente aplicada (e deve ser registrada como tal sem rodar
 * o SQL). Tratado pelo runner, não propagado para o chamador.
 */
export class MigrationAlreadyApplied extends Error {
  constructor(public readonly migrationName: string) {
    super(`[migrate] migration ${migrationName} já aplicada — registrada sem rodar SQL.`);
    this.name = "MigrationAlreadyApplied";
  }
}

/**
 * Guarda para 017: SQLite não tem ALTER TABLE ADD COLUMN IF NOT EXISTS.
 * Se a coluna `allocated_reference_norm` já existir (banco criado por outro
 * caminho), sinaliza ao runner para registrar a migration sem executar o SQL.
 */
function guard017AllocRefNorm(_db: Db, file: string): void {
  if (!tableExists(_db, "repair_match_results")) return;
  const cols = _db.prepare("PRAGMA table_info(repair_match_results)").all() as { name: string }[];
  if (cols.some(c => c.name === "allocated_reference_norm")) {
    throw new MigrationAlreadyApplied(file);
  }
}

const PRE_MIGRATION_GUARDS: Record<string, (db: Db, file: string) => void> = {
  "002_fix_order_identity.sql": (db) => guardOrderIdentityMigration(db),
  "017_fix_allocated_ref_norm_column.sql": guard017AllocRefNorm,
};

/** Aplica todas as migrations pendentes, cada uma em sua própria transação. */
export function runMigrations(db: Db, opts: { backup?: boolean } = {}): MigrationOutcome {
  ensureMigrationsTable(db);
  const dir = migrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const done = appliedMigrations(db);
  const pending = files.filter((f) => !done.has(f));

  if (pending.length === 0) {
    return { applied: [], alreadyUpToDate: true };
  }

  if (opts.backup) backupDatabase(db);

  const applied: string[] = [];
  for (const file of pending) {
    // Guarda de segurança: roda FORA da transação da migration.
    // — Lança MigrationAlreadyApplied → registra e pula (sem rodar SQL).
    // — Lança outro erro → aborta o lote inteiro sem tocar o banco.
    try {
      PRE_MIGRATION_GUARDS[file]?.(db, file);
    } catch (guardErr) {
      if (guardErr instanceof MigrationAlreadyApplied) {
        db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(file);
        applied.push(file);
        console.log(`[migrate] pulada (já aplicada): ${file}`);
        continue;
      }
      throw guardErr; // erro real de guarda — aborta
    }

    const sql = fs.readFileSync(path.join(dir, file), "utf8");

    // PRIAGMAs que devem ser executados FORA de BEGIN:
    // — foreign_keys=OFF: silenciosamente ignorado dentro de uma transação;
    // — legacy_alter_table=ON: necessário para que RENAME TO não atualize
    //   referências de FK nas tabelas filhas (comportamento pré-SQLite 3.26.0).
    const needsFkOff = /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql);
    const needsLegacyAlter = /PRAGMA\s+legacy_alter_table\s*=\s*ON/i.test(sql);

    if (needsFkOff) db.exec("PRAGMA foreign_keys = OFF;");
    if (needsLegacyAlter) db.exec("PRAGMA legacy_alter_table = ON;");

    db.exec("BEGIN");
    try {
      // Remover as linhas de PRAGMA do SQL da migration — já foram tratadas fora.
      const sqlWithoutPragmas = sql
        .replace(/PRAGMA\s+foreign_keys\s*=\s*OFF\s*;?/gi, "-- [runner: PRAGMA fora da tx]")
        .replace(/PRAGMA\s+foreign_keys\s*=\s*ON\s*;?/gi, "-- [runner: PRAGMA fora da tx]")
        .replace(/PRAGMA\s+legacy_alter_table\s*=\s*ON\s*;?/gi, "-- [runner: PRAGMA fora da tx]")
        .replace(/PRAGMA\s+legacy_alter_table\s*=\s*OFF\s*;?/gi, "-- [runner: PRAGMA fora da tx]");
      db.exec(sqlWithoutPragmas);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
      db.exec("COMMIT");
      applied.push(file);
      console.log(`[migrate] aplicada: ${file}`);
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw new Error(
        `Falha ao aplicar migration ${file}: ${(err as Error).message}`,
      );
    } finally {
      if (needsFkOff) db.exec("PRAGMA foreign_keys = ON;");
      if (needsLegacyAlter) db.exec("PRAGMA legacy_alter_table = OFF;");
    }
  }
  return { applied, alreadyUpToDate: false };
}

/** Execução direta via `npm run migrate`. */
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const db = getDb();
  const outcome = runMigrations(db, { backup: true });
  if (outcome.alreadyUpToDate) {
    console.log("[migrate] banco já está atualizado.");
  } else {
    console.log(`[migrate] ${outcome.applied.length} migration(s) aplicada(s).`);
  }
}

export { openDatabase };
