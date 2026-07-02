/**
 * Migração idempotente de source_order_parts → repair_cases + part_requests.
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
// Mapeamento de status legado → workflow_status operacional
// ---------------------------------------------------------------------------
function mapLegacyStatusToWorkflow(legacyStatus: string | null): string {
  if (!legacyStatus) return "EM_ANALISE";
  const norm = normalizeText(legacyStatus);
  if (norm.includes("concluido") || norm.includes("concluído")) return "CONCLUIDO";
  if (norm.includes("cancelado")) return "CANCELADO";
  if (norm.includes("separado")) return "CONCLUIDO"; // separado operacionalmente = concluído nesta fase
  if (norm === "match") return "MATCH";
  if (norm.includes("match parcial")) return "MATCH_PARCIAL";
  if (norm.includes("pedir peca") || norm.includes("pedir peça")) return "PEDIR_PECA";
  if (norm.includes("sem saldo")) return "PEDIR_PECA";
  if (norm.includes("verificar")) return "VERIFICAR";
  return "EM_ANALISE";
}

// ---------------------------------------------------------------------------
// Agrupamento de source_order_parts por aparelho
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
  kit_status: string | null;
  idade: number | null;
  custo: number | null;
  venda: number | null;
  margem: number | null;
  marca: string | null;
  modelo: string | null;
  data_pedido: string | null;
}

interface DeviceGroup {
  deviceKey: string;
  imei: string | null;
  imeiNorm: string | null;
  os: string | null;
  osNorm: string | null;
  brand: string | null;
  model: string | null;
  entryDate: string | null;
  ageDays: number | null;
  cost: number | null;
  estimatedSale: number | null;
  margin: number | null;
  workflowStatus: string;
  rows: SourceRow[];
  warnings: string[];
}

function groupRows(rows: SourceRow[]): DeviceGroup[] {
  const groups = new Map<string, DeviceGroup>();

  for (const row of rows) {
    const imeiNorm = row.imei ? normalizeText(row.imei) : null;
    const osNorm = row.os ? normalizeText(row.os) : null;

    let deviceKey: string;
    if (imeiNorm) {
      deviceKey = `imei:${imeiNorm}`;
    } else {
      // IMEI vazio: chave técnica estável baseada no id do primeiro pedido (seed)
      deviceKey = `noImei:batch${row.import_batch_id}:${row.id_pedido}`;
    }

    if (!groups.has(deviceKey)) {
      groups.set(deviceKey, {
        deviceKey,
        imei: row.imei ?? null,
        imeiNorm,
        os: row.os ?? null,
        osNorm,
        brand: null,
        model: null,
        entryDate: row.data_pedido ?? null,
        ageDays: null,
        cost: null,
        estimatedSale: null,
        margin: null,
        workflowStatus: "EM_ANALISE",
        rows: [],
        warnings: [],
      });
    }

    const group = groups.get(deviceKey)!;
    group.rows.push(row);
  }

  // Resolve dados representativos por grupo (determinístico)
  for (const group of groups.values()) {
    const sortedRows = group.rows.slice().sort((a, b) => a.id - b.id);

    // OS: verifica conflito
    const osValues = [...new Set(sortedRows.map((r) => normalizeText(r.os ?? "")).filter(Boolean))];
    if (osValues.length > 1) {
      group.warnings.push(`OS divergentes: ${osValues.join(", ")}`);
    }
    group.os = sortedRows.find((r) => r.os)?.os ?? null;
    group.osNorm = group.os ? normalizeText(group.os) : null;

    // Dados do aparelho: primeiro valor não vazio
    group.brand = sortedRows.find((r) => r.marca)?.marca ?? null;
    group.model = sortedRows.find((r) => r.modelo)?.modelo ?? null;
    group.entryDate = sortedRows.find((r) => r.data_pedido)?.data_pedido ?? null;

    // Maior idade válida
    const idades = sortedRows.map((r) => r.idade).filter((v): v is number => v != null && v >= 0);
    group.ageDays = idades.length > 0 ? Math.max(...idades) : null;

    // Custo e venda: da linha representativa (maior ID — mais recente)
    const repRow = sortedRows[sortedRows.length - 1];
    group.cost = repRow.custo ?? null;
    group.estimatedSale = repRow.venda ?? null;
    group.margin = repRow.margem ?? (group.cost != null && group.estimatedSale != null ? group.estimatedSale - group.cost : null);

    // Workflow: o status mais "avançado" do kit
    const statuses = sortedRows.map((r) => mapLegacyStatusToWorkflow(r.status_atual_legado));
    // Ordem de precedência
    const order = ["CONCLUIDO", "CANCELADO", "MATCH", "MATCH_PARCIAL", "PEDIR_PECA", "VERIFICAR", "EM_ANALISE"];
    group.workflowStatus = statuses.reduce((best, s) => {
      return order.indexOf(s) < order.indexOf(best) ? s : best;
    }, "EM_ANALISE");

    if (!group.imeiNorm) {
      group.workflowStatus = "VERIFICAR";
    }
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Execução principal
// ---------------------------------------------------------------------------
async function run(opts: { dryRun: boolean; dbPath: string }): Promise<void> {
  const db = openDatabase(opts.dbPath);
  runMigrations(db);

  // Verifica inicialização
  const sysState = db.prepare("SELECT initialized, initial_import_batch_id FROM system_state WHERE id = 1").get() as { initialized: number; initial_import_batch_id: number | null } | undefined;
  if (!sysState?.initialized) {
    console.error("[migrate:repair-domain] Sistema não inicializado. Execute a importação inicial primeiro.");
    process.exit(1);
  }

  const batchId = sysState.initial_import_batch_id!;
  console.log(`[migrate:repair-domain] Usando lote inicial: ${batchId}`);

  // Carrega todas as source_order_parts do lote inicial
  const sourceRows = db
    .prepare(
      `SELECT s.id, s.import_batch_id, s.id_pedido, s.imei, s.os,
              s.concat_peca, s.chave_peca, s.chave_peca_norm,
              s.status_atual_legado, s.status_kit as kit_status,
              s.idade, s.custo, s.venda, s.margem,
              a.marca, a.modelo, a.data_pedido
       FROM source_order_parts s
       LEFT JOIN source_order_analysis a ON a.id_pedido = s.id_pedido AND a.import_batch_id = s.import_batch_id
       WHERE s.import_batch_id = ?
       ORDER BY s.id`,
    )
    .all(batchId) as unknown as SourceRow[];

  console.log(`[migrate:repair-domain] Linhas de origem: ${sourceRows.length}`);

  // Agrupa por aparelho
  const groups = groupRows(sourceRows);

  // Conta IMEIs vazios
  const emptyImei = groups.filter((g) => !g.imeiNorm);
  const conflictOs = groups.filter((g) => g.warnings.some((w) => w.includes("OS divergentes")));

  const statusCount: Record<string, number> = {};
  for (const g of groups) {
    statusCount[g.workflowStatus] = (statusCount[g.workflowStatus] ?? 0) + 1;
  }

  // Verifica duplicidades existentes (idempotência)
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

  console.log("\n─── Relatório de dry-run ────────────────────────────────");
  console.log(`  Lote usado:               ${batchId}`);
  console.log(`  Linhas de origem:         ${sourceRows.length}`);
  console.log(`  Casos a criar:            ${groups.length}`);
  console.log(`  Solicitações a criar:     ${sourceRows.length}`);
  console.log(`  Casos já existentes:      ${existingCases.c}`);
  console.log(`  Peças já existentes:      ${existingParts.c}`);
  console.log(`  IMEIs vazios (VERIFICAR): ${emptyImei.length}`);
  console.log(`  Conflitos de OS:          ${conflictOs.length}`);
  console.log(`  Status encontrados:       ${JSON.stringify(statusCount)}`);

  if (conflictOs.length > 0 && conflictOs.length <= 20) {
    for (const g of conflictOs) {
      console.log(`    [OS-CONFLICT] ${g.deviceKey}: ${g.warnings.join("; ")}`);
    }
  }

  if (opts.dryRun) {
    console.log("\n[DRY RUN] Nenhuma alteração foi feita.\n");
    return;
  }

  if (existingCases.c > 0) {
    console.log("\n[apply] Casos já existem — verificando idempotência...");
  }

  // Aplica
  let createdCases = 0;
  let createdParts = 0;
  let skippedCases = 0;
  let skippedParts = 0;

  db.exec("BEGIN");
  try {
    for (const group of groups) {
      // Idempotência: busca por legacy_device_key
      const existing = db
        .prepare("SELECT id FROM repair_cases WHERE legacy_device_key = ? AND legacy_import_batch_id = ?")
        .get(group.deviceKey, batchId) as { id: number } | undefined;

      let repairCaseId: number;

      if (existing) {
        repairCaseId = existing.id;
        skippedCases++;
      } else {
        const res = db
          .prepare(
            `INSERT INTO repair_cases
               (imei, imei_norm, os, os_norm, brand, model, entry_date, age_days,
                cost, estimated_sale, margin, analysis_status, workflow_status,
                legacy_import_batch_id, legacy_device_key)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,'COMPLETED',?,?,?)`,
          )
          .run(
            group.imei, group.imeiNorm,
            group.os, group.osNorm,
            group.brand, group.model,
            group.entryDate, group.ageDays,
            group.cost, group.estimatedSale, group.margin,
            group.workflowStatus,
            batchId, group.deviceKey,
          );
        repairCaseId = res.lastInsertRowid as number;
        createdCases++;
      }

      // Peças deste grupo
      for (const row of group.rows) {
        // Idempotência: source_order_part_id é UNIQUE
        const existingPart = db
          .prepare("SELECT id FROM part_requests WHERE source_order_part_id = ?")
          .get(row.id) as { id: number } | undefined;

        if (existingPart) {
          skippedParts++;
          continue;
        }

        const partStatus = mapLegacyStatusToWorkflow(row.status_atual_legado);
        const mappedPartStatus = legacyWorkflowToPartStatus(partStatus);

        db.prepare(
          `INSERT INTO part_requests
             (repair_case_id, description, chave_peca, chave_peca_norm, status,
              source_order_part_id, legacy_id_pedido, legacy_status, legacy_kit_status,
              analysis_complete_at_creation)
           VALUES (?,?,?,?,?,?,?,?,?,1)`,
        ).run(
          repairCaseId,
          row.concat_peca ?? null,
          row.chave_peca ?? null,
          row.chave_peca_norm ?? null,
          mappedPartStatus,
          row.id,
          row.id_pedido,
          row.status_atual_legado ?? null,
          row.kit_status ?? null,
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
}

function legacyWorkflowToPartStatus(workflowStatus: string): string {
  const map: Record<string, string> = {
    CONCLUIDO: "SEPARADA",
    CANCELADO: "CANCELADA",
    MATCH: "RESERVADA",
    MATCH_PARCIAL: "INDICADA",
    PEDIR_PECA: "PEDIR_PECA",
    AGUARDANDO_RECEBIMENTO: "AGUARDANDO_RECEBIMENTO",
    VERIFICAR: "VERIFICAR",
    EM_ANALISE: "PEDIR_PECA",
  };
  return map[workflowStatus] ?? "PEDIR_PECA";
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
      console.error("[migrate:repair-domain] Erro:", err);
      process.exit(1);
    });
}

export { run as runRepairDomainMigration, groupRows, mapLegacyStatusToWorkflow };
