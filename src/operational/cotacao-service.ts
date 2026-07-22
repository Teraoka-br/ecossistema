import XLSX from "xlsx";
import type { Db } from "../db/database.js";

export interface NecessidadeItem {
  chavePeca: string;
  qtdeNecessaria: number;
  casesBlocked: number;
  /** Aparelhos que viram MATCH completo comprando só esta peça (nenhuma outra pendente). */
  fullMatchCount: number;
  marginReleased: number | null;
  saleReleased: number | null;
}

export interface LeverageResult {
  combinedUnblocked: number;
  costReleased: number | null;
  saleReleased: number | null;
  marginReleased: number | null;
}

export interface Cotacao {
  id: number;
  supplier: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "CANCELLED";
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  purchaseOrderId: number | null;
  items: CotacaoItem[];
}

export interface CotacaoItem {
  id: number;
  cotacaoId: number;
  chavePeca: string;
  qtde: number;
  valorUnitario: number;
  aprovado: boolean;
}

// ---------------------------------------------------------------------------
// Necessidades: peças que precisam ser pedidas
// ---------------------------------------------------------------------------

export function listNecessidades(db: Db): NecessidadeItem[] {
  type Row = {
    chave_peca: string;
    qtde_necessaria: number;
    cases_blocked: number;
    full_match_count: number;
    margin_released: number | null;
    sale_released: number | null;
  };
  return (db.prepare(`
    SELECT
      pr.chave_peca,
      COUNT(*)                          AS qtde_necessaria,
      COUNT(DISTINCT pr.repair_case_id) AS cases_blocked,
      COUNT(DISTINCT CASE WHEN NOT EXISTS (
        SELECT 1 FROM part_requests pr3
        WHERE pr3.repair_case_id = pr.repair_case_id
          AND pr3.status = 'PEDIR_PECA'
          AND pr3.cancelled_at IS NULL
          AND pr3.chave_peca IS NOT NULL
          AND pr3.chave_peca != pr.chave_peca
      ) THEN pr.repair_case_id END)   AS full_match_count,
      SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM part_requests pr3
        WHERE pr3.repair_case_id = pr.repair_case_id
          AND pr3.status = 'PEDIR_PECA'
          AND pr3.cancelled_at IS NULL
          AND pr3.chave_peca IS NOT NULL
          AND pr3.chave_peca != pr.chave_peca
      ) THEN rc.margin END)           AS margin_released,
      SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM part_requests pr3
        WHERE pr3.repair_case_id = pr.repair_case_id
          AND pr3.status = 'PEDIR_PECA'
          AND pr3.cancelled_at IS NULL
          AND pr3.chave_peca IS NOT NULL
          AND pr3.chave_peca != pr.chave_peca
      ) THEN rc.estimated_sale END)  AS sale_released
    FROM part_requests pr
    JOIN repair_cases rc ON rc.id = pr.repair_case_id
    WHERE rc.workflow_status = 'PEDIR_PECA'
      AND pr.status = 'PEDIR_PECA'
      AND pr.chave_peca IS NOT NULL
      AND pr.cancelled_at IS NULL
    GROUP BY pr.chave_peca
    ORDER BY cases_blocked DESC, qtde_necessaria DESC, pr.chave_peca
  `).all() as Row[])
    .map(r => ({
      chavePeca: r.chave_peca,
      qtdeNecessaria: r.qtde_necessaria,
      casesBlocked: r.cases_blocked,
      fullMatchCount: r.full_match_count,
      marginReleased: r.margin_released ?? null,
      saleReleased: r.sale_released ?? null,
    }));
}

/**
 * Gera um .xlsx (Excel padrão) com o template de cotação — evita o problema
 * de CSV com vírgula não abrir em colunas no Excel em locale pt-BR (que usa
 * vírgula como separador decimal e ponto-e-vírgula como separador de campo).
 */
