import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";

// `node:sqlite` é um builtin recente que alguns bundlers (Vite/Vitest) ainda
// não externalizam automaticamente. Carregamos via require nativo do Node para
// que funcione igualmente em tsx, node compilado e nos testes.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export type Db = DatabaseSyncType;

/** Abre um banco SQLite no caminho informado (cria diretório se preciso). */
export function openDatabase(databasePath: string): Db {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  // WAL melhora concorrência leitura/escrita; FK liga integridade referencial.
  if (databasePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

let singleton: Db | null = null;

/** Instância única do banco operacional da aplicação. */
export function getDb(): Db {
  if (!singleton) {
    singleton = openDatabase(config.databasePath);
  }
  return singleton;
}

export function closeDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}
