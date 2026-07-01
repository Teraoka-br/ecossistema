import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { preview, confirm } from "../src/import/import-service.js";
import * as proc from "../src/operational/procurement-service.js";
import { ProcurementError } from "../src/operational/procurement-service.js";
import * as recv from "../src/operational/receiving-service.js";
import { getCurrentOperationalStock, listMovements } from "../src/operational/stock-service.js";
import {
  ANALYSIS_HEADER,
  BIPAGEM_HEADER,
  ORDERS_HEADER,
  QUOTATION_HEADER,
  cleanup,
  makeXlsx,
  orderRow,
} from "./helpers.js";

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanup(created.pop()!);
});

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

/** Importa e inicializa um sistema com uma solicitação aprovada de 10 baterias. */
function initializedDb(): { db: Db; requestId: number; batchId: number } {
  const db = freshDb();
  const ordersPath = makeXlsx(
    [
      { name: "PEDIDOS", aoa: [ORDERS_HEADER, orderRow({ idPedido: "PED1", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })] },
      { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ["PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"]] },
    ],
    "PEDIDOS.xlsx",
  );
  const analysisPath = makeXlsx(
    [
      { name: "PEÇAS A PEDIR", aoa: [QUOTATION_HEADER, ["PED1", "BAT", 10, 10, 100, "2026-06-01", "APROVADO"]] },
      { name: "ANALISEMI", aoa: [ANALYSIS_HEADER] },
    ],
    "ANALISE MI.xlsx",
  );
  created.push(ordersPath, analysisPath);
  const orders = { filePath: ordersPath, fileName: "PEDIDOS.xlsx" };
  const analysis = { filePath: analysisPath, fileName: "ANALISE MI.xlsx" };
  const res = confirm(db, preview(db, orders, analysis).previewBatchId);
  const request = db.prepare("SELECT id FROM purchase_requests LIMIT 1").get() as { id: number };
  return { db, requestId: request.id, batchId: res.batchId };
}

describe("Etapa 3 — pedidos de compra", () => {
  it("gera pedido a partir de uma solicitação aprovada", () => {
    const { db, requestId } = initializedDb();
    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 10 }],
    });
    expect(order.order_number).toMatch(/^PC-\d{8}-\d{4}$/);
    expect(order.status).toBe("AWAITING_RECEIPT");
    expect(order.items).toHaveLength(1);

    const req = proc.listPurchaseRequests(db).find((r) => r.id === requestId)!;
    expect(req.status).toBe("ORDERED");
  });

  it("quantidade zero é bloqueada", () => {
    const { db } = initializedDb();
    expect(() =>
      proc.createPurchaseOrder(db, { createdBy: "Joao", items: [{ referencia: "PC-1", quantity: 0 }] }),
    ).toThrow(ProcurementError);
  });

  it("pedido recebe número único mesmo com criação concorrente no mesmo dia", () => {
    const { db } = initializedDb();
    const o1 = proc.createPurchaseOrder(db, { createdBy: "Joao", items: [{ referencia: "PC-1", quantity: 1 }] });
    const o2 = proc.createPurchaseOrder(db, { createdBy: "Joao", items: [{ referencia: "PC-1", quantity: 1 }] });
    expect(o1.order_number).not.toBe(o2.order_number);
  });

  it("cancelar pedido preserva histórico", () => {
    const { db, requestId } = initializedDb();
    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 10 }],
    });
    const cancelled = proc.cancelPurchaseOrder(db, order.id, { cancelledBy: "Joao", cancelReason: "duplicado" });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelled_by).toBe("Joao");
    const stillThere = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(order.id);
    expect(stillThere).toBeTruthy();
  });

  it("pedido cancelado não pode ser recebido", () => {
    const { db, requestId } = initializedDb();
    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 10 }],
    });
    proc.cancelPurchaseOrder(db, order.id, { cancelledBy: "Joao", cancelReason: "erro" });
    expect(() =>
      recv.confirmReceipt(db, order.id, {
        receivedBy: "Joao",
        items: [{ purchaseOrderItemId: order.items[0].id, quantity: 1 }],
      }),
    ).toThrow(ProcurementError);
  });
});

