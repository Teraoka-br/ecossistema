/**
 * Carregador de dados do motor de match.
 *
 * Única fonte de input para calculateMatch — usado tanto pelo motor real
 * (engine-orchestrator) quanto pelo simulador (simulate-service). Somente
 * LEITURA: nunca escreve no banco.
 */

import type { Db } from "../db/database.js";
import { getCurrentOperationalStock } from "../operational/stock-service.js";
import type {
  ActiveRule,
  CalculateMatchInput,
  MatchCaseInput,
  MatchPartInput,
  StockGroupInput,
  CompatibilityInput,
} from "./calculate-match.js";

export class MatchRuleStateError extends Error {
  constructor(
    public readonly code: "NO_ACTIVE_RULE" | "MULTIPLE_ACTIVE_RULES",
    message: string,
  ) {
    super(message);
    this.name = "MatchRuleStateError";
  }
}

/**
 * Estados posteriores à distribuição de peças — o motor NUNCA os sobrescreve
 * e casos nesses estados nem são carregados para avaliação.
 */
export const ENGINE_LOCKED_STATUSES = [
  "APTO_REPARO",
  "EM_SEPARACAO",
  "DIRECIONADO_TECNICO",
  "EM_REPARO",
  "REPARO_EXECUTADO",
  "TRIAGEM_FINAL",
  "RETORNO_TECNICO",
  "CONCLUIDO",
  "VENDA_ESTADO",
  "CANCELADO",
] as const;

/**
 * Regra ativa ESTRITA: exatamente uma. Zero ou mais de uma regra ativa
 * aborta o motor sem alterar cards (erro administrativo explícito).
 */
export function loadActiveRuleStrict(db: Db): ActiveRule {
  const rows = db
    .prepare("SELECT * FROM match_rule_sets WHERE active = 1 ORDER BY id")
    .all() as Record<string, unknown>[];
  if (rows.length === 0) {
    throw new MatchRuleStateError(
      "NO_ACTIVE_RULE",
      "Nenhuma regra de match ativa. Ative uma regra em Regras do Match antes de executar o motor.",
    );
  }
  if (rows.length > 1) {
    throw new MatchRuleStateError(
      "MULTIPLE_ACTIVE_RULES",
      `Existem ${rows.length} regras de match ativas simultaneamente. Corrija a configuração: deve existir exatamente uma regra ativa.`,
    );
  }
  const r = rows[0];
  return {
    id: r.id as number,
    version: r.version as number,
    name: (r.name as string | null) ?? null,
    marginAmountPerPoint: r.margin_amount_per_point as number,
    ageDaysPerPoint: r.age_days_per_point as number,
    ageMaxPoints: r.age_max_points as number,
    allowNegativeMarginScore: (r.allow_negative_margin_score as number) === 1,
    marginWeight: r.margin_weight as number,
    ageWeight: r.age_weight as number,
  };
}

interface CaseRow {
  id: number;
  imei: string | null;
  model: string | null;
  cost: number | null;
  estimated_sale: number | null;
  age_days: number | null;
  deposito_atual: string | null;
  workflow_status: string;
  manual_priority_active: number;
}

interface PartRow {
  id: number;
  repair_case_id: number;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  status: string;
}

export interface LoadedEngineInput extends CalculateMatchInput {
  /** part_request_id → status atual (para a camada de persistência). */
  partStatusById: Map<number, string>;
  /** case_id → workflow_status atual (para a camada de persistência). */
  workflowByCase: Map<number, string>;
  /** part_request_id com pedido de compra ativo aguardando chegada. */
  activeOrderPartIds: Set<number>;
}

/**
 * Carrega todos os cards operacionais elegíveis para avaliação (análise
 * COMPLETED e fora dos estados travados), suas peças abertas, o estoque
 * disponível atual e as resoluções de compatibilidade.
 */
