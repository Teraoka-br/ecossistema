/**
 * Carregador de dados do motor de match.
 *
 * Única fonte de input para calculateMatch — usado tanto pelo motor real
 * (engine-orchestrator) quanto pelo simulador (simulate-service). Somente
 * LEITURA: nunca escreve no banco.
 *
 * Regras de carregamento de peças (correção de auditoria 2025-07):
 *   - Peças CANCELADAS (cancelled_at IS NOT NULL) são sempre excluídas.
 *   - Peças AVANÇADAS (SEPARADA | RESERVADA | CONSUMIDA) são registradas mas
 *     nunca entram na disputa — o motor não pode regredí-las.
 *   - Caso com TODAS as peças avançadas: protegido, não entra no motor.
 *   - Caso com peças avançadas + abertas: só as abertas participam da disputa.
 *   - PECA_NECESSARIA_AUSENTE é emitido somente quando não há nenhuma peça
 *     aberta real (partes.length === 0 no input do motor).
 */

import type { Db } from "../db/database.js";
import { getCurrentOperationalStock } from "../operational/stock-service.js";
import { calculateRepairPartsCost } from "../operational/repair-parts-cost-service.js";
import type {
  ActiveRule,
  CalculateMatchInput,
  MatchCaseInput,
  MatchPartInput,
  StockGroupInput,
  CompatibilityGroup,
  CompatibilityInput,
} from "./calculate-match.js";
import { validateActiveRule } from "./match-rule-service.js";

