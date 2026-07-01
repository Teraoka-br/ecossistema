/**
 * Cálculo do status de lote de separação a partir dos seus itens.
 * Função pura — sem acesso a banco.
 */

import type { SeparationBatchStatus, SeparationItemStatus } from "./separation-types.js";

interface ItemStatusCounts {
  reserved: number;
  confirmed: number;
  cancelled: number;
}

export function countItemStatuses(statuses: SeparationItemStatus[]): ItemStatusCounts {
  let reserved = 0;
  let confirmed = 0;
  let cancelled = 0;
  for (const s of statuses) {
    if (s === "RESERVED") reserved++;
    else if (s === "CONFIRMED") confirmed++;
    else if (s === "CANCELLED") cancelled++;
  }
  return { reserved, confirmed, cancelled };
}

/**
 * Deriva o status do lote a partir dos seus itens.
 *
 * OPEN               — existe reservado; nenhum confirmado.
 * PARTIALLY_COMPLETED — existe confirmado; e existe reservado ou cancelado.
 * COMPLETED          — todos confirmados.
 * CANCELLED          — todos cancelados; nenhum confirmado.
 */
export function deriveBatchStatus(statuses: SeparationItemStatus[]): SeparationBatchStatus {
  if (statuses.length === 0) return "CANCELLED";
  const { reserved, confirmed, cancelled } = countItemStatuses(statuses);
  if (confirmed > 0 && reserved === 0 && cancelled === 0) return "COMPLETED";
  if (confirmed > 0) return "PARTIALLY_COMPLETED";
  if (reserved > 0) return "OPEN";
  // todos cancelados, nenhum confirmado
  return "CANCELLED";
}
