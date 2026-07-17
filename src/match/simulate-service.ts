/**
 * Simulação dry-run do motor de match.
 *
 * Usa EXATAMENTE a mesma função pura do motor real (calculateMatch) sobre o
 * mesmo carregador de dados (loadEngineInput). NÃO escreve no banco:
 *   - não cria repair_match_runs / repair_match_results;
 *   - não altera repair_cases nem part_requests;
 *   - não cria reservas, movimentações ou pedidos;
 *   - não muda a regra ativa.
 *
 * A simulação da regra ativa reproduz exatamente o resultado do motor real
 * para os mesmos dados de entrada (testado em match-simulate.test.ts).
 */

import type { Db } from "../db/database.js";
import { calculateMatch, type CalculateMatchOutput } from "./calculate-match.js";
import { loadActiveRuleStrict, loadEngineInput } from "./engine-loader.js";
import { getRuleSetById, toActiveRule } from "./match-rule-service.js";
import type { ActiveRule } from "./calculate-match.js";

export interface SimulateResult {
  ruleId: number;
  ruleVersion: number;
  casesEvaluated: number;
  fullKitsFound: number;
  partialKitsFound: number;
  pedirPecaCount: number;
  aguardandoCount: number;
  verificarCount: number;
  /** null quando compareWithActive=false ou não há regra ativa */
  changedComparedToActive: number | null;
  changedFullMatchMembership: number | null;
  changedPartialMembership: number | null;
  /** Cards que ENTRARIAM em MATCH com a regra simulada. */
  enteringMatch: number[];
  /** Cards que SAIRIAM de MATCH com a regra simulada. */
  leavingMatch: number[];
  /** Cards que mudariam de posição na disputa (sem mudar de status). */
  positionChanges: number;
  topChangedCases: Array<{
    caseId: number;
    prevStatusActive: string;
    newStatusSimulated: string;
    scoreActive: number | null;
    scoreSimulated: number | null;
  }>;
  /** Chaves de estoque mais disputadas (demanda > disponibilidade). */
  disputedKeys: Array<{ stockChaveNorm: string; demanded: number; available: number }>;
}

export async function simulateMatchRules(
  db: Db,
  opts: {
    ruleSetId?: number;
    compareWithActive?: boolean;
  },
): Promise<SimulateResult> {
  // Resolver regra a simular
  let rule: ActiveRule;
  if (opts.ruleSetId != null) {
    const r = getRuleSetById(db, opts.ruleSetId);
    if (!r) throw new Error("Regra não encontrada.");
    rule = toActiveRule(r);
  } else {
    rule = loadActiveRuleStrict(db);
  }

  // Mesmo carregador do motor real — somente leitura.
  const input = loadEngineInput(db, rule);
  const simulated: CalculateMatchOutput = calculateMatch({ ...input, activeRule: rule });

  const result: SimulateResult = {
    ruleId: rule.id,
    ruleVersion: rule.version,
    casesEvaluated: simulated.stats.casesEvaluated,
    fullKitsFound: simulated.stats.match,
    partialKitsFound: simulated.stats.matchParcial,
    pedirPecaCount: simulated.stats.pedirPeca,
    aguardandoCount: simulated.stats.aguardandoRecebimento,
    verificarCount: simulated.stats.verificar,
    changedComparedToActive: null,
    changedFullMatchMembership: null,
    changedPartialMembership: null,
    enteringMatch: [],
    leavingMatch: [],
    positionChanges: 0,
    topChangedCases: [],
    disputedKeys: simulated.disputedKeys.slice(0, 15),
  };

  if (opts.compareWithActive) {
    let activeRule: ActiveRule | null = null;
    try {
      activeRule = loadActiveRuleStrict(db);
    } catch {
      /* sem regra ativa — sem comparação */
    }

    if (activeRule) {
      const baseline =
        activeRule.id === rule.id
          ? simulated
          : calculateMatch({ ...input, activeRule });

      const baselineByCase = new Map(baseline.cases.map((c) => [c.caseId, c]));
      let changed = 0;
      let fullChanged = 0;
      let partialChanged = 0;
      let positionChanges = 0;

      for (const simCase of simulated.cases) {
        const baseCase = baselineByCase.get(simCase.caseId);
        if (!baseCase) continue;

        if (simCase.result !== baseCase.result) {
          changed++;
          if ((simCase.result === "MATCH") !== (baseCase.result === "MATCH")) {
            fullChanged++;
            if (simCase.result === "MATCH") result.enteringMatch.push(simCase.caseId);
            else if (baseCase.result === "MATCH") result.leavingMatch.push(simCase.caseId);
          }
          if ((simCase.result === "MATCH_PARCIAL") !== (baseCase.result === "MATCH_PARCIAL")) partialChanged++;

          if (result.topChangedCases.length < 10) {
            result.topChangedCases.push({
              caseId: simCase.caseId,
              prevStatusActive: baseCase.result,
              newStatusSimulated: simCase.result,
              scoreActive: baseCase.score,
              scoreSimulated: simCase.score,
            });
          }
        } else if (simCase.rank !== null && baseCase.rank !== null && simCase.rank !== baseCase.rank) {
          positionChanges++;
        }
      }

      result.changedComparedToActive = changed;
      result.changedFullMatchMembership = fullChanged;
      result.changedPartialMembership = partialChanged;
      result.positionChanges = positionChanges;
    }
  }

  return result;
}
