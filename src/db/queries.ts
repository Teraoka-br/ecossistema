import type { Db } from "./database.js";
import type {
  DeviceGroup,
  DiagnosticReport,
  InventoryGroup,
  InventoryItem,
  OrderPart,
  Quotation,
} from "../shared/types.js";
import { getActiveBatch, getBatch, issueSummary, listIssues } from "./repository.js";
import { orderStatusLabel } from "../domain/status.js";

/** Lote ativo = último lote concluído (com ou sem warnings). */
export function activeBatchId(db: Db): number | null {
  return getActiveBatch(db)?.id ?? null;
}

interface OrderFilters {
  search?: string;
  status?: string;
  limit?: number;
}

function likeParam(s: string): string {
  return `%${s.trim()}%`;
}

export function listOrderParts(db: Db, batchId: number, filters: OrderFilters = {}): OrderPart[] {
  const where: string[] = ["import_batch_id = ?"];
  const params: (string | number)[] = [batchId];

  if (filters.search && filters.search.trim() !== "") {
    where.push(
      "(imei LIKE ? OR os LIKE ? OR id_pedido LIKE ? OR concat_peca LIKE ? OR chave_peca LIKE ? OR referencia LIKE ?)",
    );
    const p = likeParam(filters.search);
    params.push(p, p, p, p, p, p);
  }
  if (filters.status && filters.status.trim() !== "") {
    where.push("status_atual_legado = ?");
    params.push(filters.status.trim().toUpperCase());
  }

  const limit = filters.limit ?? 10000;
  const rows = db
    .prepare(
      `SELECT id, id_pedido, imei, os, concat_peca, chave_peca, referencia,
              status_atual_legado, status_atual_label, status_kit_legado, prioridade_kit_legado,
              quantidade_pecas_aparelho, idade, custo, venda, margem_legada,
              nota_idade_legada, nota_margem_legada, score_legado, ordem_consumo_legada,
              quantidade_estoque_legada, pecas_sem_estoque_legada
       FROM source_order_parts
       WHERE ${where.join(" AND ")}
       ORDER BY id_pedido, chave_peca
       LIMIT ?`,
    )
    .all(...params, limit) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as number,
    idPedido: r.id_pedido as string,
    imei: (r.imei as string) ?? null,
    os: (r.os as string) ?? null,
    concatPeca: (r.concat_peca as string) ?? null,
    chavePeca: (r.chave_peca as string) ?? null,
    referencia: (r.referencia as string) ?? null,
    statusAtual: (r.status_atual_legado as string) ?? null,
    statusAtualLabel: (r.status_atual_label as string) ?? orderStatusLabel(r.status_atual_legado),
    statusKit: (r.status_kit_legado as string) ?? null,
    prioridadeKit: (r.prioridade_kit_legado as number) ?? null,
    quantidadePecasAparelho: (r.quantidade_pecas_aparelho as number) ?? null,
    idade: (r.idade as number) ?? null,
    custo: (r.custo as number) ?? null,
    venda: (r.venda as number) ?? null,
    margem: (r.margem_legada as number) ?? null,
    notaIdade: (r.nota_idade_legada as number) ?? null,
    notaMargem: (r.nota_margem_legada as number) ?? null,
    score: (r.score_legado as number) ?? null,
    ordemConsumo: (r.ordem_consumo_legada as number) ?? null,
    quantidadeEstoque: (r.quantidade_estoque_legada as number) ?? null,
    pecasSemEstoque: (r.pecas_sem_estoque_legada as number) ?? null,
  }));
}

/**
 * Agrupa as peças por aparelho (IMEI; cai para ID PEDIDO só quando o IMEI é nulo).
 * Cada peça mantém seu próprio ID_PEDIDO. Sinaliza quando o mesmo IMEI aparece
 * com OS diferentes (inconsistência que merece atenção).
 */
export function groupByDevice(parts: OrderPart[]): DeviceGroup[] {
  const groups = new Map<string, DeviceGroup & { _os: Set<string> }>();
  for (const p of parts) {
    const key = p.imei ?? p.idPedido;
    let g = groups.get(key);
    if (!g) {
      g = {
        imei: p.imei,
        groupKey: key,
        osValues: [],
        osConflict: false,
        quantidadePecasAparelho: p.quantidadePecasAparelho,
        score: p.score,
        parts: [],
        _os: new Set<string>(),
      };
      groups.set(key, g);
    }
    g.parts.push(p);
    if (p.os) g._os.add(p.os);
    if ((p.score ?? -Infinity) > (g.score ?? -Infinity)) g.score = p.score;
  }
  return [...groups.values()].map(({ _os, ...g }) => ({
    ...g,
    osValues: [..._os],
    osConflict: _os.size > 1,
  }));
}