export function loadEngineInput(db: Db, activeRule: ActiveRule): LoadedEngineInput {
  const lockedList = ENGINE_LOCKED_STATUSES.map((s) => `'${s}'`).join(",");

  const caseRows = db
    .prepare(
      `SELECT id, imei, model, cost, estimated_sale, age_days, deposito_atual,
              workflow_status, manual_priority_active
       FROM repair_cases
       WHERE analysis_status = 'COMPLETED'
         AND workflow_status NOT IN (${lockedList})
       ORDER BY id`,
    )
    .all() as unknown as CaseRow[];

  const partStatusById = new Map<number, string>();
  const workflowByCase = new Map<number, string>();
  const partsByCase = new Map<number, PartRow[]>();

  if (caseRows.length > 0) {
    const caseIds = caseRows.map((c) => c.id);
    const placeholders = caseIds.map(() => "?").join(",");
    const partRows = db
      .prepare(
        `SELECT id, repair_case_id, chave_peca, chave_peca_norm, status
         FROM part_requests
         WHERE repair_case_id IN (${placeholders})
           AND cancelled_at IS NULL
           AND status NOT IN ('CANCELADA','SEPARADA','CONSUMIDA','RESERVADA')
         ORDER BY id`,
      )
      .all(...caseIds) as unknown as PartRow[];

    for (const p of partRows) {
      partStatusById.set(p.id, p.status);
      const arr = partsByCase.get(p.repair_case_id) ?? [];
      arr.push(p);
      partsByCase.set(p.repair_case_id, arr);
    }
  }

  // Peças com pedido de compra ativo aguardando chegada
  const activeOrderPartIds = new Set<number>(
    (
      db
        .prepare(
          `SELECT DISTINCT purch.part_request_id
           FROM purchase_requests purch
           JOIN purchase_order_items poi ON poi.purchase_request_id = purch.id
           JOIN purchase_orders po ON po.id = poi.purchase_order_id
           WHERE purch.part_request_id IS NOT NULL
             AND purch.status = 'ORDERED'
             AND po.status IN ('AWAITING_RECEIPT','PARTIALLY_RECEIVED')`,
        )
        .all() as Array<{ part_request_id: number }>
    ).map((r) => r.part_request_id),
  );

  const cases: MatchCaseInput[] = caseRows.map((c) => {
    workflowByCase.set(c.id, c.workflow_status);
    const parts: MatchPartInput[] = (partsByCase.get(c.id) ?? []).map((p) => ({
      partRequestId: p.id,
      chavePeca: p.chave_peca,
      chavePecaNorm: p.chave_peca_norm && p.chave_peca_norm !== "" ? p.chave_peca_norm : null,
      hasActiveOrder: activeOrderPartIds.has(p.id),
    }));
    return {
      caseId: c.id,
      imei: c.imei,
      model: c.model,
      cost: c.cost,
      estimatedSale: c.estimated_sale,
      ageDays: c.age_days,
      depositoAtual: c.deposito_atual,
      workflowStatus: c.workflow_status,
      manualPriority: c.manual_priority_active === 1,
      parts,
    };
  });

  // ── Estoque disponível (físico − reservado − bloqueado) ──────────────────
  const { groups } = getCurrentOperationalStock(db);
  const availableStock: StockGroupInput[] = [];
  const refNormToStockChaves = new Map<string, Set<string>>();
  for (const g of groups) {
    if (!g.chavePecaNorm || g.availableQuantity <= 0) continue;
    availableStock.push({
      chavePecaNorm: g.chavePecaNorm,
      referencia: g.referencia,
      referenciaNorm: g.referenciaNorm || "",
      availableQuantity: g.availableQuantity,
    });
    if (g.referenciaNorm) {
      let set = refNormToStockChaves.get(g.referenciaNorm);
      if (!set) {
        set = new Set();
        refNormToStockChaves.set(g.referenciaNorm, set);
      }
      set.add(g.chavePecaNorm);
    }
  }

  // ── Compatibilidade ──────────────────────────────────────────────────────
  // Catálogo: chave solicitada → chaves de estoque possíveis, via referência
  // física registrada no catálogo importado (source_inventory_items).
  const catalog = new Map<string, string[]>();
  const catalogRows = db
    .prepare(
      `SELECT DISTINCT chave_peca_norm, referencia_norm
       FROM source_inventory_items
       WHERE chave_peca_norm IS NOT NULL AND chave_peca_norm != ''
         AND referencia_norm IS NOT NULL AND referencia_norm != ''`,
    )
    .all() as { chave_peca_norm: string; referencia_norm: string }[];
  for (const r of catalogRows) {
    const targets = refNormToStockChaves.get(r.referencia_norm);
    if (!targets) continue;
    let arr = catalog.get(r.chave_peca_norm);
    if (!arr) {
      arr = [];
      catalog.set(r.chave_peca_norm, arr);
    }
    for (const t of targets) if (!arr.includes(t)) arr.push(t);
  }

  // Aliases manuais ativos (compatibilidade autorizada — prioridade máxima)
  const aliases = new Map<string, string>();
  try {
    const aliasRows = db
      .prepare(
        "SELECT requested_chave_peca_norm, stock_chave_peca_norm FROM part_key_aliases WHERE active = 1",
      )
      .all() as { requested_chave_peca_norm: string; stock_chave_peca_norm: string }[];
    for (const a of aliasRows) aliases.set(a.requested_chave_peca_norm, a.stock_chave_peca_norm);
  } catch {
    /* tabela pode não existir em banco antigo */
  }

  const compatibility: CompatibilityInput = { aliases, catalog };

  return {
    cases,
    availableStock,
    activeRule,
    compatibility,
    partStatusById,
    workflowByCase,
    activeOrderPartIds,
  };
}
