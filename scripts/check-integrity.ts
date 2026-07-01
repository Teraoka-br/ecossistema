import { openDatabase } from "../src/db/database.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const BACKUP_PATH = path.join(ROOT_DIR, "data/backups/app-before-operational-readiness-20260701-162000.sqlite");
const APP_PATH = path.join(ROOT_DIR, "data/app.sqlite");

console.log("Checking backup file exists:", fs.existsSync(BACKUP_PATH));

const dbBackup = openDatabase(BACKUP_PATH);
const backupIntegrity = dbBackup.prepare("PRAGMA integrity_check;").get() as any;
console.log("Backup integrity_check:", backupIntegrity.integrity_check);

const dbApp = openDatabase(APP_PATH);
console.log("WAL Checkpoint:", dbApp.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get());
const appIntegrity = dbApp.prepare("PRAGMA integrity_check;").get() as any;
console.log("App integrity_check:", appIntegrity.integrity_check);
