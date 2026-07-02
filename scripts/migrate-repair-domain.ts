/**
 * Migração idempotente de source_order_parts → repair_cases + part_requests.
 * Identidade: IMEI normalizado + OS normalizada + repair_date (YYYY-MM-DD).
 *
 * Uso:
 *   npm run migrate:repair-domain -- --dry-run
 *   npm run migrate:repair-domain -- --apply
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { normalizeKey as normalizeText } from "../src/domain/text.js";

// ---------------------------------------------------------------------------
// Part status mapping: status_atual_legado → PartStatus operacional
// ---------------------------------------------------------------------------
export function mapLegacyPartStatus(legacyStatus: string | null): string {
  if (!legacyStatus) return "PEDIR_PECA";
  // normalizeText retorna UPPERCASE sem acentos
  const norm = normalizeText(legacyStatus);
  // "MATCH" cobre "MATCH" e "MATCH PARCIAL" → INDICADA (nunca RESERVADA)
  if (norm.includes("MATCH")) return "INDICADA";
  if (norm.includes("PEDIR PECA") || norm.includes("SEM SALDO")) return "PEDIR_PECA";
  if (norm.includes("AGUARDANDO")) return "AGUARDANDO_RECEBIMENTO";
  if (norm.includes("CONCLUIDO") || norm.includes("SEPARADO")) return "SEPARADA";
  if (norm.includes("CANCELADO")) return "CANCELADA";
  if (norm.includes("VERIFICAR")) return "VERIFICAR";
  return "PEDIR_PECA";
}

// ---------------------------------------------------------------------------
// Case workflow derivado dos status das peças
// ---------------------------------------------------------------------------
export function deriveWorkflowFromParts(partStatuses: string[]): string {
  const active = partStatuses.filter((s) => s !== "CANCELADA");
  if (active.length === 0) return "CANCELADO";
  if (active.some((s) => s === "VERIFICAR")) return "VERIFICAR";
  if (active.every((s) => s === "SEPARADA")) return "APTO_REPARO";
  if (active.some((s) => s === "AGUARDANDO_RECEBIMENTO")) return "AGUARDANDO_RECEBIMENTO";
  if (active.some((s) => s === "PEDIR_PECA")) return "PEDIR_PECA";
  if (active.every((s) => s === "INDICADA")) return "MATCH";
  return "EM_ANALISE";
}

// ---------------------------------------------------------------------------
// Validação de schema (dry-run e apply)
// ---------------------------------------------------------------------------
interface ColInfo { name: string }

function getTableCols(db: ReturnType<typeof openDatabase>, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColInfo[];
  return rows.map((r) => r.name);
}

function validateSchema(db: ReturnType<typeof openDatabase>): void {
  const repairCols = getTableCols(db, "repair_cases");
  const requiredRepair = ["repair_date", "repair_date_source", "legacy_case_key", "legacy_import_batch_id", "legacy_device_key"];
  const missingRepair = requiredRepair.filter((c) => !repairCols.includes(c));
  if (missingRepair.length > 0) {
    console.error(`[migrate:repair-domain] Schema incompatível — colunas ausentes em repair_cases: ${missingRepair.join(", ")}`);
    console.error(`[migrate:repair-domain] Execute a migração 012 antes de continuar: npm run migrate`);
    process.exit(1);
  }

  const sourceCols = getTableCols(db, "source_order_parts");
  const requiredSource = ["status_kit_legado", "margem_legada", "prioridade_kit_legado"];
  const missingSource = requiredSource.filter((c) => !sourceCols.includes(c));
  if (missingSource.length > 0) {
    console.error(`[migrate:repair-domain] Schema incompatível — colunas ausentes em source_order_parts: ${missingSource.join(", ")}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Tipos de linha de origem
// ---------------------------------------------------------------------------
interface SourceRow {
  id: number;
  import_batch_id: number;
  id_pedido: string;
  imei: string | null;
  os: string | null;
  concat_peca: string | null;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  status_atual_legado: string | null;
  status_kit_legado: string | null;
  idade: number | null;
  custo: number | null;
  venda: number | null;
  margem_legada: number | null;
  marca: string | null;
  modelo: string | null;
  data_pedido: string | null;
}

interface DeviceGroup {
  legacyCaseKey: string;
  imei: string | null;
  imeiNorm: string | null;
  os: string | null;
  osNorm: string | null;
  repairDate: string | null;
  brand: string | null;
  model: string | null;
  ageDays: number | null;
  cost: number | null;
  estimatedSale: number | null;
  margin: number | null;
  workflowStatus: string;
  rows: SourceRow[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Agrupamento por IMEI + OS + repair_date
// ---------------------------------------------------------------------------
export function groupRows(rows: SourceRow[], batchId: number): DeviceGroup[] {
  const groups = new Map<string, DeviceGroup>();

  for (const row of rows) {
    const imeiNorm = row.imei ? normalizeText(row.imei) : null;
    const osNorm = row.os ? normalizeText(row.os) : null;
    const repairDate = row.data_pedido ? row.data_pedido.trim().slice(0, 10) : null;

    let caseKey: string;
    if (imeiNorm) {
      caseKey = `${imeiNorm}::${osNorm || "noOS"}::${repairDate || "noDate"}`;
    } else {
      // Sem IMEI: cada id_pedido vira caso próprio para não mesclar registros não relacionados
      caseKey = `noIMEI::${batchId}::${row.id_pedido}`;
    }

    if (!groups.has(caseKey)) {
      groups.set(caseKey, {
        legacyCaseKey: caseKey,
        imei: row.imei ?? null,
        imeiNorm,
        os: row.os ?? null,
        osNorm,
        repairDate,
        brand: null,
        model: null,
        ageDays: null,
        cost: null,
        estimatedSale: null,
        margin: null,
        workflowStatus: "EM_ANALISE",
        rows: [],
        warnings: [],
      });
    }

    groups.get(caseKey)!.rows.push(row);
  }

  // Resolve dados representativos por grupo (determinístico)
  for (const group of groups.values()) {
    const sorted = group.rows.slice().sort((a, b) => a.id - b.id);

    // OS: detecta conflito
    const osValues = [...new Set(sorted.map((r) => normalizeText(r.os ?? "")).filter(Boolean))];
    if (osValues.length > 1) group.warnings.push(`OS divergentes: ${osValues.join(", ")}`);
    group.os = sorted.find((r) => r.os)?.os ?? null;
    group.osNorm = group.os ? normalizeText(group.os) : null;

    group.brand = sorted.find((r) => r.marca)?.marca ?? null;
    group.model = sorted.find((r) => r.modelo)?.modelo ?? null;

    const idades = sorted.map((r) => r.idade).filter((v): v is number => v != null && v >= 0);
    group.ageDays = idades.length > 0 ? Math.max(...idades) : null;

    const repRow = sorted[sorted.length - 1];
    group.cost = repRow.custo ?? null;
    group.estimatedSale = repRow.venda ?? null;
    group.margin = repRow.margem_legada ?? (group.cost != null && group.estimatedSale != null ? group.estimatedSale - group.cost : null);

    // Workflow derivado dos status das peças
    const partStatuses = sorted.map((r) => mapLegacyPartStatus(r.status_atual_legado));
    group.workflowStatus = deriveWorkflowFromParts(partStatuses);

    // Sem IMEI → VERIFICAR obrigatório
    if (!group.imeiNorm) group.workflowStatus = "VERIFICAR";
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Execução principal
// ---------------------------------------------------------------------------
export async function run(opts: { dryRun: boolean; dbPath: string }): Promise<void> {
  const db = openDatabase(opts.dbPath);

  if (opts.dryRun) {
    // Dry-run: valida schema sem aplicar migrations nem alterar WAL
    validateSchema(db);
  } else {
    // Apply: garante migrations aplicadas (incluindo 012)
    runMigrations(db);
    validateSchema(db);
  }

  // Verifica inicialização
  const sysState = db
    .prepare("SELECT initialized, initial_import_batch_id FROM system_state WHERE id = 1")
    .get() as { initialized: number; initial_import_batch_id: number | null } | undefined;
  if (!sysState?.initialized) {
    console.error("[migrate:repair-domain] Sistema não inicializado. Execute a importação inicial primeiro.");
    process.exit(1);
  }

  const batchId = sysState.initial_import_batch_id!;
  console.log(`[migrate:repair-domain] Usando lote inicial: ${batchId}`);

  // Carrega source_order_parts com nomes reais de colunas
  const sourceRows = db
    .prepare(
      `SELECT s.id, s.import_batch_id, s.id_pedido, s.imei, s.os,
              s.concat_peca, s.chave_peca, s.chave_peca_norm,
              s.status_atual_legado, s.status_kit_legado,
              s.idade, s.custo, s.venda, s.margem_legada,
              a.marca, a.modelo, a.data_pedido
       FROM source_order_parts s
       LEFT JOIN source_order_analysis a
         ON a.id_pedido = s.id_pedido AND a.import_batch_id = s.import_batch_id
       WHERE s.import_batch_id = ?
       ORDER BY s.id`,
    )
    .all(batchId) as unknown as SourceRow[];

  console.log(`[migrate:repair-domain] Linhas de origem: ${sourceRows.length}`);

  const groups = groupRows(sourceRows, batchId);

  const emptyImei = groups.filter((g) => !g.imeiNorm);
  const emptyOs = groups.filter((g) => g.imeiNorm && !g.osNorm);
  const noDate = groups.filter((g) => !g.repairDate);
  const conflictOs = groups.filter((g) => g.warnings.some((w) => w.includes("OS divergentes")));

  // Múltiplas datas para o mesmo IMEI+OS (apenas para informação)
  const imeiOsMap = new Map<string, Set<string>>();
  for (const g of groups) {
    if (g.imeiNorm && g.osNorm) {
      const k = `${g.imeiNorm}::${g.osNorm}`;
      if (!imeiOsMap.has(k)) imeiOsMap.set(k, new Set());
      imeiOsMap.get(k)!.add(g.repairDate ?? "noDate");
    }
  }
  const multiDatePairs = [...imeiOsMap.entries()].filter(([, dates]) => dates.size > 1);

  const partStatusCount: Record<string, number> = {};
  for (const g of groups) {
    for (const row of g.rows) {
      const ps = mapLegacyPartStatus(row.status_atual_legado);
      partStatusCount[ps] = (partStatusCount[ps] ?? 0) + 1;
    }
  }

  const existingCases = db
    .prepare("SELECT COUNT(*) as c FROM repair_cases WHERE legacy_import_batch_id = ?")
    .get(batchId) as { c: number };
  const existingParts = db
    .prepare(
      `SELECT COUNT(*) as c FROM part_requests pr
       JOIN repair_cases rc ON rc.id = pr.repair_case_id
       WHERE rc.legacy_import_batch_id = ?`,
    )
    .get(batchId) as { c: number };

  console.log("\n─── Relatório ───────────────────────────────────────────");
  console.log(`  Lote usado:                     ${batchId}`);
  console.log(`  Linhas de origem:               ${sourceRows.length}`);
  console.log(`  Casos a criar:                  ${groups.length}`);
  console.log(`  Solicitações de peça a criar:   ${sourceRows.length}`);
  console.log(`  Casos já existentes:            ${existingCases.c}`);
  console.log(`  Peças já existentes:            ${existingParts.c}`);
  console.log(`  Sem IMEI (VERIFICAR):           ${emptyImei.length}`);
  console.log(`  Sem OS:                         ${emptyOs.length}`);
  console.log(`  Sem data de reparo:             ${noDate.length}`);
  console.log(`  Conflitos de OS:                ${conflictOs.length}`);
  console.log(`  IMEI+OS com múltiplas datas:    ${multiDatePairs.length}`);
  console.log(`  Status de peças:                ${JSON.stringify(partStatusCount)}`);

  if (conflictOs.length > 0 && conflictOs.length <= 20) {
    for (const g of conflictOs) {
      console.log(`    [OS-CONFLICT] ${g.legacyCaseKey}: ${g.warnings.join("; ")}`);
    }
  }

  if (opts.dryRun) {
    console.log("\n[DRY RUN] Nenhuma alteração foi feita.\n");
    db.close();
    return;
  }

  if (existingCases.c > 0) {
    console.log("\n[apply] Casos já existem — verificando idempotência...");
  }

  let createdCases = 0;
  let createdParts = 0;
  let skippedCases = 0;
  let skippedParts = 0;

  db.exec("BEGIN");
  try {
    const findCase = db.prepare(
      "SELECT id FROM repair_cases WHERE legacy_import_batch_id = ? AND legacy_case_key = ? LIMIT 1",
    );
    const insertCase = db.prepare(
      `INSERT INTO repair_cases
         (imei, imei_norm, os, os_norm, brand, model,
          repair_date, repair_date_source,
          age_days, cost, estimated_sale, margin,
          analysis_status, workflow_status,
          legacy_import_batch_id, legacy_device_key, legacy_case_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)`,
    );
    const findPart = db.prepare("SELECT id FROM part_requests WHERE source_order_part_id = ?");
    const insertPart = db.prepare(
      `INSERT INTO part_requests
         (repair_case_id, description, chave_peca, chave_peca_norm, status,
          source_order_part_id, legacy_id_pedido, legacy_status, legacy_kit_status,
          analysis_complete_at_creation)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
    );

    for (const group of groups) {
      const existing = findCase.get(batchId, group.legacyCaseKey) as { id: number } | undefined;
      let repairCaseId: number;

      if (existing) {
        repairCaseId = existing.id;
        skippedCases++;
      } else {
        const res = insertCase.run(
          group.imei, group.imeiNorm,
          group.os, group.osNorm,
          group.brand, group.model,
          group.repairDate, "LEGACY_DATA_PEDIDO",
          group.ageDays,
          group.cost, group.estimatedSale, group.margin,
          group.workflowStatus,
          batchId, group.legacyCaseKey, group.legacyCaseKey,
        );
        repairCaseId = res.lastInsertRowid as number;
        createdCases++;
      }

      for (const row of group.rows) {
        const existingPart = findPart.get(row.id) as { id: number } | undefined;
        if (existingPart) { skippedParts++; continue; }

        const partStatus = mapLegacyPartStatus(row.status_atual_legado);
        insertPart.run(
          repairCaseId,
          row.concat_peca ?? null,
          row.chave_peca ?? null,
          row.chave_peca_norm ?? null,
          partStatus,
          row.id,
          row.id_pedido,
          row.status_atual_legado ?? null,
          row.status_kit_legado ?? null,
        );
        createdParts++;
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  console.log("\n─── Resultado ───────────────────────────────────────────");
  console.log(`  Casos criados:     ${createdCases}  (ignorados: ${skippedCases})`);
  console.log(`  Peças criadas:     ${createdParts}  (ignoradas: ${skippedParts})`);
  console.log("[apply] Migração concluída.\n");
  db.close();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");

  if (!dryRun && !apply) {
    console.error("Uso: npm run migrate:repair-domain -- --dry-run | --apply");
    process.exit(1);
  }

  const dbPath = process.env.DATABASE_PATH ?? "data/app.sqlite";

  run({ dryRun, dbPath })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate:repair-domain] Erro:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
