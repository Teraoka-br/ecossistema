/**
 * Fonte única dos agrupamentos de workflow_status.
 * Todos os serviços (dashboard, financeiro, fila, alertas) DEVEM importar daqui.
 * Nunca repita a lista de status em outro arquivo — qualquer mudança de nomenclatura
 * ou reagrupamento se propaga automaticamente.
 */

export const WF_MATCH          = ["MATCH"] as const;
export const WF_MATCH_PARCIAL  = ["MATCH_PARCIAL"] as const;
export const WF_APTO_REPARO    = ["APTO_REPARO", "EM_SEPARACAO"] as const;
export const WF_VERIFICAR      = ["VERIFICAR"] as const;
export const WF_EM_ANALISE     = ["EM_ANALISE"] as const;
export const WF_AGUARDANDO     = ["PEDIR_PECA", "AGUARDANDO_RECEBIMENTO"] as const;
export const WF_COM_TECNICO    = [
  "DIRECIONADO_TECNICO", "EM_REPARO",
  "REPARO_EXECUTADO", "TRIAGEM_FINAL", "RETORNO_TECNICO",
] as const;
export const WF_VENDA_ESTADO   = ["VENDA_ESTADO"] as const;
export const WF_FINALIZADOS    = ["CONCLUIDO", "CANCELADO"] as const;

/** Todos os status que NÃO são finais (ativos no laboratório). */
export const WF_ATIVOS = [
  ...WF_MATCH, ...WF_MATCH_PARCIAL, ...WF_APTO_REPARO,
  ...WF_VERIFICAR, ...WF_EM_ANALISE, ...WF_AGUARDANDO,
  ...WF_COM_TECNICO,
] as const;

/** Todos os status finais (encerrados — saíram do laboratório). */
export const WF_ENCERRADOS = [...WF_FINALIZADOS, ...WF_VENDA_ESTADO] as const;

/** Mapa nominal para uso em objetos literais e switches. */
export const WF = {
  match:          WF_MATCH,
  matchParcial:   WF_MATCH_PARCIAL,
  aptoReparo:     WF_APTO_REPARO,
  verificar:      WF_VERIFICAR,
  emAnalise:      WF_EM_ANALISE,
  aguardandoPeca: WF_AGUARDANDO,
  comTecnico:     WF_COM_TECNICO,
  vendaEstado:    WF_VENDA_ESTADO,
  finalizados:    WF_FINALIZADOS,
} as const;

/** Produz `workflow_status IN (?,?,…)` com os placeholders certos. */
export function wfInClause(statuses: readonly string[]): string {
  return `workflow_status IN (${statuses.map(() => "?").join(",")})`;
}

/** Soma do mapa de contagens por grupo de status. */
export function sumGroup(m: Map<string, number>, statuses: readonly string[]): number {
  return statuses.reduce((s, k) => s + (m.get(k) ?? 0), 0);
}
