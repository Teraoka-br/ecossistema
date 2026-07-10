/**
 * Serviço transacional de análise de aparelho.
 *
 * Toda a lógica de criar/atualizar repair_case + reconciliar part_requests +
 * registrar evento fica aqui — o handler Express apenas valida entrada e chama.
 */

import type { Db } from "../db/database.js";
import { normalizeKey } from "../domain/text.js";
import { recordOperationalEvent } from "../operational/operational-event-service.js";

// Statuses that block edits from analysis (advanced in the flow)
export const LOCKED_PART_STATUSES = [
  "AGUARDANDO_RECEBIMENTO",
  "INDICADA",
  "RESERVADA",
  "SEPARADA",
  "CONSUMIDA",
  "CANCELADA",
] as const;

export type LockedPartStatus = (typeof LOCKED_PART_STATUSES)[number];

export interface PartPayload {
  pecaNome: string;
  incluirCor: boolean;
  corUsada: string;
  chavePeca: string;
}

export interface AnaliseInput {
  userId: number | null;
  userRole: "ADMIN" | "OPERATOR";
  responsibleName: string | null;
  existingCaseId?: number | null;
  imei?: string | null;
  os?: string | null;
  brand?: string | null;
  model?: string | null;
  color?: string | null;
  ageDays?: number | null;
  cost?: number | null;
  estimatedSale?: number | null;
  problema?: string | null;
  notes?: string | null;
  fieldOrigins?: Record<string, string> | null;
  parts: PartPayload[];
  /** true = COMPLETED + motor trigger; false = DRAFT save only */
  finalize: boolean;
}

export class AnaliseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 422,
  ) {
    super(message);
    this.name = "AnaliseError";
  }
}

function isLocked(status: string): boolean {
  return (LOCKED_PART_STATUSES as readonly string[]).includes(status);
}

type PartRow = {
  id: number;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  status: string;
  peca_nome: string | null;
  incluir_cor: number;
  cor_usada: string | null;
  description: string | null;
};

/**
 * Executa em transação única: cria ou atualiza repair_case,
 * reconcilia part_requests (sem duplicar, sem tocar peças avançadas),
 * grava evento operacional, e retorna a linha do caso.
 *
 * Não dispara o motor — o caller faz isso após o COMMIT.
 */