export function distinctOrderStatuses(db: Db, batchId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT status_atual_legado AS s FROM source_order_parts
       WHERE import_batch_id = ? AND status_atual_legado IS NOT NULL
       ORDER BY s`,
    )
    .all(batchId) as { s: string }[];
  return rows.map((r) => r.s);
}

export function listInventoryGroups(db: Db, batchId: number, search?: string): InventoryGroup[] {
  const where: string[] = ["import_batch_id = ?"];
  const params: (string | number)[] = [batchId];
  if (search && search.trim() !== "") {
    where.push("(referencia LIKE ? OR descricao LIKE ? OR chave_peca LIKE ? OR fornecedor LIKE ?)");
    const p = likeParam(search);
    params.push(p, p, p, p);
  }
  // Agrupa por (referencia_norm, chave_peca_norm) — NUNCA só por referência.
  // Unidades sem CHAVEPECA não podem aparecer agrupadas sob a chave de outra
  // unidade da mesma referência (isso escondia o problema "sem chave" atrás
  // de um MAX(chave_peca) que pegava qualquer chave válida do grupo).
  const rows = db
    .prepare(
      `SELECT referencia, MAX(descricao) AS descricao, MAX(chave_peca) AS chave_peca, chave_peca_norm,
              MAX(fornecedor) AS fornecedor, COUNT(*) AS unidades
       FROM source_inventory_items
       WHERE ${where.join(" AND ")}
       GROUP BY referencia_norm, chave_peca_norm
       ORDER BY referencia, unidades DESC`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map((r) => {
    const chavePecaNorm = (r.chave_peca_norm as string) ?? "";
    return {
      referencia: (r.referencia as string) ?? null,
      descricao: (r.descricao as string) ?? null,
      chavePeca: chavePecaNorm === "" ? null : (r.chave_peca as string) ?? null,
      fornecedor: (r.fornecedor as string) ?? null,
      unidades: r.unidades as number,
      // Só grupos com chave_peca_norm preenchida poderão alimentar o match futuro.
      mapeada: chavePecaNorm !== "",
    };
  });
}

export function inventoryTotalUnits(db: Db, batchId: number): number {
  const r = db
    .prepare("SELECT COUNT(*) AS c FROM source_inventory_items WHERE import_batch_id = ?")
    .get(batchId) as { c: number };
  return r.c;
}

export function listInventoryItems(db: Db, batchId: number, search?: string, limit = 5000): InventoryItem[] {
  const where: string[] = ["import_batch_id = ?"];
  const params: (string | number)[] = [batchId];
  if (search && search.trim() !== "") {
    where.push("(referencia LIKE ? OR descricao LIKE ? OR chave_peca LIKE ? OR fornecedor LIKE ?)");
    const p = likeParam(search);
    params.push(p, p, p, p);
  }
  const rows = db
    .prepare(
      `SELECT id, id_peca_estoque, referencia, descricao, chave_peca, fornecedor, status_fisico
       FROM source_inventory_items WHERE ${where.join(" AND ")}
       ORDER BY referencia LIMIT ?`,
    )
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    idPecaEstoque: (r.id_peca_estoque as string) ?? null,
    referencia: (r.referencia as string) ?? null,
    descricao: (r.descricao as string) ?? null,
    chavePeca: (r.chave_peca as string) ?? null,
    fornecedor: (r.fornecedor as string) ?? null,
    statusFisico: (r.status_fisico as string) ?? null,
  }));
}

export function listQuotations(db: Db, batchId: number, search?: string): Quotation[] {
  const where: string[] = ["import_batch_id = ?"];
  const params: (string | number)[] = [batchId];
  if (search && search.trim() !== "") {
    where.push("(id_pedido LIKE ? OR chave_peca LIKE ? OR status LIKE ?)");
    const p = likeParam(search);
    params.push(p, p, p);
  }
  const rows = db
    .prepare(
      `SELECT id, id_pedido, chave_peca, quantidade, valor_unitario, valor_total, data_cotacao, status
       FROM source_quotations WHERE ${where.join(" AND ")}
       ORDER BY id_pedido, chave_peca`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    idPedido: (r.id_pedido as string) ?? null,
    chavePeca: (r.chave_peca as string) ?? null,
    quantidade: (r.quantidade as number) ?? null,
    valorUnitario: (r.valor_unitario as number) ?? null,
    valorTotal: (r.valor_total as number) ?? null,
    dataCotacao: (r.data_cotacao as string) ?? null,
    status: (r.status as string) ?? null,
  }));
}

export function diagnostic(db: Db, batchId?: number): DiagnosticReport {
  const batch = batchId ? getBatch(db, batchId) : getActiveBatch(db);
  if (!batch) return { batch: null, issues: [], issueSummary: {} };
  return {
    batch: {
      id: batch.id,
      status: batch.status,
      analysisFileName: batch.analysis_file_name,
      ordersFileName: batch.orders_file_name,
      analysisFileHash: batch.analysis_file_hash,
      ordersFileHash: batch.orders_file_hash,
      startedAt: batch.started_at,
      finishedAt: batch.finished_at,
      ordersFound: batch.orders_found,
      ordersImported: batch.orders_imported,
      inventoryFound: batch.inventory_found,
      inventoryImported: batch.inventory_imported,
      quotationsFound: batch.quotations_found,
      quotationsImported: batch.quotations_imported,
      analysisFound: batch.analysis_found,
      analysisImported: batch.analysis_imported,
      warningsCount: batch.warnings_count,
      errorsCount: batch.errors_count,
      conflictsCount: batch.conflicts_count,
    },
    issues: listIssues(db, batch.id),
    issueSummary: issueSummary(db, batch.id),
  };
}