export class MatchRuleStateError extends Error {
  constructor(
    public readonly code: "NO_ACTIVE_RULE" | "MULTIPLE_ACTIVE_RULES" | "INVALID_RULE_PARAMS",
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

/** Status de peça que indica fluxo avançado (já encaminhada ou consumida). */
const ADVANCED_PART_STATUSES = ["SEPARADA", "RESERVADA", "CONSUMIDA"] as const;
type AdvancedPartStatus = (typeof ADVANCED_PART_STATUSES)[number];

function isAdvanced(status: string): status is AdvancedPartStatus {
  return (ADVANCED_PART_STATUSES as readonly string[]).includes(status);
}

/**
 * Regra ativa ESTRITA: exatamente uma. Zero ou mais de uma regra ativa
 * aborta o motor sem alterar cards (erro administrativo explícito).
 * Também valida os parâmetros numéricos da regra antes de retornar.
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
  const rule: ActiveRule = {
    id: r.id as number,
    version: r.version as number,
    name: (r.name as string | null) ?? null,
    marginAmountPerPoint: r.margin_amount_per_point as number,
    ageDaysPerPoint: r.age_days_per_point as number,
    ageMaxPoints: r.age_max_points as number,
    allowNegativeMarginScore: (r.allow_negative_margin_score as number) === 1,
    marginWeight: r.margin_weight as number,
    ageWeight: r.age_weight as number,
    manualPriorityEnabled: (r.manual_priority_enabled as number | undefined ?? 0) === 1,
    includePartsCost: (r.include_parts_cost as number | undefined ?? 0) === 1,
    shadowMode: (r.shadow_mode as number | undefined ?? 1) === 1,
    minPartsCostCoverage: (r.min_parts_cost_coverage as number | undefined) ?? 0,
    missingCostBehavior: (r.missing_cost_behavior as string | undefined ?? "USE_LEGACY_MARGIN") as "USE_LEGACY_MARGIN" | "SEND_TO_VERIFY" | "EXCLUDE",
  };

  // Valida parâmetros — regra corrompida aborta o motor como erro de configuração.
  const paramError = validateActiveRule(rule);
  if (paramError) {
    throw new MatchRuleStateError(
      "INVALID_RULE_PARAMS",
      `Regra ativa (id=${rule.id}) possui parâmetros inválidos: ${paramError}`,
    );
  }

  return rule;
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

/** Caso protegido: todas as peças em status avançado — motor não avalia nem altera. */
export interface AdvancedOnlyCase {
  caseId: number;
  workflowStatus: string;
  /** Se o workflow_status é incompatível com o estado avançado das peças. */
  workflowInconsistent: boolean;
  advancedParts: Array<{ partRequestId: number; status: AdvancedPartStatus }>;
}

export interface LoadedEngineInput extends CalculateMatchInput {
  /** part_request_id → status atual (para a camada de persistência). */
  partStatusById: Map<number, string>;
  /** case_id → workflow_status atual (para a camada de persistência). */
  workflowByCase: Map<number, string>;
  /** part_request_id com pedido de compra ativo aguardando chegada. */
  activeOrderPartIds: Set<number>;
  /**
   * Casos com TODAS as peças em status avançado (SEPARADA/RESERVADA/CONSUMIDA).
   * O motor os protege: não altera workflow, apenas registra o diagnóstico.
   */
  advancedOnlyCases: AdvancedOnlyCase[];
}

/**
 * Carrega todos os cards operacionais elegíveis para avaliação (análise
 * COMPLETED e fora dos estados travados), suas peças abertas, o estoque
 * disponível atual e os grupos de compatibilidade.
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

  // Carrega TODAS as peças não canceladas (incluindo SEPARADA/RESERVADA/CONSUMIDA)
  // para detectar casos com status avançado.
  const allPartsByCase = new Map<number, PartRow[]>();
  if (caseRows.length > 0) {
    const caseIds = caseRows.map((c) => c.id);
    const placeholders = caseIds.map(() => "?").join(",");
    const allPartRows = db
      .prepare(
        `SELECT id, repair_case_id, chave_peca, chave_peca_norm, status
         FROM part_requests
         WHERE repair_case_id IN (${placeholders})
           AND cancelled_at IS NULL
         ORDER BY id`,
      )
      .all(...caseIds) as unknown as PartRow[];

    for (const p of allPartRows) {
      // Registra status de TODAS as peças abertas (não canceladas, não avançadas)
      // para que persistDecisions possa atualizar somente as abertas.
      if (!isAdvanced(p.status)) {
        partStatusById.set(p.id, p.status);
      }
      const arr = allPartsByCase.get(p.repair_case_id) ?? [];
      arr.push(p);
      allPartsByCase.set(p.repair_case_id, arr);
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

  const cases: MatchCaseInput[] = [];
  const advancedOnlyCases: AdvancedOnlyCase[] = [];

  for (const c of caseRows) {
    workflowByCase.set(c.id, c.workflow_status);

    const allParts = allPartsByCase.get(c.id) ?? [];
    const advancedParts = allParts.filter((p) => isAdvanced(p.status));
    const openParts = allParts.filter((p) => !isAdvanced(p.status));

    if (advancedParts.length > 0 && openParts.length === 0) {
      // Todas as peças avançadas — caso protegido, fora do motor.
      const lockedWorkflowStatuses = new Set<string>(ENGINE_LOCKED_STATUSES);
      // Workflows esperados quando partes estão avançadas:
      const expectedAdvancedWorkflows = new Set([
        "APTO_REPARO", "EM_SEPARACAO", "DIRECIONADO_TECNICO",
        "EM_REPARO", "REPARO_EXECUTADO",
      ]);
      advancedOnlyCases.push({
        caseId: c.id,
        workflowStatus: c.workflow_status,
        workflowInconsistent:
          !lockedWorkflowStatuses.has(c.workflow_status) &&
          !expectedAdvancedWorkflows.has(c.workflow_status),
        advancedParts: advancedParts.map((p) => ({
          partRequestId: p.id,
          status: p.status as AdvancedPartStatus,
        })),
      });
      continue;
    }

    // Caso normal (sem peças avançadas) ou misto (avançadas + abertas):
    // só as peças ABERTAS participam da disputa.
    const partsForMotor: MatchPartInput[] = openParts.map((p) => ({
      partRequestId: p.id,
      chavePeca: p.chave_peca,
      chavePecaNorm: p.chave_peca_norm && p.chave_peca_norm !== "" ? p.chave_peca_norm : null,
      hasActiveOrder: activeOrderPartIds.has(p.id),
    }));

    cases.push({
      caseId: c.id,
      imei: c.imei,
      model: c.model,
      cost: c.cost,
      estimatedSale: c.estimated_sale,
      ageDays: c.age_days,
      depositoAtual: c.deposito_atual,
      workflowStatus: c.workflow_status,
      manualPriority: c.manual_priority_active === 1,
      parts: partsForMotor,
    });
  }

  // ── Estoque disponível (físico − reservado − bloqueado) ──────────────────
  const { groups: stockGroups } = getCurrentOperationalStock(db);
  const availableStock: StockGroupInput[] = [];
  const refNormToStockChaves = new Map<string, Set<string>>();
  for (const g of stockGroups) {
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
  // Catálogo: chave solicitada → chaves de estoque possíveis, via referência física.
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

  // Grupos de compatibilidade simétrica (migration 039).
  const compatGroups: CompatibilityGroup[] = [];
  try {
    const groupRows = db
      .prepare("SELECT id, name FROM part_compatibility_groups ORDER BY id")
      .all() as { id: number; name: string | null }[];
    for (const g of groupRows) {
      const memberRows = db
        .prepare(
          `SELECT chave_peca_norm FROM part_compatibility_group_members
           WHERE group_id = ? AND removed_at IS NULL ORDER BY added_at`,
        )
        .all(g.id) as { chave_peca_norm: string }[];
      if (memberRows.length >= 2) {
        compatGroups.push({
          groupId: g.id,
          members: memberRows.map((m) => m.chave_peca_norm),
        });
      }
    }
  } catch {
    /* tabela pode não existir em banco legado anterior à migration 039 */
  }

