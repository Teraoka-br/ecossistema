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
  criados: number;
  atualizados: number;
  semVinculo: number;
  marcaModeloEnriquecidos: number;
  concluidos: number;
  direcionados: number;
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
  // "Com Saldo" (rel_seriais_saldo_current) tem prioridade sobre "Todos" (rel_seriais_current)
  // para deposito_atual e filial_atual. Demais campos vêm do "Todos" como fallback.
  const rows = db.prepare(
    `SELECT
       COALESCE(c.imei_norm, s.imei_norm) AS imei_norm,
       COALESCE(c.serial, s.serial)       AS serial,
       COALESCE(s.deposito_atual, c.deposito_atual) AS deposito_atual,
       COALESCE(s.filial_atual, c.filial_atual)     AS filial_atual,
       COALESCE(c.disponivel, s.disponivel)         AS disponivel,
       COALESCE(c.fabricante, s.fabricante)         AS fabricante,
       COALESCE(c.descricao, s.descricao)           AS descricao
     FROM rel_seriais_current c
     LEFT JOIN rel_seriais_saldo_current s ON s.imei_norm = c.imei_norm
     UNION
     SELECT
       s.imei_norm, s.serial,
       s.deposito_atual, s.filial_atual,
       s.disponivel, s.fabricante, s.descricao
     FROM rel_seriais_saldo_current s
     WHERE s.imei_norm NOT IN (SELECT imei_norm FROM rel_seriais_current WHERE imei_norm IS NOT NULL)`,
  ).all() as {
    imei_norm: string | null;
    serial: string | null;
    deposito_atual: string | null;
    filial_atual: string | null;
    disponivel: string | null;
    fabricante: string | null;
    descricao: string | null;
  }[];

  // Mapa depósito (uppercase) → staff_id para direcionamento automático
  const techRows = db.prepare(
    `SELECT id, datasys_deposito FROM staff_members WHERE type = 'TECHNICIAN' AND active = 1 AND datasys_deposito IS NOT NULL`,
  ).all() as { id: number; datasys_deposito: string }[];
  const depositoToTech = new Map<string, number>(
    techRows.map(t => [t.datasys_deposito.toUpperCase().trim(), t.id]),
  );

  const result: RelSeriaisSyncResult = {
    processados: 0, criados: 0, atualizados: 0, semVinculo: 0,
    marcaModeloEnriquecidos: 0, concluidos: 0, direcionados: 0,
  };

  const findCase = db.prepare(
    `SELECT id, brand, model, workflow_status FROM repair_cases WHERE imei_norm = ? LIMIT 1`,
  );
  const updateLocation = db.prepare(
    `UPDATE repair_cases SET deposito_atual = ?, filial_atual = ?, source_disponivel = ?,
       last_seen_in_source_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  );
  const enrichBrandModel = db.prepare(
    `UPDATE repair_cases SET brand = COALESCE(brand, ?), model = COALESCE(model, ?),
       updated_at = datetime('now') WHERE id = ?`,
  );
  const directTech = db.prepare(
    `UPDATE repair_cases SET workflow_status = 'DIRECIONADO_TECNICO',
       directed_technician_id = ?, directed_at = datetime('now'),
       updated_at = datetime('now') WHERE id = ?`,
  );

  // Depósitos que criam repair_case automaticamente quando o IMEI ainda não está no sistema.
  // Apenas esses dois significam "aparelho aguardando reparo" sem análise prévia.
  const DEPOSITOS_ENTRADA = new Set(["AGUARDANDO PECA", "MANUTENCAO INTERNA"]);

  // Mapeamento depósito Datasys → ação para cases JÁ existentes no sistema.
  // FLUXO_NORMAL = mantém status atual do sistema (Datasys não sobrescreve)
  // APTO_REPARO  = está com técnico → DIRECIONADO_TECNICO se configurado, senão APTO_REPARO
  // CONCLUIDO    = aparelho fora do fluxo de reparo (terminal — Datasys é autoritativo)
  // TRIAGEM/REPARO DE PLACA/AGUARDANDO RECEBIMENTO → FLUXO_NORMAL: o sistema já sabe o status
  //   real desses aparelhos; o Datasys não deve sobrescrever o pipeline de reparo em andamento.
  type DepositAction = "FLUXO_NORMAL" | "APTO_REPARO" | "CONCLUIDO";
  const DEPOSIT_MAP: Record<string, DepositAction> = {
    "MANUTENCAO INTERNA":        "FLUXO_NORMAL",
    "AGUARDANDO PECA":           "FLUXO_NORMAL",
    "TECNICO 1":                 "APTO_REPARO",
    "TECNICO 2":                 "APTO_REPARO",
    "TECNICO 3":                 "APTO_REPARO",
    "REPARO DE PLACA":           "FLUXO_NORMAL",
    "TRIAGEM":                   "FLUXO_NORMAL",
    "AGUARDANDO RECEBIMENTO":    "FLUXO_NORMAL",
    "VENDA NO ESTADO":           "CONCLUIDO",
    "APARELHO DE EMPRESTIMO":    "CONCLUIDO",
    "APARELHOS BLOQUEADOS":      "CONCLUIDO",
    "PARCIALMENTE FUNCIONAL":    "CONCLUIDO",
    "RETIRADA DE PECAS":         "CONCLUIDO",
    "MANUTENCAO EXTERNA":        "CONCLUIDO",
    "DISPONIVEIS PARA SITE":     "CONCLUIDO",
    "DISPONIVEIS PARA QUIOSQUE": "CONCLUIDO",
    "DEVOLVIDOS E DEFEITO":      "CONCLUIDO",
    "NOVOS DISPONIVEIS":         "CONCLUIDO",
  };

  // Estados que não devem ser regredidos por EM_ANALISE ou APTO_REPARO via Datasys.
  // CONCLUIDO é sempre aplicado (Datasys é autoritativo para aparelhos fora do fluxo).
  const LOCKED_FROM_DEMOTION = new Set([
    "EM_SEPARACAO", "EM_REPARO", "REPARO_EXECUTADO",
    "TRIAGEM_FINAL", "RETORNO_TECNICO",
    "CONCLUIDO", "VENDA_ESTADO", "CANCELADO",
  ]);

  const markConcluido = db.prepare(
    `UPDATE repair_cases SET workflow_status = 'CONCLUIDO',
       updated_at = datetime('now') WHERE id = ?`,
  );
  const markAptoReparo = db.prepare(
    `UPDATE repair_cases SET workflow_status = 'APTO_REPARO',
       updated_at = datetime('now') WHERE id = ?`,
  );
  const createCase = db.prepare(
    `INSERT INTO repair_cases
       (imei, imei_norm, brand, model, deposito_atual, filial_atual, source_disponivel,
        last_seen_in_source_at, workflow_status, analysis_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), 'EM_ANALISE', 'DRAFT', datetime('now'), datetime('now'))`,
  );

  db.prepare("BEGIN").run();
  try {
    for (const row of rows) {
      result.processados++;
      if (!row.imei_norm) { result.semVinculo++; continue; }

      const rc = findCase.get(row.imei_norm) as {
        id: number; brand: string | null; model: string | null; workflow_status: string;
      } | undefined;

      if (!rc) {
        // Criar repair_case apenas para depósitos de entrada (aparelhos aguardando reparo)
        const deposito = row.deposito_atual?.trim().toUpperCase() ?? "";
        if (DEPOSITOS_ENTRADA.has(deposito)) {
          createCase.run(
            row.serial ?? row.imei_norm,
            row.imei_norm,
            row.fabricante ?? null,
            row.descricao ?? null,
            row.deposito_atual,
            row.filial_atual,
            row.disponivel,
          );
          result.criados++;
        } else {
          result.semVinculo++;
        }
        continue;
      }

      updateLocation.run(row.deposito_atual, row.filial_atual, row.disponivel, rc.id);
      result.atualizados++;

      // Enriquecer marca/modelo somente quando vazio no cadastro interno
      const sourceBrand = row.fabricante ?? null;
      const sourceModel = row.descricao ?? null;
      if ((sourceBrand && !rc.brand) || (sourceModel && !rc.model)) {
        enrichBrandModel.run(sourceBrand, sourceModel, rc.id);
        result.marcaModeloEnriquecidos++;
      }

      const deposito = row.deposito_atual?.trim().toUpperCase() ?? "";
      const action: DepositAction | undefined = deposito ? DEPOSIT_MAP[deposito] : undefined;

      if (!action) {
        // Depósito desconhecido — ignora (não altera status do sistema)
        continue;
      }

      switch (action) {
        case "FLUXO_NORMAL":
          // Mantém status atual — case segue no pipeline de match/peças
          break;

        case "CONCLUIDO":
          // Terminal: Datasys é autoritativo — aparelho saiu do fluxo de reparo
          if (rc.workflow_status !== "CONCLUIDO") {
            markConcluido.run(rc.id);
            result.concluidos++;
          }
          break;

        case "APTO_REPARO": {
          // Não regride estados mais avançados que APTO_REPARO/DIRECIONADO
          if (LOCKED_FROM_DEMOTION.has(rc.workflow_status)) break;
          // Se técnico configurado para esse depósito → direcionar automaticamente
          const techId = depositoToTech.get(deposito);
          if (techId !== undefined) {
            directTech.run(techId, rc.id);
            result.direcionados++;
          } else if (rc.workflow_status !== "APTO_REPARO" && rc.workflow_status !== "DIRECIONADO_TECNICO") {
            markAptoReparo.run(rc.id);
          }
          break;
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
  const findScoreFromLegacy = db.prepare(
    `SELECT idade, custo, venda, margem_legada FROM source_order_parts WHERE imei = ? ORDER BY rowid LIMIT 1`,
  );
  // workflow_status e analysis_status são parametrizados (? ?)
  const createCase = db.prepare(
    `INSERT INTO repair_cases (imei, imei_norm, os, brand, model, color,
       repair_date, repair_date_source, workflow_status, analysis_status,
       age_days, cost, estimated_sale, margin,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ANALISE_MI', ?, 'COMPLETED', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
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
        const legacyScore = row.imei_norm
          ? (findScoreFromLegacy.get(row.imei_norm) as { idade: number | null; custo: number | null; venda: number | null; margem_legada: number | null } | undefined)
          : undefined;
        const cr = createCase.run(
          row.imei, row.imei_norm, row.os,
          row.brand, row.model, row.color,
          row.data_pedido,
          newWorkflow,
          legacyScore?.idade ?? null,
          legacyScore?.custo ?? null,
          legacyScore?.venda ?? null,
          legacyScore?.margem_legada ?? null,
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