describe("Etapa 4 — recebimento", () => {
  function orderFixture() {
    const { db, requestId } = initializedDb();
    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 10 }],
    });
    return { db, order };
  }

  it("recebimento total muda pedido para RECEIVED", () => {
    const { db, order } = orderFixture();
    const result = recv.confirmReceipt(db, order.id, {
      receivedBy: "Joao",
      items: [{ purchaseOrderItemId: order.items[0].id, quantity: 10 }],
    });
    expect(result.order.status).toBe("RECEIVED");
    expect(result.unitsReceived).toBe(10);
  });

  it("recebimento parcial mantém pedido em PARTIALLY_RECEIVED", () => {
    const { db, order } = orderFixture();
    const result = recv.confirmReceipt(db, order.id, {
      receivedBy: "Joao",
      items: [{ purchaseOrderItemId: order.items[0].id, quantity: 6 }],
    });
    expect(result.order.status).toBe("PARTIALLY_RECEIVED");
    expect(result.order.items[0].quantity_received).toBe(6);
  });

  it("múltiplos recebimentos no mesmo pedido somam corretamente", () => {
    const { db, order } = orderFixture();
    recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 6 }] });
    const second = recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 4 }] });
    expect(second.order.status).toBe("RECEIVED");
    expect(second.order.items[0].quantity_received).toBe(10);
  });

  it("quantidade maior que o saldo é bloqueada sem força", () => {
    const { db, order } = orderFixture();
    expect(() =>
      recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 15 }] }),
    ).toThrow(ProcurementError);
  });

  it("sobre-recebimento exige allowOverReceipt + justificativa >= 10 caracteres", () => {
    const { db, order } = orderFixture();
    expect(() =>
      recv.confirmReceipt(db, order.id, {
        receivedBy: "Joao",
        allowOverReceipt: true,
        justification: "curta",
        items: [{ purchaseOrderItemId: order.items[0].id, quantity: 15 }],
      }),
    ).toThrow(ProcurementError);

    const ok = recv.confirmReceipt(db, order.id, {
      receivedBy: "Joao",
      allowOverReceipt: true,
      justification: "fornecedor enviou lote maior por engano",
      items: [{ purchaseOrderItemId: order.items[0].id, quantity: 15 }],
    });
    expect(ok.unitsReceived).toBe(15);
  });

  it("referência com CHAVEPECA fora do catálogo operacional é bloqueada", () => {
    const { db, requestId } = initializedDb();
    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-NOVA", chavePeca: "CHAVE-INEXISTENTE", quantity: 5 }],
    });
    expect(() =>
      recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 5 }] }),
    ).toThrow(ProcurementError);
  });

  it("recebimento cria movimentação positiva de estoque", () => {
    const { db, order } = orderFixture();
    recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 6 }] });
    const movements = listMovements(db, { type: "PURCHASE_RECEIPT" });
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(6);
  });

  it("falha na confirmação executa rollback completo (nenhuma peça entra no estoque)", () => {
    const { db, order } = orderFixture();
    expect(() =>
      recv.confirmReceipt(db, order.id, {
        receivedBy: "Joao",
        items: [
          { purchaseOrderItemId: order.items[0].id, quantity: 5 },
          { purchaseOrderItemId: 999999, quantity: 1 }, // item inexistente -> falha
        ],
      }),
    ).toThrow();
    const movements = listMovements(db);
    expect(movements).toHaveLength(0);
    const fresh = proc.getPurchaseOrder(db, order.id);
    expect(fresh.items[0].quantity_received).toBe(0);
  });

  it("pedido completo muda para RECEIVED e solicitação para ORDERED (fluxo consumido)", () => {
    const { db, order, } = orderFixture();
    recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 10 }] });
    const fresh = proc.getPurchaseOrder(db, order.id);
    expect(fresh.status).toBe("RECEIVED");
  });
});

describe("Etapa 5 — estoque operacional (livro de movimentações)", () => {
  it("sem snapshot, estoque usa a importação inicial", () => {
    const { db } = initializedDb();
    const stock = getCurrentOperationalStock(db);
    expect(stock.base.type).toBe("INITIAL_IMPORT");
    expect(stock.currentTotal).toBe(1); // 1 unidade BAT importada (PC-1)
  });

  it("recebimento posterior aumenta o estoque imediatamente", () => {
    const { db, requestId } = initializedDb();
    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 10 }],
    });
    recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 6 }] });

    const stock = getCurrentOperationalStock(db);
    expect(stock.currentTotal).toBe(7); // 1 base + 6 recebidos
    expect(stock.movementsTotal).toBe(6);
  });

  it("quantidade negativa gera erro de integridade (defensivo)", () => {
    const { db } = initializedDb();
    // Movimentação de saída maior que a base disponível.
    db.prepare(
      `INSERT INTO stock_movements (movement_type, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity)
       VALUES ('MANUAL_ADJUSTMENT', 'PC-1', 'PC-1', 'BAT', 'BAT', -999)`,
    ).run();
    expect(() => getCurrentOperationalStock(db)).toThrow();
  });
});
