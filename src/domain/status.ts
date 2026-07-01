import { collapseSpaces, normalizeStatus } from "./text.js";

/**
 * Status de pedido. As chaves são os tokens canônicos (normalizados, sem
 * acento, caixa alta); os valores são os rótulos amigáveis exibidos no
 * frontend (com acentuação preservada).
 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  MATCH: "MATCH",
  "MATCH PARCIAL": "MATCH PARCIAL",
  "PEDIR PECA": "PEDIR PEÇA",
  "SEM SALDO": "SEM SALDO",
  VERIFICAR: "VERIFICAR",
  CONCLUIDO: "CONCLUÍDO",
  SEPARADO: "SEPARADO",
  CANCELADO: "CANCELADO",
};

/**
 * Status permanentes — uma vez gravados, não podem ser sobrescritos por um
 * recálculo futuro (motor de match/distribuição).
 */
export const PERMANENT_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "CONCLUIDO",
  "SEPARADO",
  "CANCELADO",
]);

export const KIT_STATUS_LABELS: Record<string, string> = {
  "KIT POSSIVEL": "KIT POSSÍVEL",
  "MATCH PARCIAL": "MATCH PARCIAL",
  "KIT INCOMPLETO": "KIT INCOMPLETO",
  VERIFICAR: "VERIFICAR",
};

export const KIT_STATUS_PRIORITY: Record<string, number> = {
  "KIT POSSIVEL": 1,
  "MATCH PARCIAL": 2,
  "KIT INCOMPLETO": 9,
  VERIFICAR: 9,
};

/** Token canônico de um status de pedido (ou string vazia se ausente). */
export function orderStatusToken(raw: unknown): string {
  return normalizeStatus(raw);
}

/** Rótulo amigável; cai no original "limpo" para status desconhecidos. */
export function orderStatusLabel(raw: unknown): string | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const token = normalizeStatus(raw);
  return ORDER_STATUS_LABELS[token] ?? collapseSpaces(String(raw));
}

/** É um status permanente (não pode ser apagado por recálculo)? */
export function isPermanentStatus(raw: unknown): boolean {
  return PERMANENT_ORDER_STATUSES.has(normalizeStatus(raw));
}

export function kitStatusLabel(raw: unknown): string | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const token = normalizeStatus(raw);
  return KIT_STATUS_LABELS[token] ?? collapseSpaces(String(raw));
}

/** Prioridade do kit; 9 (mais baixa) como padrão para tokens desconhecidos. */
export function kitPriority(raw: unknown): number {
  const token = normalizeStatus(raw);
  return KIT_STATUS_PRIORITY[token] ?? 9;
}
