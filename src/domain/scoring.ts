/**
 * Motor de decisão (score de prioridade).
 *
 * As regras são CONFIGURÁVEIS: a política atual (1 ponto a cada 30 dias de
 * idade, teto de 15; 1 ponto a cada R$150 de margem; margem negativa pune)
 * é apenas o padrão. A operação pode alterar os parâmetros sem mudar código.
 *
 * Esta fase ainda não roda o motor de match/distribuição; o módulo já existe
 * e é testado para suportar essas regras sem reconstruir o projeto.
 */

export interface DecisionRuleConfig {
  /** Dias de idade necessários para somar 1 ponto (padrão 30). */
  ageDaysPerPoint: number;
  /** Teto da nota de idade (padrão 15). */
  ageMaxPoints: number;
  /** Valor de margem (R$) necessário para somar 1 ponto (padrão 150). */
  marginPerPoint: number;
  /** Se margem negativa pode gerar nota negativa (padrão true: pune). */
  marginAllowsNegative: boolean;
}

export const DEFAULT_DECISION_RULE: DecisionRuleConfig = {
  ageDaysPerPoint: 30,
  ageMaxPoints: 15,
  marginPerPoint: 150,
  marginAllowsNegative: true,
};

/** Equivalente ao INT() do Excel: arredonda em direção a -infinito. */
export function excelInt(value: number): number {
  return Math.floor(value);
}

/** MARGEM = VENDA - CUSTO. null quando qualquer um dos dois faltar. */
export function computeMargin(
  custo: number | null,
  venda: number | null,
): number | null {
  if (custo === null || custo === undefined) return null;
  if (venda === null || venda === undefined) return null;
  return venda - custo;
}

/** Nota de idade: floor(idade / passo), limitada a [0, teto]. */
export function notaIdade(
  idade: number | null,
  rule: DecisionRuleConfig = DEFAULT_DECISION_RULE,
): number {
  if (idade === null || idade === undefined || Number.isNaN(idade)) return 0;
  const raw = excelInt(idade / rule.ageDaysPerPoint);
  if (raw < 0) return 0;
  return Math.min(raw, rule.ageMaxPoints);
}

/** Nota de margem: INT(margem / passo). Margem negativa pune (configurável). */
export function notaMargem(
  margem: number | null,
  rule: DecisionRuleConfig = DEFAULT_DECISION_RULE,
): number {
  if (margem === null || margem === undefined || Number.isNaN(margem)) return 0;
  const raw = excelInt(margem / rule.marginPerPoint);
  if (!rule.marginAllowsNegative && raw < 0) return 0;
  return raw;
}

export interface ScoreInput {
  idade: number | null;
  custo: number | null;
  venda: number | null;
  /** Quando a margem já vem calculada da planilha, pode ser passada direto. */
  margem?: number | null;
}

export interface ScoreOutput {
  margem: number | null;
  notaIdade: number;
  notaMargem: number;
  score: number;
  /** Avisos não fatais (ex.: margem indisponível). */
  warnings: string[];
}

/** Calcula o score completo a partir das regras vigentes. */
export function computeScore(
  input: ScoreInput,
  rule: DecisionRuleConfig = DEFAULT_DECISION_RULE,
): ScoreOutput {
  const warnings: string[] = [];
  const margem =
    input.margem !== undefined && input.margem !== null
      ? input.margem
      : computeMargin(input.custo, input.venda);

  if (margem === null) {
    warnings.push("MARGEM_INDISPONIVEL");
  }

  const ni = notaIdade(input.idade, rule);
  const nm = notaMargem(margem, rule);
  return {
    margem,
    notaIdade: ni,
    notaMargem: nm,
    score: ni + nm,
    warnings,
  };
}

/** Item comparável na fila de prioridade dos aparelhos. */
export interface DevicePriorityItem {
  /** Quantidade total de peças necessárias para o aparelho. */
  totalParts: number;
  score: number;
  margem: number | null;
  /** ID estável (desempate determinístico). */
  stableId: string;
}

/**
 * Ordem de prioridade dos aparelhos:
 *   1. menor quantidade total de peças;
 *   2. maior score;
 *   3. maior margem;
 *   4. ID estável como desempate.
 */
export function comparePriority(
  a: DevicePriorityItem,
  b: DevicePriorityItem,
): number {
  if (a.totalParts !== b.totalParts) return a.totalParts - b.totalParts;
  if (a.score !== b.score) return b.score - a.score;
  const ma = a.margem ?? Number.NEGATIVE_INFINITY;
  const mb = b.margem ?? Number.NEGATIVE_INFINITY;
  if (ma !== mb) return mb - ma;
  return a.stableId.localeCompare(b.stableId);
}