export function saveAnalysis(db: Db, input: AnaliseInput): Record<string, unknown> {
  const { userId, userRole, responsibleName, existingCaseId, finalize } = input;

  const imeiNorm = input.imei ? input.imei.replace(/\D/g, "").trim() : null;
  const osNorm = input.os ? input.os.replace(/\D/g, "").trim() : null;
  const margin =
    input.cost != null && input.estimatedSale != null
      ? input.estimatedSale - input.cost
      : null;
  const fieldOriginsJson = input.fieldOrigins ? JSON.stringify(input.fieldOrigins) : null;

  db.exec("BEGIN");
  try {
    let caseId: number;
    let previousStatus: string | null = null;
    let wasCompleted = false;
    let isNewCase = false;

    // ------------------------------------------------------------------
    // 1. Criar ou atualizar repair_case
    // ------------------------------------------------------------------
    if (existingCaseId) {
      const existing = db
        .prepare(
          "SELECT id, analysis_status, workflow_status, created_by_user_id FROM repair_cases WHERE id = ?",
        )
        .get(existingCaseId) as {
          id: number;
          analysis_status: string;
          workflow_status: string;
          created_by_user_id: number | null;
        } | undefined;

      if (!existing) {
        throw new AnaliseError("NOT_FOUND", "Caso não encontrado.", 404);
      }

      // Autorização: ADMIN edita tudo; OPERATOR edita somente o próprio
      if (userRole !== "ADMIN" && existing.created_by_user_id !== userId) {
        throw new AnaliseError(
          "FORBIDDEN",
          "Sem permissão para editar este caso.",
          403,
        );
      }

      previousStatus = existing.workflow_status;
      wasCompleted = existing.analysis_status === "COMPLETED";

      db.prepare(
        `UPDATE repair_cases SET
           imei=?, imei_norm=?, os=?, os_norm=?,
           brand=?, model=?, color=?, age_days=?,
           cost=?, estimated_sale=?, margin=?,
           problema=?, notes=?,
           updated_by_user_id=?, updated_at=datetime('now')
         WHERE id=?`,
      ).run(
        input.imei ?? null,
        imeiNorm,
        input.os ?? null,
        osNorm,
        input.brand ?? null,
        input.model ?? null,
        input.color ?? null,
        input.ageDays ?? null,
        input.cost ?? null,
        input.estimatedSale ?? null,
        margin,
        input.problema ?? null,
        input.notes ?? null,
        userId,
        existingCaseId,
      );
      caseId = existingCaseId;
    } else {
      isNewCase = true;
      const r = db
        .prepare(
          `INSERT INTO repair_cases
             (imei, imei_norm, os, os_norm, brand, model, color, age_days,
              cost, estimated_sale, margin, problema, notes,
              analysis_status, workflow_status, created_by_user_id, updated_by_user_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT','EM_ANALISE',?,?)`,
        )
        .run(
          input.imei ?? null,
          imeiNorm,
          input.os ?? null,
          osNorm,
          input.brand ?? null,
          input.model ?? null,
          input.color ?? null,
          input.ageDays ?? null,
          input.cost ?? null,
          input.estimatedSale ?? null,
          margin,
          input.problema ?? null,
          input.notes ?? null,
          userId,
          userId,
        );
      caseId = Number(r.lastInsertRowid);
    }

    // ------------------------------------------------------------------
    // 2. Reconciliar part_requests
    // ------------------------------------------------------------------
    const existingParts = db
      .prepare(
        `SELECT id, chave_peca, chave_peca_norm, status,
                peca_nome, incluir_cor, cor_usada, description
         FROM part_requests
         WHERE repair_case_id = ? AND cancelled_at IS NULL`,
      )
      .all(caseId) as PartRow[];

    const lockedByNorm = new Map<string, PartRow>();
    const editableByNorm = new Map<string, PartRow>();

    for (const ep of existingParts) {
      const norm = ep.chave_peca_norm;
      if (!norm) continue;
      if (isLocked(ep.status)) {
        lockedByNorm.set(norm, ep);
      } else {
        editableByNorm.set(norm, ep);
      }
    }

    const insertPart = db.prepare(
      `INSERT INTO part_requests
         (repair_case_id, description, chave_peca, chave_peca_norm,
          peca_nome, incluir_cor, cor_usada, field_origins_json,
          status, analysis_complete_at_creation, created_by_user_id, updated_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    const updateEditablePart = db.prepare(
      `UPDATE part_requests SET
         description=?, chave_peca=?, chave_peca_norm=?,
         peca_nome=?, incluir_cor=?, cor_usada=?, field_origins_json=?,
         updated_by_user_id=?, updated_at=datetime('now')
       WHERE id=?`,
    );

    const seenEditableNorms = new Set<string>();

    for (const p of input.parts) {
      const chaveNorm = normalizeKey(p.chavePeca);
      if (!chaveNorm) continue;

      if (lockedByNorm.has(chaveNorm)) {
        // Peça avançada no fluxo — não duplicar, não alterar (no-op)
        continue;
      }

      if (editableByNorm.has(chaveNorm)) {
        // Atualizar peça editável existente (idempotente)
        const ep = editableByNorm.get(chaveNorm)!;
        seenEditableNorms.add(chaveNorm);
        updateEditablePart.run(
          p.pecaNome || p.chavePeca,
          p.chavePeca,
          chaveNorm,
          p.pecaNome || null,
          p.incluirCor ? 1 : 0,
          p.corUsada || null,
          fieldOriginsJson,
          userId,
          ep.id,
        );
      } else {
        // Inserir nova peça
        seenEditableNorms.add(chaveNorm);
        insertPart.run(
          caseId,
          p.pecaNome || p.chavePeca,
          p.chavePeca,
          chaveNorm,
          p.pecaNome || null,
          p.incluirCor ? 1 : 0,
          p.corUsada || null,
          fieldOriginsJson,
          "PEDIR_PECA",
          finalize ? 1 : 0,
          userId,
          userId,
        );
      }
    }

    // Cancelar peças editáveis que não vieram no payload
    for (const [norm, ep] of editableByNorm) {
      if (!seenEditableNorms.has(norm)) {
        db.prepare(
          `UPDATE part_requests SET
             status='CANCELADA', cancelled_at=datetime('now'),
             updated_by_user_id=?, updated_at=datetime('now')
           WHERE id=?`,
        ).run(userId, ep.id);
      }
    }

    // ------------------------------------------------------------------
    // 3. Atualizar status do caso e gravar evento
    // ------------------------------------------------------------------
    if (finalize) {
      const { c: activeCount } = db
        .prepare(
          "SELECT COUNT(*) as c FROM part_requests WHERE repair_case_id=? AND cancelled_at IS NULL",
        )
        .get(caseId) as { c: number };

      if (activeCount === 0) {
        throw new AnaliseError(
          "NO_PARTS",
          "Ao menos uma peça ativa é necessária para finalizar a análise.",
          400,
        );
      }

      // Atualiza status (funciona tanto para DRAFT quanto para COMPLETED)
      db.prepare(
        `UPDATE repair_cases SET
           analysis_status='COMPLETED',
           workflow_status=CASE
             WHEN workflow_status IN ('EM_ANALISE','PEDIR_PECA') THEN 'PEDIR_PECA'
             ELSE workflow_status
           END,
           updated_at=datetime('now')
         WHERE id=?`,
      ).run(caseId);

      // Marca peças novas como criadas com análise completa
      db.prepare(
        `UPDATE part_requests SET analysis_complete_at_creation=1
         WHERE repair_case_id=? AND cancelled_at IS NULL AND analysis_complete_at_creation=0`,
      ).run(caseId);

      recordOperationalEvent(db, {
        repairCaseId: caseId,
        eventType: wasCompleted ? "ANALYSIS_UPDATED" : "ANALYSIS_COMPLETED",
        previousStatus,
        newStatus: "PEDIR_PECA",
        responsibleName,
      });
    } else if (isNewCase) {
      // Só registra evento de draft para casos novos (não a cada re-save)
      recordOperationalEvent(db, {
        repairCaseId: caseId,
        eventType: "ANALYSIS_DRAFT_SAVED",
        responsibleName,
      });
    }

    db.exec("COMMIT");

    return db
      .prepare("SELECT * FROM repair_cases WHERE id=?")
      .get(caseId) as Record<string, unknown>;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
