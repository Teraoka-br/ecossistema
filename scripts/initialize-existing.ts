/**
 * Inicializa um banco que já foi importado em outra máquina (banco recebido).
 *
 * Uso:
 *   npm run initialize:existing -- --by "Nome do Responsável" --dry-run
 *   npm run initialize:existing -- --by "Nome do Responsável" --apply
 *   npm run initialize:existing -- --by "Nome" --apply --batch-id 3
 *
 * Condições para executar:
 *   - Sistema ainda não inicializado (system_state.initialized = 0)
 *   - Exatamente um lote concluído elegível (ou --batch-id especificado)
 *   - O lote tem pedidos e estoque importados
 *
 * Em --apply: faz WAL checkpoint + backup antes de qualquer escrita.
 * É idempotente: se já inicializado, reporta e sai com código 0.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { getSystemState, initializeSystem } from "../src/system/system-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "app.sqlite");

interface Args {
  by: string;
  dryRun: boolean;
  apply: boolean;
  forcedBatchId: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let by = "";
  let dryRun = false;
  let apply = false;
  let forcedBatchId: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--by" && argv[i + 1]) {
      by = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--batch-id" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        console.error("Erro: --batch-id deve ser um inteiro positivo.");
        process.exit(1);
      }
      forcedBatchId = n;
    }
  }

  return { by, dryRun, apply, forcedBatchId };
}

async function main() {
  const { by, dryRun, apply, forcedBatchId } = parseArgs();

  if (!by.trim()) {
    console.error("Erro: --by \"Nome do Responsável\" é obrigatório.");
    process.exit(1);
  }
  if (!dryRun && !apply) {
    console.error("Erro: especifique --dry-run ou --apply.");
    process.exit(1);
  }
  if (dryRun && apply) {
    console.error("Erro: --dry-run e --apply são mutuamente exclusivos.");
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Banco não encontrado: ${DB_PATH}`);
    process.exit(1);
  }

  const db = openDatabase(DB_PATH);
  runMigrations(db);

  // Verificar se já inicializado (idempotente)
  const state = getSystemState(db);
  if (state.initialized === 1) {
    console.log(`Sistema já inicializado (lote #${state.initial_import_batch_id}). Nada a fazer.`);
    process.exit(0);
  }

  // Encontrar lotes elegíveis
  const eligibleBatches = db
    .prepare(
      `SELECT id, orders_imported, inventory_imported
       FROM import_batches
       WHERE status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
       ORDER BY id`,
    )
    .all() as { id: number; orders_imported: number; inventory_imported: number }[];

  if (eligibleBatches.length === 0) {
    console.error("Nenhum lote concluído encontrado. Importe os dados primeiro.");
    process.exit(1);
  }

  let selectedBatch: (typeof eligibleBatches)[0];

  if (forcedBatchId !== null) {
    const found = eligibleBatches.find((b) => b.id === forcedBatchId);
    if (!found) {
      console.error(
        `Lote #${forcedBatchId} não encontrado ou não está concluído. ` +
          `Disponíveis: ${eligibleBatches.map((b) => `#${b.id}`).join(", ")}.`,
      );
      process.exit(1);
    }
    selectedBatch = found;
  } else if (eligibleBatches.length === 1) {
    selectedBatch = eligibleBatches[0];
  } else {
    console.error(
      `Encontrados ${eligibleBatches.length} lotes elegíveis: ${eligibleBatches.map((b) => `#${b.id}`).join(", ")}. ` +
        `Use --batch-id para selecionar um.`,
    );
    process.exit(1);
  }

  if (selectedBatch.orders_imported === 0) {
    console.error(`Lote #${selectedBatch.id} não tem pedidos importados.`);
    process.exit(1);
  }
  if (selectedBatch.inventory_imported === 0) {
    console.error(`Lote #${selectedBatch.id} não tem estoque importado.`);
    process.exit(1);
  }

  console.log("=== Inicialização de banco existente ===");
  console.log(`  Lote selecionado:     #${selectedBatch.id}`);
  console.log(`  Pedidos importados:   ${selectedBatch.orders_imported}`);
  console.log(`  Estoque importado:    ${selectedBatch.inventory_imported}`);
  console.log(`  Responsável:          ${by.trim()}`);
  console.log(`  Modo:                 ${dryRun ? "DRY-RUN (sem commit)" : "APPLY"}`);

  if (dryRun) {
    // Simula dentro de uma transação que será desfeita
    db.exec("BEGIN");
    try {
      const result = initializeSystem(db, selectedBatch.id, by.trim());
      if (!result.initialized) {
        console.log("\nDRY-RUN: sistema já inicializado (concorrência), nada seria feito.");
      } else {
        console.log(`\nDRY-RUN: ${result.approvedRequestsCreated} solicitações seriam criadas.`);
        console.log(
          "  Contagens por status:",
          JSON.stringify(result.quotationStatusCounts),
        );
      }
    } finally {
      db.exec("ROLLBACK");
    }
    console.log("DRY-RUN concluído. Nenhuma alteração foi feita.");
    return;
  }

  // APPLY: checkpoint WAL + backup antes de qualquer escrita
  console.log("\nCriando checkpoint WAL e backup...");
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(DATA_DIR, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `app-pre-init-${timestamp}.sqlite`);
  fs.copyFileSync(DB_PATH, backupPath);
  console.log(`  Backup criado: ${path.relative(ROOT_DIR, backupPath)}`);

  db.exec("BEGIN");
  try {
    const result = initializeSystem(db, selectedBatch.id, by.trim());
    db.exec("COMMIT");

    if (!result.initialized) {
      console.log("Sistema já estava inicializado (concorrência). Nenhuma alteração.");
    } else {
      console.log(`\nSucesso!`);
      console.log(`  Solicitações de compra criadas: ${result.approvedRequestsCreated}`);
      console.log("  Contagens por status:", JSON.stringify(result.quotationStatusCounts));
    }
  } catch (err) {
    db.exec("ROLLBACK");
    console.error(`\nFalha na inicialização: ${(err as Error).message}`);
    console.error("Nenhuma alteração foi aplicada. O backup está disponível para restauração.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error((err as Error).message ?? err);
  process.exit(1);
});