  // Aliases manuais (part_key_aliases): vínculos explícitos requested → stock.
  // O campo stock_chave_peca_norm pode conter um chave_peca_norm direto OU uma
  // referencia_norm (ex.: "PC-QA15247"). Neste segundo caso resolvemos via
  // refNormToStockChaves — se a referência for unívoca (1 chave), usamos essa chave.
  const stockChaveNorms = new Set(availableStock.map((g) => g.chavePecaNorm));
  const aliases = new Map<string, string>();
  try {
    const aliasRows = db
      .prepare(
        `SELECT requested_chave_peca_norm, stock_chave_peca_norm
         FROM part_key_aliases WHERE active = 1`,
      )
      .all() as { requested_chave_peca_norm: string; stock_chave_peca_norm: string }[];
    for (const a of aliasRows) {
      if (!a.requested_chave_peca_norm || !a.stock_chave_peca_norm) continue;
      let target = a.stock_chave_peca_norm;
      if (!stockChaveNorms.has(target)) {
        // Tenta interpretar como referencia_norm e resolver para chave_peca_norm.
        const chavesViaRef = refNormToStockChaves.get(target);
        if (chavesViaRef && chavesViaRef.size === 1) {
          target = [...chavesViaRef][0];
        }
        // Se referência não existir ou for ambígua, mantém o valor original —
        // resolveKey tentará contra stockKeys e falhará graciosamente.
      }
      aliases.set(a.requested_chave_peca_norm, target);
    }
  } catch {
    /* tabela pode não existir em banco legado anterior à migration 036 */
  }

  const compatibility: CompatibilityInput = { groups: compatGroups, aliases, catalog };

  // Carregar custo de peças quando includePartsCost está habilitado
  if (activeRule.includePartsCost) {
    for (const c of cases) {
      const costResult = calculateRepairPartsCost(db, c.caseId);
      c.partsCost = costResult.totalPartsCost > 0 ? costResult.totalPartsCost : null;
      c.partsCostCoverage = costResult.coveragePercentage;
      c.partsCostConfidence = costResult.overallConfidence;
    }
  }

  return {
    cases,
    availableStock,
    activeRule,
    compatibility,
    partStatusById,
    workflowByCase,
    activeOrderPartIds,
    advancedOnlyCases,
  };
}
