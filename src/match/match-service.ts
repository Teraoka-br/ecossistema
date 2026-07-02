/**
 * Serviço de match — orquestra transação, fontes e persistência.
 *
 * MATCH É RECOMENDAÇÃO CALCULADA. Não cria stock_movements nem operational_events.
 */

import type { Db } from "../db/database.js";
import { getSystemState } from "../system/system-service.js";
import { getCurrentOperationalStock } from "../operational/stock-service.js";
import { ALGORITHM_VERSION, runMatchEngine } from "./match-engine.js";
import {
  computeHash,
  loadActiveRule,
  collectFingerprintComponents,
  MatchConfigError,
  MatchError,
} from "./match-fingerprint.js";
import {
  createMatchRun,
  completeMatchRun,
  failMatchRun,
  findCompletedRunByHash,
  getMatchRun,
  getLatestCompletedRun,
  listMatchRuns,
  insertDeviceResult,
  insertLineResult,
  insertStockResult,
  listDeviceResults,
  listLineResults,
  getLineResultsForDevice,
  getStockSummaryFromResults,
  getComparisonData,
  getFullComparisonData,
  exportResultsCsv,
  loadDemandLines,
  loadOperationalEventsForOrders,
  type ListMatchRunsParams,
  type ListResultsParams,
  type MatchRunRow,
  type ComparisonRow,
  type ComparisonSummary,
} from "./match-repository.js";

export { MatchError, MatchConfigError };
export type { MatchRunRow, ComparisonRow, ComparisonSummary };

export interface RunMatchInput {
  createdBy: string;
  notes?: string | null;
  force?: boolean;
}

export interface RunMatchResult {
  run: MatchRunRow;
  reused: boolean;
  stale: boolean;
  currentHash: string;
}

