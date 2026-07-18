import type { Db } from "../db/database.js";
import { normalizeKey as normalizeText } from "../domain/text.js";

export type AnalysisStatus = "DRAFT" | "COMPLETED";
export type WorkflowStatus =
  | "EM_ANALISE" | "PEDIR_PECA" | "AGUARDANDO_RECEBIMENTO"
  | "MATCH_PARCIAL" | "MATCH" | "EM_SEPARACAO" | "APTO_REPARO"
  | "DIRECIONADO_TECNICO" | "EM_REPARO" | "REPARO_EXECUTADO"
  | "TRIAGEM_FINAL" | "RETORNO_TECNICO"
  | "CONCLUIDO" | "VENDA_ESTADO" | "CANCELADO" | "VERIFICAR";

export const TERMINAL_WORKFLOW_STATUSES: WorkflowStatus[] = ["CONCLUIDO", "VENDA_ESTADO", "CANCELADO"];

export type PartStatus =
  | "PEDIR_PECA" | "AGUARDANDO_RECEBIMENTO" | "INDICADA"
  | "RESERVADA" | "SEPARADA" | "CONSUMIDA" | "CANCELADA" | "VERIFICAR";

export interface RepairCase {
  id: number;
  imei: string | null;
  imeiNorm: string | null;
  os: string | null;
  osNorm: string | null;
  brand: string | null;
  model: string | null;
  capacity: string | null;
  color: string | null;
  entryDate: string | null;
  repairDate: string | null;
  repairDateSource: string | null;
  ageDays: number | null;
  cost: number | null;
  estimatedSale: number | null;
  margin: number | null;
  notes: string | null;
  analysisStatus: AnalysisStatus;
  workflowStatus: WorkflowStatus;
  assignedTechnicianId: number | null;
  directedTechnicianId: number | null;
  directedAt: string | null;
  directedByUserId: number | null;
  manualPriorityActive: boolean;
  legacyImportBatchId: number | null;
  legacyDeviceKey: string | null;
  legacyCaseKey: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PartRequest {
  id: number;
  repairCaseId: number;
  description: string | null;
  chavePeca: string | null;
  chavePecaNorm: string | null;
  status: PartStatus;
  purchaseStatus: string | null;
  allocatedReference: string | null;
  allocatedReferenceNorm: string | null;
  analysisCompleteAtCreation: boolean;
  manualOverride: boolean;
  manualOverrideReason: string | null;
  sourceOrderPartId: number | null;
  legacyIdPedido: string | null;
  legacyStatus: string | null;
  legacyKitStatus: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export interface Priority {
  id: number;
  repairCaseId: number;
  active: boolean;
  reason: string;
  createdByUserId: number | null;
  createdAt: string;
  removedByUserId: number | null;
  removedAt: string | null;
  removalReason: string | null;
}

export class RepairError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RepairError";
  }
}

// ---------------------------------------------------------------------------
// Repair cases
// ---------------------------------------------------------------------------

