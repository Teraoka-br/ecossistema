import { openDatabase } from "../src/db/database.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const APP_PATH = path.join(ROOT_DIR, "data/app.sqlite");
const BACKUP_PATH = path.join(ROOT_DIR, "data/backups/app-after-initialization-20260701-163251.sqlite");

const dbApp = openDatabase(APP_PATH);
console.log("WAL Checkpoint:", dbApp.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get());
dbApp.close();

fs.copyFileSync(APP_PATH, BACKUP_PATH);
console.log("Copied DB to", BACKUP_PATH);

const dbBackup = openDatabase(BACKUP_PATH);
const backupIntegrity = dbBackup.prepare("PRAGMA integrity_check;").get() as any;
console.log("Backup integrity_check:", backupIntegrity.integrity_check);