export function buildNecessidadesXlsx(rows: Array<{ chavePeca: string; qtdeNecessaria: number }>): Buffer {
  const aoa: (string | number)[][] = [
    ["PECA", "QTDE", "VALOR UN", "VALOR TOTAL"],
    ...rows.map(r => [r.chavePeca, r.qtdeNecessaria, "", ""]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Cotação");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export interface CaseNeedingPart {
  caseId: number;
  imei: string;
  brand: string | null;
  model: string | null;
  margin: number | null;
  estimatedSale: number | null;
  otherPartsNeeded: string[];
  /** Se comprar só esta peça, status previsto do caso */
  predictedStatus: "MATCH" | "MATCH_PARCIAL";
}

export function getCasesNeedingPart(db: Db, chavePeca: string): CaseNeedingPart[] {
  type Row = {
    case_id: number;
    imei: string;
    brand: string | null;
    model: string | null;
    margin: number | null;
    estimated_sale: number | null;
    total_pending: number;
  };
  const rows = db.prepare(`
    SELECT
      rc.id AS case_id,
      rc.imei,
      rc.brand,
      rc.model,
      rc.margin,
      rc.estimated_sale,
      COUNT(pr2.id) AS total_pending
    FROM repair_cases rc
    JOIN part_requests pr ON pr.repair_case_id = rc.id
      AND pr.chave_peca = ?
      AND pr.status = 'PEDIR_PECA'
      AND pr.cancelled_at IS NULL
    LEFT JOIN part_requests pr2 ON pr2.repair_case_id = rc.id
      AND pr2.status = 'PEDIR_PECA'
      AND pr2.cancelled_at IS NULL
      AND pr2.chave_peca IS NOT NULL
      AND pr2.chave_peca != ?
    WHERE rc.workflow_status = 'PEDIR_PECA'
    GROUP BY rc.id
    ORDER BY rc.margin DESC NULLS LAST
  `).all(chavePeca, chavePeca) as Row[];

  return rows.map(r => {
    const otherParts = r.total_pending > 0
      ? (db.prepare(`
          SELECT DISTINCT chave_peca FROM part_requests
          WHERE repair_case_id = ?
            AND status = 'PEDIR_PECA'
            AND cancelled_at IS NULL
            AND chave_peca IS NOT NULL
            AND chave_peca != ?
          ORDER BY chave_peca
        `).all(r.case_id, chavePeca) as { chave_peca: string }[]).map(x => x.chave_peca)
      : [];

    return {
      caseId: r.case_id,
      imei: r.imei,
      brand: r.brand,
      model: r.model,
      margin: r.margin ?? null,
      estimatedSale: r.estimated_sale ?? null,
      otherPartsNeeded: otherParts,
      predictedStatus: otherParts.length === 0 ? "MATCH" : "MATCH_PARCIAL",
    };
  });
}

export function getLeverageData(db: Db, selectedParts: string[]): LeverageResult {
  if (selectedParts.length === 0) {
    return { combinedUnblocked: 0, costReleased: null, saleReleased: null, marginReleased: null };
  }
  const placeholders = selectedParts.map(() => "?").join(",");
  type Row = {
    cnt: number;
    cost_released: number | null;
    sale_released: number | null;
    margin_released: number | null;
  };
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT rc.id)   AS cnt,
      SUM(rc.cost)            AS cost_released,
      SUM(rc.estimated_sale)  AS sale_released,
      SUM(rc.margin)          AS margin_released
    FROM repair_cases rc
    WHERE rc.workflow_status = 'PEDIR_PECA'
      AND NOT EXISTS (
        SELECT 1 FROM part_requests pr2
        WHERE pr2.repair_case_id = rc.id
          AND pr2.status = 'PEDIR_PECA'
          AND pr2.cancelled_at IS NULL
          AND pr2.chave_peca IS NOT NULL
          AND pr2.chave_peca NOT IN (${placeholders})
      )
  `).get(...selectedParts) as Row;

  return {
    combinedUnblocked: row.cnt ?? 0,
    costReleased:   row.cost_released   ?? null,
    saleReleased:   row.sale_released   ?? null,
    marginReleased: row.margin_released ?? null,
  };
}

// ---------------------------------------------------------------------------
// Cotações
// ---------------------------------------------------------------------------

/**
 * Interpreta um número digitado livremente por um fornecedor (ex.: "R$ 45,90",
 * "1.234,56", "45.9", "5 un"). Remove tudo que não for dígito/vírgula/ponto/
 * sinal, depois decide o separador decimal: se houver vírgula E ponto, o
 * ponto é separador de milhar (formato BR); só vírgula → decimal BR; só
 * ponto ou nenhum dos dois → já está em formato decimal comum.
 */
function parseFlexibleNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  const cleaned = String(raw ?? "").trim().replace(/[^\d,.-]/g, "");
  if (!cleaned) return NaN;
  if (cleaned.includes(",") && cleaned.includes(".")) {
    return parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
  }
  if (cleaned.includes(",")) {
    return parseFloat(cleaned.replace(",", "."));
  }
  return parseFloat(cleaned);
}

/** Mesma tolerância de `parseFlexibleNumber`, mas para inteiros (quantidade). */
function parseFlexibleInt(raw: unknown): number {
  if (typeof raw === "number") return Math.round(raw);
  const cleaned = String(raw ?? "").trim().replace(/[^\d-]/g, "");
  return cleaned ? parseInt(cleaned, 10) : NaN;
}

/**
 * Lê o template de cotação preenchido (.xlsx) devolvido pelo fornecedor.
 * Mesma tolerância do parser CSV anterior: detecta e pula a linha de
 * cabeçalho se presente, ignora linhas sem chave/quantidade/valor válidos.
 * Números aceitam símbolo de moeda, separador de milhar e vírgula ou ponto
 * decimal — um fornecedor digitando "R$ 45,90" não pode fazer a linha
 * inteira desaparecer silenciosamente da cotação.
 */
export function parseCotacaoXlsx(filePath: string): Array<{ chavePeca: string; qtde: number; valorUnitario: number }> {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: null });

  const firstRowJoined = (rows[0] ?? []).map(c => String(c ?? "")).join(",").toUpperCase();
  const start = firstRowJoined.includes("PECA") || firstRowJoined.includes("VALOR") ? 1 : 0;

  const result: Array<{ chavePeca: string; qtde: number; valorUnitario: number }> = [];
  for (const row of rows.slice(start)) {
    const chavePeca = row[0] != null ? String(row[0]).trim() : "";
    const qtde = parseFlexibleInt(row[1]);
    const valorUnitario = parseFlexibleNumber(row[2]);
    if (!chavePeca || !Number.isFinite(qtde) || !Number.isFinite(valorUnitario) || valorUnitario <= 0) continue;
    result.push({ chavePeca, qtde, valorUnitario });
  }
  return result;
}

function toItem(r: Record<string, unknown>): CotacaoItem {
  return {
    id: r.id as number,
    cotacaoId: r.cotacao_id as number,
    chavePeca: r.chave_peca as string,
    qtde: r.qtde as number,
    valorUnitario: r.valor_unitario as number,
    aprovado: (r.aprovado as number) === 1,
  };
}

function toCotacao(r: Record<string, unknown>, items: CotacaoItem[]): Cotacao {
  return {
    id: r.id as number,
    supplier: r.supplier as string,
    status: r.status as Cotacao["status"],
    notes: (r.notes as string) ?? null,
    createdAt: r.created_at as string,
    createdBy: (r.created_by as string) ?? null,
    approvedAt: (r.approved_at as string) ?? null,
    approvedBy: (r.approved_by as string) ?? null,
    purchaseOrderId: (r.purchase_order_id as number) ?? null,
    items,
  };
}

export function listCotacoes(db: Db): Cotacao[] {
  const rows = db.prepare("SELECT * FROM cotacoes ORDER BY id DESC").all() as Record<string, unknown>[];
  return rows.map(r => {
    const items = (db.prepare("SELECT * FROM cotacao_items WHERE cotacao_id = ? ORDER BY chave_peca").all(r.id as number) as Record<string, unknown>[]).map(toItem);
    return toCotacao(r, items);
  });
}

export function getCotacao(db: Db, id: number): Cotacao {
  const row = db.prepare("SELECT * FROM cotacoes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Cotação ${id} não encontrada.`);
  const items = (db.prepare("SELECT * FROM cotacao_items WHERE cotacao_id = ? ORDER BY chave_peca").all(id) as Record<string, unknown>[]).map(toItem);
  return toCotacao(row, items);
}

