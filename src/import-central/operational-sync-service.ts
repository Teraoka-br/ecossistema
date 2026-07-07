/**
 * Camada de aplicação operacional das importações da Central de Dados.
 *
 * Cada função `applyXxx` é chamada APÓS o commit da importação correspondente
 * e DENTRO de uma transação independente. Falha aqui não desfaz a importação.
 *
 * Resultado: aparelhos/solicitações atualizados vs. ignorados vs. criados.
 */

import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";

// ---------------------------------------------------------------------------
// Tipos de resultado
// ---------------------------------------------------------------------------

export interface HisSyncResult {
  aparelhosEncontrados: number;
  idadeAtualizada: number;
  custoAtualizado: number;
  imeisSemVinculo: number;
  casosNaoAlterados: number;
}

export interface RelSeriaisSyncResult {
  processados: number;
  atualizados: number;
  semVinculo: number;
  marcaModeloEnriquecidos: number;
}

export interface AnaliseMiSyncResult {
  aparelhosCriados: number;
  aparelhosAtualizados: number;
  solicitacoesCriadas: number;
  solicitacoesAtualizadas: number;
  ignoradas: number;
  conflitos: number;
}

export interface BipagemStockResult {
  snapshotId: number;
  itemsInserted: number;
  previousSnapshotDeactivated: boolean;
}

export interface PeacsSyncResult {
  atualizados: number;
  semCorrespondencia: number;
  ambiguos: number;
}

export interface PedidosReconciliationResult {
  processadas: number;
  legacyStatusAtualizado: number;
  divergencias: number;
}

// ---------------------------------------------------------------------------
// Status que não devem ser regredidos pela importação
// ---------------------------------------------------------------------------


const ADVANCED_PART_STATUSES = new Set([
  "RESERVADA", "SEPARADA", "CONSUMIDA", "CANCELADA",
]);

// ---------------------------------------------------------------------------
// 1. HIS → repair_cases (age_days, cost)
// ---------------------------------------------------------------------------