// Limpa execução RUNNING presa (servidor reiniciado no meio de uma execução).
function cleanStuckRunningRun(db: Db): void {
  const stuck = db
    .prepare(
      `SELECT id, started_at FROM match_runs WHERE status = 'RUNNING'
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; started_at: string } | undefined;

  if (!stuck) return;

  // Se a execução RUNNING tiver mais de 5 minutos, considera presa.
  const startedMs = new Date(stuck.started_at).getTime();
  if (Date.now() - startedMs > 5 * 60 * 1000) {
    failMatchRun(db, stuck.id, "Execução interrompida pelo servidor (timeout de 5 minutos).");
  }
}

/** Executa o motor de match dentro de uma transação. */
export function runMatch(db: Db, input: RunMatchInput): RunMatchResult {
  const createdBy = (input.createdBy ?? "").trim();
  if (!createdBy) throw new MatchError(400, "createdBy é obrigatório.");

  // Verificar inicialização
  const state = getSystemState(db);
  if (!state.initialized || !state.initial_import_batch_id) {
    throw new MatchError(422, "O sistema ainda não foi inicializado. Importe os dados primeiro.");
  }
  const importBatchId = state.initial_import_batch_id;

  // Limpar eventual execução RUNNING presa
  cleanStuckRunningRun(db);

  // Carregar regra e computar fingerprint FORA da transação principal
  // (para poder verificar reutilização antes de abrir transação de escrita)
  const rule = loadActiveRule(db);
  const components = collectFingerprintComponents(db, rule);
  const currentHash = computeHash(components);

  // Verificar reutilização
  if (!input.force) {
    const existing = findCompletedRunByHash(db, currentHash);
    if (existing) {
      return { run: existing, reused: true, stale: false, currentHash };
    }
  }

  // Carregar dados para o motor
  const demandLines = loadDemandLines(db, importBatchId);
  if (demandLines.length === 0) {
    throw new MatchError(422, "Nenhuma solicitação encontrada no lote inicial.");
  }
  const operationalEvents = loadOperationalEventsForOrders(db);
  const stock = getCurrentOperationalStock(db);

  const ruleConfig = {
    ageDaysPerPoint: rule.age_days_per_point,
    ageMaxPoints: rule.age_max_points,
    marginPerPoint: rule.margin_per_point,
    marginAllowsNegative: rule.margin_allows_negative === 1,
  };

  let runId: number | null = null;

  db.exec("BEGIN");
  try {
    // Criar execução como RUNNING dentro da transação
    runId = createMatchRun(db, {
      importBatchId,
      decisionRuleId: rule.id,
      algorithmVersion: ALGORITHM_VERSION,
      inputHash: currentHash,
      createdBy,
      notes: input.notes ?? null,
      components,
    });

    // Executar motor em memória (puro, sem SQL)
    const output = runMatchEngine({
      demandLines,
      operationalEvents,
      stockGroups: stock.groups,
      rule: ruleConfig,
    });

    // Inserir resultados de aparelhos e linhas
    const deviceIdMap = new Map<string, number>(); // deviceKey → id inserido
    for (const device of output.devices) {
      const deviceResultId = insertDeviceResult(db, runId, device);
      deviceIdMap.set(device.deviceKey, deviceResultId);

      for (const line of device.lines) {
        insertLineResult(db, runId, deviceResultId, line);
      }
    }

    // Persistir fotografia completa do estoque mapeável (item 5)
    for (const [, pool] of output.stockPools) {
      for (const ref of pool.refs) {
        insertStockResult(db, runId, {
          chavePeca: pool.chavePeca,
          chavePecaNorm: pool.chavePecaNorm,
          reference: ref.referencia,
          referenceNorm: ref.referenciaNorm,
          initialQuantity: ref.initialAvailable,
          allocatedFull: ref.allocatedFull,
          allocatedPartial: ref.allocatedPartial,
          remainingQuantity: ref.remaining,
        });
      }
    }

    // ── Validações de integridade ──────────────────────────────────────────

    // 1. Uma linha por source_order_part
    const lineCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM match_results WHERE match_run_id = ?")
        .get(runId) as { c: number }
    ).c;
    if (lineCount !== demandLines.length) {
      throw new Error(
        `Integridade: esperado ${demandLines.length} linhas em match_results, encontrado ${lineCount}.`,
      );
    }

    // 2. SUM(reserved_units) == allocated_units
    const sumReserved = (
      db
        .prepare("SELECT SUM(reserved_units) AS s FROM match_results WHERE match_run_id = ?")
        .get(runId) as { s: number }
    ).s ?? 0;
    if (sumReserved !== output.stats.allocatedUnits) {
      throw new Error(
        `Integridade: SUM(reserved_units)=${sumReserved} ≠ allocated_units=${output.stats.allocatedUnits}.`,
      );
    }

    // 3. Nenhuma superalocação por CHAVEPECA
    const poolRows = db
      .prepare(
        `SELECT chave_peca_norm, SUM(reserved_units) AS allocated, MAX(stock_for_key_initial) AS initial
         FROM match_results WHERE match_run_id = ? AND chave_peca_norm IS NOT NULL
         GROUP BY chave_peca_norm`,
      )
      .all(runId) as { chave_peca_norm: string; allocated: number; initial: number }[];
    for (const row of poolRows) {
      if (row.allocated > row.initial) {
        throw new Error(
          `Superalocação: CHAVEPECA "${row.chave_peca_norm}" alocou ${row.allocated} mas tinha ${row.initial} inicial.`,
        );
      }
    }

    // 4. Kit completo: todas as linhas abertas são MATCH
    const badKitFull = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM match_results r
           JOIN match_device_results d ON d.id = r.device_result_id
           WHERE r.match_run_id = ? AND d.kit_status = 'KIT POSSIVEL'
             AND r.allocation_phase != 'PRESERVED'
             AND r.result_status != 'MATCH'`,
        )
        .get(runId) as { c: number }
    ).c;
    if (badKitFull > 0) {
      throw new Error(
        `Integridade: ${badKitFull} linha(s) em kit completo sem status MATCH.`,
      );
    }

    // 5. Permanentes nunca têm reserved_units > 0
    const badPerm = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM match_results
           WHERE match_run_id = ? AND allocation_phase = 'PRESERVED' AND reserved_units > 0`,
        )
        .get(runId) as { c: number }
    ).c;
    if (badPerm > 0) {
      throw new Error(`Integridade: ${badPerm} linha(s) permanente(s) com reserved_units > 0.`);
    }

    // 6. Ordem de consumo por CHAVEPECA sem lacunas
    const consumoRows = db
      .prepare(
        `SELECT chave_peca_norm, GROUP_CONCAT(ordem_consumo ORDER BY ordem_consumo) AS seq
         FROM match_results
         WHERE match_run_id = ? AND ordem_consumo IS NOT NULL AND chave_peca_norm IS NOT NULL
         GROUP BY chave_peca_norm`,
      )
      .all(runId) as { chave_peca_norm: string; seq: string }[];
    for (const row of consumoRows) {
      const nums = row.seq.split(",").map(Number);
      for (let i = 0; i < nums.length; i++) {
        if (nums[i] !== i + 1) {
          throw new Error(
            `Integridade: ordem_consumo para "${row.chave_peca_norm}" tem lacuna (esperado ${i + 1}, encontrado ${nums[i]}).`,
          );
        }
      }
    }

    // 7. SUM(initial_quantity) = stockUsableUnits
    const sumStockInitial = (
      db.prepare("SELECT COALESCE(SUM(initial_quantity), 0) AS s FROM match_stock_results WHERE match_run_id = ?").get(runId) as { s: number }
    ).s;
    if (sumStockInitial !== output.stats.stockUsableUnits) {
      throw new Error(`Integridade estoque: SUM(initial_quantity)=${sumStockInitial} ≠ stockUsableUnits=${output.stats.stockUsableUnits}.`);
    }

    // 8. SUM(allocated_full + allocated_partial) = allocatedUnits
    const sumStockAlloc = (
      db.prepare("SELECT COALESCE(SUM(allocated_full + allocated_partial), 0) AS s FROM match_stock_results WHERE match_run_id = ?").get(runId) as { s: number }
    ).s;
    if (sumStockAlloc !== output.stats.allocatedUnits) {
      throw new Error(`Integridade estoque: SUM(alocado)=${sumStockAlloc} ≠ allocatedUnits=${output.stats.allocatedUnits}.`);
    }

    // 9. SUM(remaining_quantity) = remainingUsableUnits
    const sumStockRemaining = (
      db.prepare("SELECT COALESCE(SUM(remaining_quantity), 0) AS s FROM match_stock_results WHERE match_run_id = ?").get(runId) as { s: number }
    ).s;
    if (sumStockRemaining !== output.stats.remainingUsableUnits) {
      throw new Error(`Integridade estoque: SUM(remaining)=${sumStockRemaining} ≠ remainingUsableUnits=${output.stats.remainingUsableUnits}.`);
    }

    // 10. Por linha: initial = full + partial + remaining
    const badStockRows = (
      db.prepare(
        `SELECT COUNT(*) AS c FROM match_stock_results
         WHERE match_run_id = ?
           AND initial_quantity != allocated_full + allocated_partial + remaining_quantity`,
      ).get(runId) as { c: number }
    ).c;
    if (badStockRows > 0) {
      throw new Error(`Integridade estoque: ${badStockRows} linha(s) com initial ≠ full + partial + remaining.`);
    }

    const maxMovementId = (
      db
        .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM stock_movements")
        .get() as { m: number }
    ).m;

    // Concluir execução
    completeMatchRun(
      db,
      runId,
      output.stats,
      {
        total: output.stats.stockTotalUnits,
        usable: output.stats.stockUsableUnits,
        unmapped: output.stats.stockUnmappedUnits,
        maxMovementId,
      },
      output.stats.warningsCount > 0,
    );

    db.exec("COMMIT");

    const run = getMatchRun(db, runId)!;
    return { run, reused: false, stale: false, currentHash };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    // Após ROLLBACK, qualquer runId criado dentro da transação não existe mais.
    // Sempre cria um NOVO run com status FAILED em transação separada.
    const failMsg = (err as Error).message ?? "Erro desconhecido.";
    try {
      db.exec("BEGIN");
      const fid = createMatchRun(db, {
        importBatchId,
        decisionRuleId: rule.id,
        algorithmVersion: ALGORITHM_VERSION,
        inputHash: currentHash,
        createdBy,
        notes: input.notes ?? null,
        components,
      });
      failMatchRun(db, fid, failMsg);
      db.exec("COMMIT");
    } catch { /* best-effort — não deve bloquear o lançamento do erro original */ }

    if (err instanceof MatchError || err instanceof MatchConfigError) throw err;
    throw new MatchError(500, `Falha na execução do motor de match: ${failMsg}`);
  }
}

/** Verifica se uma execução está desatualizada (stale). */
export function isRunStale(db: Db, run: MatchRunRow): boolean {
  if (run.status !== "COMPLETED" && run.status !== "COMPLETED_WITH_WARNINGS") return false;
  if (!run.input_hash) return true;
  try {
    const rule = loadActiveRule(db);
    const components = collectFingerprintComponents(db, rule);
    return computeHash(components) !== run.input_hash;
  } catch {
    return true;
  }
}

/** Retorna a última execução concluída com indicação de stale. */
export function getLatestRun(db: Db): (MatchRunRow & { stale: boolean }) | null {
  const run = getLatestCompletedRun(db);
  if (!run) return null;
  return { ...run, stale: isRunStale(db, run) };
}

/** Estado atual para o fingerprint (para a tela de match). */
export function getCurrentState(db: Db): {
  hash: string;
  initialized: boolean;
  importBatchId: number | null;
  stockBase: string;
  stockSnapshotId: number | null;
  stockUsable: number;
  stockTotal: number;
  stockUnmapped: number;
  activeRule: { id: number; name: string } | null;
} {
  const state = getSystemState(db);
  let activeRule: { id: number; name: string } | null = null;
  let hash = "";
  let stockBase = "";
  let stockSnapshotId: number | null = null;
  let stockUsable = 0;
  let stockTotal = 0;
  let stockUnmapped = 0;

  try {
    const rule = loadActiveRule(db);
    activeRule = { id: rule.id, name: rule.name };
    const components = collectFingerprintComponents(db, rule);
    hash = computeHash(components);
    stockBase = components.stockBaseType;
    stockSnapshotId = components.stockSnapshotId;
    const stock = getCurrentOperationalStock(db);
    const { stats } = runMatchEngine({ demandLines: [], operationalEvents: new Map(), stockGroups: stock.groups, rule: { ageDaysPerPoint: rule.age_days_per_point, ageMaxPoints: rule.age_max_points, marginPerPoint: rule.margin_per_point, marginAllowsNegative: rule.margin_allows_negative === 1 } });
    stockUsable = stats.stockUsableUnits;
    stockTotal = stats.stockTotalUnits;
    stockUnmapped = stats.stockUnmappedUnits;
  } catch { /* sem regra ativa */ }

  return {
    hash,
    initialized: state.initialized === 1,
    importBatchId: state.initial_import_batch_id,
    stockBase,
    stockSnapshotId,
    stockUsable,
    stockTotal,
    stockUnmapped,
    activeRule,
  };
}

// Re-exportar funções de repositório necessárias pelas rotas
export {
  getMatchRun,
  listMatchRuns,
  listDeviceResults,
  listLineResults,
  getLineResultsForDevice,
  getStockSummaryFromResults,
  getComparisonData,
  getFullComparisonData,
  exportResultsCsv,
};
export type { ListMatchRunsParams, ListResultsParams };