export function createCotacao(db: Db, params: {
  supplier: string;
  notes?: string | null;
  createdBy?: string;
  items: Array<{ chavePeca: string; qtde: number; valorUnitario: number }>;
}): Cotacao {
  // Filtra itens sem preço
  const validItems = params.items.filter(i => i.valorUnitario > 0 && i.qtde > 0);
  if (validItems.length === 0) throw new Error("Nenhum item com preço válido para registrar.");

  const insert = db.prepare(`
    INSERT INTO cotacoes (supplier, notes, created_by)
    VALUES (?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO cotacao_items (cotacao_id, chave_peca, qtde, valor_unitario)
    VALUES (?, ?, ?, ?)
  `);

  let cotacaoId!: number;
  db.prepare("BEGIN").run();
  try {
    const res = insert.run(params.supplier, params.notes ?? null, params.createdBy ?? null);
    cotacaoId = res.lastInsertRowid as number;
    for (const item of validItems) {
      insertItem.run(cotacaoId, item.chavePeca, item.qtde, item.valorUnitario);
    }
    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /**/ }
    throw err;
  }

  return getCotacao(db, cotacaoId);
}

export function aprovaCotacao(db: Db, cotacaoId: number, params: {
  aprovados: Array<{ id: number; qtde: number }>;
  approvedBy: string;
}): { cotacao: Cotacao; purchaseOrderId: number; orderNumber: string } {
  const cotacao = getCotacao(db, cotacaoId);
  if (cotacao.status !== "PENDING_APPROVAL") throw new Error("Esta cotação não está pendente de aprovação.");

  const aprovadosMap = new Map(params.aprovados.map(a => [a.id, a.qtde]));
  const itensSelecionados = cotacao.items.filter(i => aprovadosMap.has(i.id));
  if (itensSelecionados.length === 0) throw new Error("Selecione ao menos um item para aprovar.");

  // Gerar número do pedido
  const lastOrder = db.prepare("SELECT order_number FROM purchase_orders ORDER BY id DESC LIMIT 1").get() as { order_number: string } | undefined;
  let nextNum = 1;
  if (lastOrder) {
    const m = lastOrder.order_number.match(/(\d+)$/);
    if (m) nextNum = parseInt(m[1]) + 1;
  }
  const orderNumber = `PED-${String(nextNum).padStart(4, "0")}`;

  db.prepare("BEGIN").run();
  try {
    // Criar purchase_order
    const orderRes = db.prepare(`
      INSERT INTO purchase_orders (order_number, supplier, status, created_at, created_by)
      VALUES (?, ?, 'AWAITING_RECEIPT', datetime('now'), ?)
    `).run(orderNumber, cotacao.supplier, params.approvedBy);
    const purchaseOrderId = orderRes.lastInsertRowid as number;

    // Inserir itens no pedido com a qtde customizada pelo usuário
    for (const item of itensSelecionados) {
      const qtdeOrdenada = aprovadosMap.get(item.id) ?? item.qtde;
      db.prepare(`
        INSERT INTO purchase_order_items
          (purchase_order_id, referencia, referencia_norm, chave_peca, quantity_ordered, quantity_received)
        VALUES (?, ?, lower(replace(?,' ','')), ?, ?, 0)
      `).run(purchaseOrderId, item.chavePeca, item.chavePeca, item.chavePeca, qtdeOrdenada);
    }

    // Marcar itens como aprovado/reprovado e gravar histórico de preços
    const insertPrice = db.prepare(
      `INSERT INTO price_history (chave_peca, supplier, valor_unitario, cotacao_id)
       VALUES (?, ?, ?, ?)`,
    );
    for (const item of cotacao.items) {
      const aprovado = aprovadosMap.has(item.id);
      db.prepare("UPDATE cotacao_items SET aprovado = ? WHERE id = ?").run(aprovado ? 1 : 0, item.id);
      // Grava histórico para todos os itens com preço, aprovados ou não
      insertPrice.run(item.chavePeca, cotacao.supplier, item.valorUnitario, cotacaoId);
    }

    // Atualizar cotação
    db.prepare(`
      UPDATE cotacoes SET status = 'APPROVED', approved_at = datetime('now'),
        approved_by = ?, purchase_order_id = ? WHERE id = ?
    `).run(params.approvedBy, purchaseOrderId, cotacaoId);

    db.prepare("COMMIT").run();

    return { cotacao: getCotacao(db, cotacaoId), purchaseOrderId, orderNumber };
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /**/ }
    throw err;
  }
}

export function cancelCotacao(db: Db, id: number): void {
  db.prepare("UPDATE cotacoes SET status = 'CANCELLED' WHERE id = ?").run(id);
}