export function applyHisToRepairCases(db: Db, _importId?: number): HisSyncResult {
  const rows = db.prepare(
    `SELECT imei_norm, age_days, audited_cost FROM his_current`,
  ).all() as { imei_norm: string | null; age_days: number | null; audited_cost: number | null }[];

  const result: HisSyncResult = {
    aparelhosEncontrados: 0,
    idadeAtualizada: 0,
    custoAtualizado: 0,
    imeisSemVinculo: 0,
    casosNaoAlterados: 0,
  };

  const findCase = db.prepare(`SELECT id FROM repair_cases WHERE imei_norm = ? LIMIT 1`);
  const updateCase = db.prepare(
    `UPDATE repair_cases SET age_days = COALESCE(?, age_days), cost = COALESCE(?, cost),
       updated_at = datetime('now') WHERE id = ?`,
  );

  db.prepare("BEGIN").run();
  try {
    for (const row of rows) {
      if (!row.imei_norm) { result.imeisSemVinculo++; continue; }

      const found = findCase.get(row.imei_norm) as { id: number } | undefined;
      if (!found) { result.imeisSemVinculo++; continue; }

      result.aparelhosEncontrados++;

      const newAge = row.age_days;
      const newCost = row.audited_cost;

      if (newAge === null && newCost === null) { result.casosNaoAlterados++; continue; }

      updateCase.run(newAge, newCost, found.id);
      if (newAge !== null) result.idadeAtualizada++;
      if (newCost !== null) result.custoAtualizado++;
    }
    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* */ }
    throw err;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. Rel Seriais → repair_cases (deposito, filial, disponivel, last_seen)
// ---------------------------------------------------------------------------

export function applyRelSeriaisToRepairCases(db: Db, _importId?: number): RelSeriaisSyncResult {
  const rows = db.prepare(
    `SELECT imei_norm, deposito_atual, filial_atual, disponivel, fabricante, descricao
     FROM rel_seriais_current`,
  ).all() as {
    imei_norm: string | null;
    deposito_atual: string | null;
    filial_atual: string | null;
    disponivel: string | null;
    fabricante: string | null;
    descricao: string | null;
  }[];

  const result: RelSeriaisSyncResult = { processados: 0, atualizados: 0, semVinculo: 0, marcaModeloEnriquecidos: 0 };

  const findCase = db.prepare(`SELECT id, brand, model FROM repair_cases WHERE imei_norm = ? LIMIT 1`);
  const updateLocation = db.prepare(
    `UPDATE repair_cases SET deposito_atual = ?, filial_atual = ?, source_disponivel = ?,
       last_seen_in_source_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  );
  const enrichBrandModel = db.prepare(
    `UPDATE repair_cases SET brand = COALESCE(brand, ?), model = COALESCE(model, ?),
       updated_at = datetime('now') WHERE id = ?`,
  );

  db.prepare("BEGIN").run();
  try {
    for (const row of rows) {
      result.processados++;
      if (!row.imei_norm) { result.semVinculo++; continue; }

      const rc = findCase.get(row.imei_norm) as { id: number; brand: string | null; model: string | null } | undefined;
      if (!rc) { result.semVinculo++; continue; }

      updateLocation.run(row.deposito_atual, row.filial_atual, row.disponivel, rc.id);
      result.atualizados++;

      // Enriquecer marca/modelo somente quando vazio no cadastro interno
      const sourceBrand = row.fabricante ?? null;
      const sourceModel = row.descricao ?? null;
      if ((sourceBrand && !rc.brand) || (sourceModel && !rc.model)) {
        enrichBrandModel.run(sourceBrand, sourceModel, rc.id);
        result.marcaModeloEnriquecidos++;
      }
    }
    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* */ }
    throw err;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 3. ANALISE MI → repair_cases + part_requests
// ---------------------------------------------------------------------------

export function applyAnaliseMiToRepairCases(db: Db, importId: number): AnaliseMiSyncResult {
  const rows = db.prepare(
    `SELECT id_pedido, imei, imei_norm, os, brand, model, color, peca_solicitada,
            concat_peca, data_pedido, status_src, deposito_src, ref_peca, solicitante
     FROM analise_mi_rows WHERE analise_mi_import_id = ?`,
  ).all(importId) as {
    id_pedido: string;
    imei: string | null;
    imei_norm: string | null;
    os: string | null;
    brand: string | null;
    model: string | null;
    color: string | null;
    peca_solicitada: string | null;
    concat_peca: string | null;
    data_pedido: string | null;
    status_src: string | null;
    deposito_src: string | null;
    ref_peca: string | null;
    solicitante: string | null;
  }[];

  const result: AnaliseMiSyncResult = {
    aparelhosCriados: 0, aparelhosAtualizados: 0,
    solicitacoesCriadas: 0, solicitacoesAtualizadas: 0,
    ignoradas: 0, conflitos: 0,
  };

  const ADVANCED_WORKFLOW_STATUSES = new Set([
    "AGUARDANDO_RECEBIMENTO", "MATCH", "MATCH_PARCIAL", "EM_SEPARACAO", "APTO_REPARO",
    "DIRECIONADO_TECNICO", "EM_REPARO", "REPARO_EXECUTADO", "TRIAGEM_FINAL", "RETORNO_TECNICO",
    "CONCLUIDO", "VENDA_ESTADO", "CANCELADO",
  ]);

  const findPartByLegacyId = db.prepare(
    `SELECT pr.id, pr.repair_case_id, pr.status, pr.chave_peca, pr.legacy_status
     FROM part_requests pr WHERE pr.legacy_id_pedido = ? LIMIT 1`,
  );
  const findCaseByImei = db.prepare(
    `SELECT id, workflow_status, analysis_status FROM repair_cases WHERE imei_norm = ? LIMIT 1`,
  );
  // workflow_status e analysis_status são parametrizados (? ?)
  const createCase = db.prepare(
    `INSERT INTO repair_cases (imei, imei_norm, os, brand, model, color,
       repair_date, repair_date_source, workflow_status, analysis_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ANALISE_MI', ?, 'COMPLETED', datetime('now'), datetime('now'))`,
  );
  const updateCaseMeta = db.prepare(
    `UPDATE repair_cases SET brand = COALESCE(brand, ?), model = COALESCE(model, ?),
       color = COALESCE(color, ?), updated_at = datetime('now') WHERE id = ?`,
  );
  const createPart = db.prepare(
    `INSERT INTO part_requests
       (repair_case_id, legacy_id_pedido, chave_peca, chave_peca_norm, description,
        status, legacy_status, analysis_complete_at_creation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  );
  const updatePartLegacy = db.prepare(
    `UPDATE part_requests SET legacy_status = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  // Só avança se o workflow atual não for um estado avançado
  const updateCaseWorkflowIfNotAdvanced = db.prepare(
    `UPDATE repair_cases SET workflow_status = ?, analysis_status = 'COMPLETED', updated_at = datetime('now')
     WHERE id = ? AND workflow_status NOT IN (
       'AGUARDANDO_RECEBIMENTO','MATCH','MATCH_PARCIAL','EM_SEPARACAO','APTO_REPARO',
       'DIRECIONADO_TECNICO','EM_REPARO','REPARO_EXECUTADO','TRIAGEM_FINAL','RETORNO_TECNICO',
       'CONCLUIDO','VENDA_ESTADO','CANCELADO'
     )`,
  );

  db.prepare("BEGIN").run();
  try {
    for (const row of rows) {
      if (!row.id_pedido) { result.ignoradas++; continue; }

      // Determinar CHAVEPECA a usar (concat_peca > ref_peca, com normalização)
      const rawChave = row.concat_peca ?? row.ref_peca ?? null;
      const chaveNorm = rawChave ? normalizeKey(rawChave) : null;
      const hasValidChave = !!chaveNorm && chaveNorm.length >= 3;

      // Determinar status operacional da peça
      const legacySrc = row.status_src ?? null;
      let partStatus: string;
      if (!hasValidChave) {
        partStatus = "VERIFICAR";
      } else {
        partStatus = "PEDIR_PECA";
      }

      // 1. Verificar se já existe solicitação com este legacy_id_pedido
      const existingPart = findPartByLegacyId.get(row.id_pedido) as {
        id: number; repair_case_id: number; status: string; chave_peca: string | null; legacy_status: string | null;
      } | undefined;

      if (existingPart) {
        // Atualizar apenas legacy_status e chave (se em estado não avançado)
        updatePartLegacy.run(legacySrc, existingPart.id);

        const isAdvanced = ADVANCED_PART_STATUSES.has(existingPart.status);
        if (!isAdvanced && hasValidChave && !existingPart.chave_peca) {
          db.prepare(`UPDATE part_requests SET chave_peca = ?, chave_peca_norm = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(rawChave, chaveNorm, existingPart.id);
        }

        result.solicitacoesAtualizadas++;

        // Atualizar metadados do aparelho
        if (row.brand || row.model || row.color) {
          updateCaseMeta.run(row.brand, row.model, row.color, existingPart.repair_case_id);
          result.aparelhosAtualizados++;
        }
        continue;
      }

      // 2. Não existe — localizar ou criar repair_case
      if (!row.imei_norm) { result.ignoradas++; continue; }

      let caseId: number;
      const existingCase = findCaseByImei.get(row.imei_norm) as {
        id: number; workflow_status: string; analysis_status: string;
      } | undefined;

      if (existingCase) {
        caseId = existingCase.id;
        updateCaseMeta.run(row.brand, row.model, row.color, caseId);
        result.aparelhosAtualizados++;
      } else {
        // Novo caso: criar já com analysis_status=COMPLETED e workflow baseado na chave
        const newWorkflow = hasValidChave ? "PEDIR_PECA" : "VERIFICAR";
        const cr = createCase.run(
          row.imei, row.imei_norm, row.os,
          row.brand, row.model, row.color,
          row.data_pedido,
          newWorkflow,
        );
        caseId = Number(cr.lastInsertRowid);
        result.aparelhosCriados++;
      }

      // 3. Criar part_request com analysis_complete_at_creation=1
      createPart.run(caseId, row.id_pedido, rawChave, chaveNorm, row.peca_solicitada, partStatus, legacySrc);
      result.solicitacoesCriadas++;

      // 4. Para casos existentes em estado não avançado, atualizar workflow se necessário
      if (existingCase && !ADVANCED_WORKFLOW_STATUSES.has(existingCase.workflow_status)) {
        updateCaseWorkflowIfNotAdvanced.run(partStatus, caseId);
      }
    }
    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* */ }
    throw err;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. BIPAGEM → stock_snapshot oficial
// ---------------------------------------------------------------------------

export function applyBipagemToStock(db: Db, importId: number): BipagemStockResult {
  // Consolidar por (referencia_corr, chave_peca_norm) — cada linha = 1 unidade
  const bipagemRows = db.prepare(
    `SELECT referencia_corr, chave_peca, chave_peca_norm, COUNT(*) AS qty
     FROM pedidos_bipagem_rows
     WHERE pedidos_import_id = ? AND referencia_corr IS NOT NULL
     GROUP BY referencia_corr, chave_peca_norm`,
  ).all(importId) as { referencia_corr: string; chave_peca: string | null; chave_peca_norm: string | null; qty: number }[];

  if (bipagemRows.length === 0) {
    throw new Error("Nenhuma linha de bipagem encontrada para este importId.");
  }

  // Pegar o maior stock_movement_id atual (corte de movimentações)
  const maxMovRow = db.prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM stock_movements`).get() as { max_id: number };
  const baselineMovementIdMax = maxMovRow.max_id;

  // Batch associado ao import (ou null)
  const batchRow = db.prepare(`SELECT initial_import_batch_id FROM system_state LIMIT 1`).get() as { initial_import_batch_id: number | null } | undefined;
  const batchId = batchRow?.initial_import_batch_id ?? null;

  let snapshotId = 0;
  let previousDeactivated = false;

  db.prepare("BEGIN").run();
  try {
    // Desativar snapshot OFFICIAL anterior
    const prevRow = db.prepare(
      `SELECT id FROM stock_snapshots WHERE status = 'OFFICIAL' ORDER BY id DESC LIMIT 1`,
    ).get() as { id: number } | undefined;
    if (prevRow) {
      db.prepare(`UPDATE stock_snapshots SET status = 'SUPERSEDED', updated_at = datetime('now') WHERE id = ?`).run(prevRow.id);
      previousDeactivated = true;
    }

    // Criar novo snapshot
    const snRow = db.prepare(
      `INSERT INTO stock_snapshots
         (count_session_id, import_batch_id, status, total_units, baseline_movement_id_max, created_at, updated_at, responsible_name)
       VALUES (NULL, ?, 'OFFICIAL', ?, ?, datetime('now'), datetime('now'), 'BIPAGEM_IMPORT')`,
    ).run(batchId, bipagemRows.reduce((s, r) => s + r.qty, 0), baselineMovementIdMax);
    snapshotId = Number(snRow.lastInsertRowid);

    // Inserir itens consolidados
    const insertItem = db.prepare(
      `INSERT INTO stock_snapshot_items
         (stock_snapshot_id, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of bipagemRows) {
      const refNorm = normalizeKey(row.referencia_corr);
      insertItem.run(snapshotId, row.referencia_corr, refNorm, row.chave_peca, row.chave_peca_norm, row.qty);
    }

    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* */ }
    throw err;
  }

  return { snapshotId, itemsInserted: bipagemRows.length, previousSnapshotDeactivated: previousDeactivated };
}

// ---------------------------------------------------------------------------
// 5. PEACS → repair_cases (estimated_sale, margin)
// ---------------------------------------------------------------------------

export function applyPeacsToRepairCases(db: Db): PeacsSyncResult {
  const result: PeacsSyncResult = { atualizados: 0, semCorrespondencia: 0, ambiguos: 0 };

  // Pegar catálogo PEACS ativo (marca_modelo_norm → estimated_sale)
  const catalog = db.prepare(
    `SELECT marca_modelo_norm, estimated_sale FROM peacs_catalog WHERE active = 1`,
  ).all() as { marca_modelo_norm: string; estimated_sale: number }[];
  const catalogMap = new Map<string, number>();
  for (const c of catalog) catalogMap.set(c.marca_modelo_norm, c.estimated_sale);

  if (catalogMap.size === 0) return result;

  // Para cada repair_case com brand e model, tentar match
  const cases = db.prepare(
    `SELECT id, brand, model, cost FROM repair_cases WHERE brand IS NOT NULL AND model IS NOT NULL`,
  ).all() as { id: number; brand: string; model: string; cost: number | null }[];

  const updateCase = db.prepare(
    `UPDATE repair_cases SET estimated_sale = ?, margin = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  db.prepare("BEGIN").run();
  try {
    for (const rc of cases) {
      const key = normalizeKey(`${rc.brand} ${rc.model}`);
      if (catalogMap.has(key)) {
        const sale = catalogMap.get(key)!;
        const margin = rc.cost !== null ? sale - rc.cost : null;
        updateCase.run(sale, margin, rc.id);
        result.atualizados++;
      } else {
        // Verificar match por prefixo (modelo sem capacidade) — busca simples
        const partialKey = key.split(/\s+/).slice(0, 2).join(" ");
        const matches = [...catalogMap.entries()].filter(([k]) => k.startsWith(partialKey));
        if (matches.length === 1) {
          const sale = matches[0][1];
          const margin = rc.cost !== null ? sale - rc.cost : null;
          updateCase.run(sale, margin, rc.id);
          result.atualizados++;
        } else if (matches.length > 1) {
          result.ambiguos++;
        } else {
          result.semCorrespondencia++;
        }
      }
    }
    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* */ }
    throw err;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 6. PEDIDOS reconciliação → legacy_status em part_requests
// ---------------------------------------------------------------------------

export function applyPedidosReconciliation(db: Db, importId: number): PedidosReconciliationResult {
  const rows = db.prepare(
    `SELECT id_pedido, status_src FROM pedidos_reconciliation_rows WHERE pedidos_import_id = ?`,
  ).all(importId) as { id_pedido: string; status_src: string | null }[];

  const result: PedidosReconciliationResult = { processadas: 0, legacyStatusAtualizado: 0, divergencias: 0 };

  const findPart = db.prepare(
    `SELECT id, status, legacy_status FROM part_requests WHERE legacy_id_pedido = ? LIMIT 1`,
  );
  const updateLegacy = db.prepare(
    `UPDATE part_requests SET legacy_status = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  db.prepare("BEGIN").run();
  try {
    for (const row of rows) {
      result.processadas++;
      const pr = findPart.get(row.id_pedido) as { id: number; status: string; legacy_status: string | null } | undefined;
      if (!pr) continue;

      // Nunca regredir status operacional avançado
      const isAdvanced = ADVANCED_PART_STATUSES.has(pr.status);
      if (row.status_src && row.status_src !== pr.legacy_status) {
        updateLegacy.run(row.status_src, pr.id);
        result.legacyStatusAtualizado++;
        if (isAdvanced) result.divergencias++;
      }
    }
    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* */ }
    throw err;
  }

  return result;
}