export function listRepairCases(
  db: Db,
  opts: { workflowStatus?: WorkflowStatus; analysisStatus?: AnalysisStatus; limit?: number; offset?: number } = {},
): { cases: RepairCase[]; total: number } {
  const conditions: string[] = [];
  const p: (string | number | null)[] = [];
  if (opts.workflowStatus) { conditions.push("workflow_status = ?"); p.push(opts.workflowStatus); }
  if (opts.analysisStatus) { conditions.push("analysis_status = ?"); p.push(opts.analysisStatus); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const total = (db.prepare(`SELECT COUNT(*) as c FROM repair_cases ${where}`).get(...p) as { c: number }).c;
  const rows = db.prepare(`SELECT * FROM repair_cases ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...p, limit, offset) as unknown as RepairCaseRow[];
  return { cases: rows.map(toRepairCase), total };
}

export function searchRepairCases(
  db: Db,
  params: { imei?: string; os?: string; repairDate?: string; limit?: number },
): { cases: RepairCase[]; total: number } {
  const conditions: string[] = [];
  const p: (string | number | null)[] = [];
  if (params.imei) { conditions.push("imei_norm = ?"); p.push(normalizeText(params.imei)); }
  if (params.os) { conditions.push("os_norm = ?"); p.push(normalizeText(params.os)); }
  if (params.repairDate) { conditions.push("repair_date = ?"); p.push(params.repairDate); }
  if (conditions.length === 0) return { cases: [], total: 0 };
  const where = `WHERE ${conditions.join(" AND ")}`;
  const limit = params.limit ?? 20;
  const total = (db.prepare(`SELECT COUNT(*) as c FROM repair_cases ${where}`).get(...p) as { c: number }).c;
  const rows = db.prepare(`SELECT * FROM repair_cases ${where} ORDER BY created_at DESC LIMIT ?`).all(...p, limit) as unknown as RepairCaseRow[];
  return { cases: rows.map(toRepairCase), total };
}

export function getRepairCaseById(db: Db, id: number): RepairCase | null {
  const row = db.prepare("SELECT * FROM repair_cases WHERE id = ?").get(id) as RepairCaseRow | undefined;
  return row ? toRepairCase(row) : null;
}

export function getRepairCaseWithParts(db: Db, id: number): (RepairCase & { parts: PartRequest[] }) | null {
  const rc = getRepairCaseById(db, id);
  if (!rc) return null;
  const parts = getPartsByCase(db, id);
  return { ...rc, parts };
}

export function createRepairCase(
  db: Db,
  params: {
    imei?: string | null;
    os?: string | null;
    brand?: string | null;
    model?: string | null;
    entryDate?: string | null;
    repairDate?: string | null;
    repairDateSource?: string | null;
    ageDays?: number | null;
    cost?: number | null;
    estimatedSale?: number | null;
    notes?: string | null;
    assignedTechnicianId?: number | null;
    legacyImportBatchId?: number | null;
    legacyDeviceKey?: string | null;
    legacyCaseKey?: string | null;
    workflowStatus?: WorkflowStatus;
    analysisStatus?: AnalysisStatus;
    createdByUserId?: number | null;
    creationSource?: "IMPORT" | "MANUAL" | "DATASYS";
  },
): RepairCase {
  const imeiNorm = params.imei ? normalizeText(params.imei) : null;
  const osNorm = params.os ? normalizeText(params.os) : null;

  // Bloquear se já existe caso com mesmo IMEI+OS+repair_date (somente para casos novos, não migração)
  if (imeiNorm && osNorm && params.repairDate && !params.legacyCaseKey) {
    const existing = db
      .prepare(
        `SELECT id FROM repair_cases WHERE imei_norm = ? AND os_norm = ? AND repair_date = ? LIMIT 1`,
      )
      .get(imeiNorm, osNorm, params.repairDate) as { id: number } | undefined;
    if (existing) {
      throw new RepairError(
        "DUPLICATE_CASE",
        `Já existe um caso para IMEI ${params.imei}, OS ${params.os} na data ${params.repairDate} (id ${existing.id}).`,
      );
    }
  }

  const margin =
    params.cost != null && params.estimatedSale != null
      ? params.estimatedSale - params.cost
      : null;

  const res = db
    .prepare(
      `INSERT INTO repair_cases
         (imei, imei_norm, os, os_norm, brand, model, entry_date, repair_date, repair_date_source,
          age_days, cost, estimated_sale, margin, notes, analysis_status, workflow_status,
          assigned_technician_id, legacy_import_batch_id, legacy_device_key, legacy_case_key,
          created_by_user_id, updated_by_user_id, creation_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      params.imei ?? null, imeiNorm,
      params.os ?? null, osNorm,
      params.brand ?? null, params.model ?? null,
      params.entryDate ?? null,
      params.repairDate ?? null, params.repairDateSource ?? null,
      params.ageDays ?? null,
      params.cost ?? null, params.estimatedSale ?? null, margin,
      params.notes ?? null,
      params.analysisStatus ?? "DRAFT",
      params.workflowStatus ?? "EM_ANALISE",
      params.assignedTechnicianId ?? null,
      params.legacyImportBatchId ?? null,
      params.legacyDeviceKey ?? null,
      params.legacyCaseKey ?? null,
      params.createdByUserId ?? null,
      params.createdByUserId ?? null,
      params.creationSource ?? "MANUAL",
    );
  return getRepairCaseById(db, res.lastInsertRowid as number)!;
}

export function updateRepairCase(
  db: Db,
  id: number,
  params: {
    brand?: string | null;
    model?: string | null;
    entryDate?: string | null;
    repairDate?: string | null;
    repairDateSource?: string | null;
    ageDays?: number | null;
    cost?: number | null;
    estimatedSale?: number | null;
    notes?: string | null;
    assignedTechnicianId?: number | null;
    workflowStatus?: WorkflowStatus;
    updatedByUserId?: number | null;
  },
): RepairCase {
  const rc = getRepairCaseById(db, id);
  if (!rc) throw new RepairError("NOT_FOUND", "Caso não encontrado.");

  const newCost = params.cost !== undefined ? params.cost : rc.cost;
  const newSale = params.estimatedSale !== undefined ? params.estimatedSale : rc.estimatedSale;
  const margin = newCost != null && newSale != null ? newSale - newCost : rc.margin;

  db.prepare(
    `UPDATE repair_cases SET
       brand = COALESCE(?, brand),
       model = COALESCE(?, model),
       entry_date = COALESCE(?, entry_date),
       repair_date = COALESCE(?, repair_date),
       repair_date_source = COALESCE(?, repair_date_source),
       age_days = COALESCE(?, age_days),
       cost = ?,
       estimated_sale = ?,
       margin = ?,
       notes = COALESCE(?, notes),
       assigned_technician_id = COALESCE(?, assigned_technician_id),
       workflow_status = COALESCE(?, workflow_status),
       updated_by_user_id = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    params.brand ?? null, params.model ?? null,
    params.entryDate ?? null,
    params.repairDate ?? null, params.repairDateSource ?? null,
    params.ageDays ?? null,
    newCost, newSale, margin,
    params.notes ?? null,
    params.assignedTechnicianId ?? null,
    params.workflowStatus ?? null,
    params.updatedByUserId ?? null,
    id,
  );
  return getRepairCaseById(db, id)!;
}

export function completeAnalysis(db: Db, id: number, userId: number | null): RepairCase {
  const rc = getRepairCaseById(db, id);
  if (!rc) throw new RepairError("NOT_FOUND", "Caso não encontrado.");
  if (rc.analysisStatus === "COMPLETED") throw new RepairError("ALREADY_COMPLETED", "Análise já finalizada.");

  const parts = getPartsByCase(db, id).filter((p) => p.status !== "CANCELADA");
  if (!rc.imei) throw new RepairError("MISSING_IMEI", "IMEI obrigatório para finalizar análise.");
  if (!rc.os) throw new RepairError("MISSING_OS", "OS obrigatória para finalizar análise.");
  if (!rc.model) throw new RepairError("MISSING_MODEL", "Modelo obrigatório para finalizar análise.");
  if (rc.ageDays == null) throw new RepairError("MISSING_AGE", "Idade obrigatória para finalizar análise.");
  if (rc.cost == null) throw new RepairError("MISSING_COST", "Custo obrigatório para finalizar análise.");
  if (rc.estimatedSale == null) throw new RepairError("MISSING_SALE", "Venda estimada obrigatória para finalizar análise.");
  if (!rc.repairDate) throw new RepairError("MISSING_REPAIR_DATE", "Data do reparo obrigatória para finalizar análise.");
  if (parts.length === 0) throw new RepairError("NO_PARTS", "Ao menos uma peça é necessária para finalizar análise.");

  db.prepare(
    "UPDATE repair_cases SET analysis_status = 'COMPLETED', updated_by_user_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(userId ?? null, id);

  db.prepare(
    "UPDATE part_requests SET analysis_complete_at_creation = 1 WHERE repair_case_id = ? AND status != 'CANCELADA'",
  ).run(id);

  return getRepairCaseById(db, id)!;
}

// ---------------------------------------------------------------------------
// Transactional save (create/update case + parts in one shot)
// ---------------------------------------------------------------------------

export function saveAnalysis(
  db: Db,
  params: {
    caseId?: number | null;
    imei?: string | null;
    os?: string | null;
    brand?: string | null;
    model?: string | null;
    entryDate?: string | null;
    repairDate?: string | null;
    ageDays?: number | null;
    cost?: number | null;
    estimatedSale?: number | null;
    notes?: string | null;
    parts: Array<{
      id?: number | null;
      description?: string | null;
      chavePeca?: string | null;
      status?: PartStatus;
      cancel?: boolean;
    }>;
    finalize?: boolean;
    userId?: number | null;
  },
): { repairCase: RepairCase; parts: PartRequest[] } {
  db.exec("BEGIN");
  try {
    let rc: RepairCase;

    if (params.caseId) {
      rc = updateRepairCase(db, params.caseId, {
        brand: params.brand,
        model: params.model,
        entryDate: params.entryDate,
        repairDate: params.repairDate,
        ageDays: params.ageDays,
        cost: params.cost,
        estimatedSale: params.estimatedSale,
        notes: params.notes,
        updatedByUserId: params.userId ?? null,
      });
    } else {
      rc = createRepairCase(db, {
        imei: params.imei,
        os: params.os,
        brand: params.brand,
        model: params.model,
        entryDate: params.entryDate,
        repairDate: params.repairDate,
        repairDateSource: params.repairDate ? "MANUAL" : null,
        ageDays: params.ageDays,
        cost: params.cost,
        estimatedSale: params.estimatedSale,
        notes: params.notes,
        createdByUserId: params.userId ?? null,
      });
    }

    for (const p of params.parts) {
      if (p.id) {
        if (p.cancel) {
          cancelPart(db, p.id, params.userId ?? null);
        } else {
          updatePart(db, p.id, {
            description: p.description,
            chavePeca: p.chavePeca,
            status: p.status,
            updatedByUserId: params.userId ?? null,
          });
        }
      } else {
        addPart(db, rc.id, {
          description: p.description,
          chavePeca: p.chavePeca,
          status: p.status ?? "PEDIR_PECA",
          createdByUserId: params.userId ?? null,
        });
      }
    }

    if (params.finalize) {
      rc = completeAnalysis(db, rc.id, params.userId ?? null);
    }

    const finalParts = getPartsByCase(db, rc.id);
    db.exec("COMMIT");
    return { repairCase: rc, parts: finalParts };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function closeRepairCase(
  db: Db,
  id: number,
  params: { status: "CONCLUIDO" | "VENDA_ESTADO" | "CANCELADO"; userId: number | null },
): RepairCase {
  const rc = getRepairCaseById(db, id);
  if (!rc) throw new RepairError("NOT_FOUND", "Caso não encontrado.");
  if (TERMINAL_WORKFLOW_STATUSES.includes(rc.workflowStatus)) {
    throw new RepairError("ALREADY_CLOSED", "Caso já encerrado.");
  }
  db.prepare(
    `UPDATE repair_cases SET workflow_status = ?, closed_at = datetime('now'), updated_by_user_id = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(params.status, params.userId ?? null, id);

  db.prepare(
    `UPDATE repair_case_priorities SET active = 0, removed_at = datetime('now'), removal_reason = 'Caso encerrado automaticamente' WHERE repair_case_id = ? AND active = 1`,
  ).run(id);
  db.prepare("UPDATE repair_cases SET manual_priority_active = 0 WHERE id = ?").run(id);

  return getRepairCaseById(db, id)!;
}

// ---------------------------------------------------------------------------
// Part requests
// ---------------------------------------------------------------------------

export function getPartsByCase(db: Db, repairCaseId: number): PartRequest[] {
  const rows = db
    .prepare("SELECT * FROM part_requests WHERE repair_case_id = ? AND cancelled_at IS NULL ORDER BY created_at")
    .all(repairCaseId) as unknown as PartRequestRow[];
  return rows.map(toPartRequest);
}

export function getAllPartsByCase(db: Db, repairCaseId: number): PartRequest[] {
  const rows = db
    .prepare("SELECT * FROM part_requests WHERE repair_case_id = ? ORDER BY created_at")
    .all(repairCaseId) as unknown as PartRequestRow[];
  return rows.map(toPartRequest);
}

export function getPartById(db: Db, id: number): PartRequest | null {
  const row = db.prepare("SELECT * FROM part_requests WHERE id = ?").get(id) as PartRequestRow | undefined;
  return row ? toPartRequest(row) : null;
}

export function addPart(
  db: Db,
  repairCaseId: number,
  params: {
    description?: string | null;
    chavePeca?: string | null;
    status?: PartStatus;
    createdByUserId?: number | null;
    sourceOrderPartId?: number | null;
    legacyIdPedido?: string | null;
    legacyStatus?: string | null;
    legacyKitStatus?: string | null;
    analysisCompleteAtCreation?: boolean;
  },
): PartRequest {
  const rc = getRepairCaseById(db, repairCaseId);
  if (!rc) throw new RepairError("NOT_FOUND", "Caso não encontrado.");

  const chavePecaNorm = params.chavePeca ? normalizeText(params.chavePeca) : null;
  const res = db
    .prepare(
      `INSERT INTO part_requests
         (repair_case_id, description, chave_peca, chave_peca_norm, status,
          source_order_part_id, legacy_id_pedido, legacy_status, legacy_kit_status,
          analysis_complete_at_creation, created_by_user_id, updated_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      repairCaseId,
      params.description ?? null,
      params.chavePeca ?? null,
      chavePecaNorm,
      params.status ?? "PEDIR_PECA",
      params.sourceOrderPartId ?? null,
      params.legacyIdPedido ?? null,
      params.legacyStatus ?? null,
      params.legacyKitStatus ?? null,
      params.analysisCompleteAtCreation ? 1 : 0,
      params.createdByUserId ?? null,
      params.createdByUserId ?? null,
    );
  return getPartById(db, res.lastInsertRowid as number)!;
}

export function updatePart(
  db: Db,
  partId: number,
  params: { description?: string | null; chavePeca?: string | null; status?: PartStatus; updatedByUserId?: number | null },
): PartRequest {
  const part = getPartById(db, partId);
  if (!part) throw new RepairError("NOT_FOUND", "Peça não encontrada.");
  if (part.status === "CANCELADA") throw new RepairError("PART_CANCELLED", "Peça cancelada não pode ser editada.");

  const chavePecaNorm = params.chavePeca !== undefined
    ? (params.chavePeca ? normalizeText(params.chavePeca) : null)
    : undefined;

  db.prepare(
    `UPDATE part_requests SET
       description = COALESCE(?, description),
       chave_peca = COALESCE(?, chave_peca),
       chave_peca_norm = COALESCE(?, chave_peca_norm),
       status = COALESCE(?, status),
       updated_by_user_id = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    params.description ?? null,
    params.chavePeca ?? null,
    chavePecaNorm ?? null,
    params.status ?? null,
    params.updatedByUserId ?? null,
    partId,
  );
  return getPartById(db, partId)!;
}

export function cancelPart(db: Db, partId: number, userId: number | null): PartRequest {
  const part = getPartById(db, partId);
  if (!part) throw new RepairError("NOT_FOUND", "Peça não encontrada.");
  if (part.status === "CANCELADA") return part;
  db.prepare(
    "UPDATE part_requests SET status = 'CANCELADA', cancelled_at = datetime('now'), updated_by_user_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(userId ?? null, partId);
  return getPartById(db, partId)!;
}

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------

export function setManualPriority(
  db: Db,
  repairCaseId: number,
  params: { reason: string; userId: number | null },
): Priority {
  const rc = getRepairCaseById(db, repairCaseId);
  if (!rc) throw new RepairError("NOT_FOUND", "Caso não encontrado.");
  if (params.reason.trim().length < 10) throw new RepairError("REASON_TOO_SHORT", "Justificativa deve ter pelo menos 10 caracteres.");
  if (rc.manualPriorityActive) throw new RepairError("ALREADY_PRIORITY", "Já existe uma prioridade ativa.");

  const res = db
    .prepare("INSERT INTO repair_case_priorities (repair_case_id, reason, created_by_user_id) VALUES (?,?,?)")
    .run(repairCaseId, params.reason.trim(), params.userId ?? null);
  db.prepare("UPDATE repair_cases SET manual_priority_active = 1 WHERE id = ?").run(repairCaseId);
  return getPriorityById(db, res.lastInsertRowid as number)!;
}

export function removeManualPriority(
  db: Db,
  repairCaseId: number,
  params: { reason?: string; userId: number | null },
): void {
  const rc = getRepairCaseById(db, repairCaseId);
  if (!rc) throw new RepairError("NOT_FOUND", "Caso não encontrado.");
  if (!rc.manualPriorityActive) throw new RepairError("NO_PRIORITY", "Nenhuma prioridade ativa.");
  db.prepare(
    `UPDATE repair_case_priorities SET active = 0, removed_at = datetime('now'), removed_by_user_id = ?, removal_reason = ? WHERE repair_case_id = ? AND active = 1`,
  ).run(params.userId ?? null, params.reason ?? null, repairCaseId);
  db.prepare("UPDATE repair_cases SET manual_priority_active = 0 WHERE id = ?").run(repairCaseId);
}

function getPriorityById(db: Db, id: number): Priority | null {
  const row = db.prepare("SELECT * FROM repair_case_priorities WHERE id = ?").get(id) as PriorityRow | undefined;
  return row ? toPriority(row) : null;
}

export function getPrioritiesByCase(db: Db, repairCaseId: number): Priority[] {
  const rows = db
    .prepare("SELECT * FROM repair_case_priorities WHERE repair_case_id = ? ORDER BY created_at DESC")
    .all(repairCaseId) as unknown as PriorityRow[];
  return rows.map(toPriority);
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface RepairCaseRow {
  id: number; imei: string | null; imei_norm: string | null; os: string | null; os_norm: string | null;
  brand: string | null; model: string | null; capacity: string | null; color: string | null; entry_date: string | null;
  directed_technician_id: number | null; directed_at: string | null; directed_by_user_id: number | null;
  repair_date: string | null; repair_date_source: string | null;
  age_days: number | null; cost: number | null; estimated_sale: number | null; margin: number | null; notes: string | null;
  analysis_status: string; workflow_status: string; assigned_technician_id: number | null;
  manual_priority_active: number; legacy_import_batch_id: number | null;
  legacy_device_key: string | null; legacy_case_key: string | null;
  created_by_user_id: number | null; updated_by_user_id: number | null;
  created_at: string; updated_at: string; closed_at: string | null;
}

function toRepairCase(r: RepairCaseRow): RepairCase {
  return {
    id: r.id, imei: r.imei, imeiNorm: r.imei_norm, os: r.os, osNorm: r.os_norm,
    brand: r.brand, model: r.model, capacity: r.capacity ?? null, color: r.color ?? null, entryDate: r.entry_date,
    directedTechnicianId: r.directed_technician_id ?? null,
    directedAt: r.directed_at ?? null,
    directedByUserId: r.directed_by_user_id ?? null,
    repairDate: r.repair_date, repairDateSource: r.repair_date_source,
    ageDays: r.age_days, cost: r.cost, estimatedSale: r.estimated_sale, margin: r.margin, notes: r.notes,
    analysisStatus: r.analysis_status as AnalysisStatus,
    workflowStatus: r.workflow_status as WorkflowStatus,
    assignedTechnicianId: r.assigned_technician_id,
    manualPriorityActive: r.manual_priority_active === 1,
    legacyImportBatchId: r.legacy_import_batch_id,
    legacyDeviceKey: r.legacy_device_key,
    legacyCaseKey: r.legacy_case_key,
    createdByUserId: r.created_by_user_id, updatedByUserId: r.updated_by_user_id,
    createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
  };
}

interface PartRequestRow {
  id: number; repair_case_id: number; description: string | null;
  chave_peca: string | null; chave_peca_norm: string | null; status: string;
  purchase_status: string | null; allocated_reference: string | null; allocated_reference_norm: string | null;
  analysis_complete_at_creation: number; manual_override: number; manual_override_reason: string | null;
  source_order_part_id: number | null; legacy_id_pedido: string | null;
  legacy_status: string | null; legacy_kit_status: string | null;
  created_by_user_id: number | null; updated_by_user_id: number | null;
  created_at: string; updated_at: string; cancelled_at: string | null;
}

function toPartRequest(r: PartRequestRow): PartRequest {
  return {
    id: r.id, repairCaseId: r.repair_case_id, description: r.description,
    chavePeca: r.chave_peca, chavePecaNorm: r.chave_peca_norm,
    status: r.status as PartStatus, purchaseStatus: r.purchase_status,
    allocatedReference: r.allocated_reference, allocatedReferenceNorm: r.allocated_reference_norm,
    analysisCompleteAtCreation: r.analysis_complete_at_creation === 1,
    manualOverride: r.manual_override === 1, manualOverrideReason: r.manual_override_reason,
    sourceOrderPartId: r.source_order_part_id, legacyIdPedido: r.legacy_id_pedido,
    legacyStatus: r.legacy_status, legacyKitStatus: r.legacy_kit_status,
    createdByUserId: r.created_by_user_id, updatedByUserId: r.updated_by_user_id,
    createdAt: r.created_at, updatedAt: r.updated_at, cancelledAt: r.cancelled_at,
  };
}

interface PriorityRow {
  id: number; repair_case_id: number; active: number; reason: string;
  created_by_user_id: number | null; created_at: string;
  removed_by_user_id: number | null; removed_at: string | null; removal_reason: string | null;
}

function toPriority(r: PriorityRow): Priority {
  return {
    id: r.id, repairCaseId: r.repair_case_id, active: r.active === 1, reason: r.reason,
    createdByUserId: r.created_by_user_id, createdAt: r.created_at,
    removedByUserId: r.removed_by_user_id, removedAt: r.removed_at, removalReason: r.removal_reason,
  };
}

// ─── CHAVEPECA autocomplete ───────────────────────────────────────────────

export interface ChavePecaSuggestion {
  chavePeca: string;
  /** Quantity available in current operational stock (null = not found in stock) */
  stockAvailable: number | null;
}

/**
 * Returns distinct CHAVEPECA values matching the query prefix (case-insensitive),
 * ordered by usage frequency then alphabetically. Searches part_requests first,
 * then fills from source_order_parts (legacy).
 */
export function searchChavePeca(db: Db, q: string, limit = 15): ChavePecaSuggestion[] {
  if (!q || q.trim().length < 1) return [];
  const qNorm = normalizeText(q.trim());

  const rows = db.prepare(`
    SELECT chave_peca_norm, chave_peca, COUNT(*) AS freq
    FROM (
      SELECT chave_peca_norm, chave_peca
      FROM   part_requests
      WHERE  chave_peca_norm LIKE ? AND chave_peca_norm IS NOT NULL AND cancelled_at IS NULL
      UNION ALL
      SELECT chave_peca_norm, chave_peca
      FROM   source_order_parts
      WHERE  chave_peca_norm LIKE ? AND chave_peca_norm IS NOT NULL
    )
    GROUP BY chave_peca_norm
    ORDER BY freq DESC, chave_peca_norm ASC
    LIMIT ?
  `).all(`${qNorm}%`, `${qNorm}%`, limit) as Array<{ chave_peca_norm: string; chave_peca: string; freq: number }>;

  if (rows.length === 0) return [];

  const norms = rows.map((r) => r.chave_peca_norm);
  const placeholders = norms.map(() => "?").join(",");
  const stockRows = db.prepare(`
    SELECT ssi.chave_peca_norm, SUM(ssi.counted_quantity) AS qty
    FROM   stock_snapshot_items ssi
    JOIN   stock_snapshots ss ON ss.id = ssi.snapshot_id
    WHERE  ss.status = 'OFFICIAL'
      AND  ssi.chave_peca_norm IN (${placeholders})
    GROUP  BY ssi.chave_peca_norm
  `).all(...norms) as Array<{ chave_peca_norm: string; qty: number }>;

  const stockMap = new Map(stockRows.map((r) => [r.chave_peca_norm, r.qty]));

  return rows.map((r) => ({
    chavePeca: r.chave_peca,
    stockAvailable: stockMap.has(r.chave_peca_norm) ? (stockMap.get(r.chave_peca_norm) ?? 0) : null,
  }));
}
