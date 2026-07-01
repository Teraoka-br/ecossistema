import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { preview, confirm } from "../src/import/import-service.js";
import * as svc from "../src/counting/counting-service.js";
import { CountingError } from "../src/counting/counting-service.js";
import * as proc from "../src/operational/procurement-service.js";
import * as recv from "../src/operational/receiving-service.js";
import { getCurrentOperationalStock } from "../src/operational/stock-service.js";
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

function initializedDb(): { db: Db; requestId: number } {
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
  confirm(db, preview(db, orders, analysis).previewBatchId);
  const request = db.prepare("SELECT id FROM purchase_requests LIMIT 1").get() as { id: number };
  return { db, requestId: request.id };
}

describe("Etapa 6 — sessão de contagem sobre estoque operacional", () => {
  it("sessão congela baseline no início (INITIAL_IMPORT)", () => {
    const { db } = initializedDb();
    const session = svc.createSession(db, { responsibleName: "Joao" });
    expect(session.baseline_type).toBe("INITIAL_IMPORT");
    expect(session.baseline_total_units).toBe(1); // 1 unidade BAT importada
    expect(session.baseline_cutoff_movement_id).toBe(0);
  });

  it("recebimento durante sessão aberta gera warning e bloqueia finalização normal", () => {
    const { db, requestId } = initializedDb();
    const session = svc.createSession(db, { responsibleName: "Joao" });
    svc.registerScan(db, session.id, { reference: "PC-1" });

    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 5 }],
    });
    recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 5 }] });

    const summary = svc.buildFinalizeSummary(db, session.id);
    expect(summary.warnings).toContain("STOCK_MOVEMENTS_DURING_COUNT");
    expect(summary.canFinalize).toBe(false);

    expect(() => svc.finalizeSession(db, session.id, { finalizedBy: "Joao" })).toThrow(CountingError);
  });

  it("finalização forçada exige responsável e justificativa >= 10 caracteres", () => {
    const { db, requestId } = initializedDb();
    const session = svc.createSession(db, { responsibleName: "Joao" });
    svc.registerScan(db, session.id, { reference: "PC-1" });

    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 5 }],
    });
    recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 5 }] });

    expect(() =>
      svc.finalizeSession(db, session.id, { finalizedBy: "Joao", forceIncomplete: true, forceReason: "curta" }),
    ).toThrow(CountingError);

    const result = svc.finalizeSession(db, session.id, {
      finalizedBy: "Joao",
      forceIncomplete: true,
      forceReason: "recebimento ocorreu durante a contagem, aprovado pelo gerente",
    });
    expect(result.alreadyFinalized).toBe(false);
    expect(result.snapshot.total_units).toBe(1);
  });

  it("novo snapshot absorve movimentações anteriores à finalização (sem dupla contagem depois)", () => {
    const { db, requestId } = initializedDb();
    const session = svc.createSession(db, { responsibleName: "Joao" });
    svc.registerScan(db, session.id, { reference: "PC-1" });

    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 5 }],
    });
    recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 5 }] });

    svc.finalizeSession(db, session.id, {
      finalizedBy: "Joao",
      forceIncomplete: true,
      forceReason: "recebimento durante a contagem, aprovado",
    });

    // Estoque atual agora deve ser exatamente o total do novo snapshot (1) —
    // a movimentação de +5 que ocorreu ANTES da finalização já foi absorvida.
    const stock = getCurrentOperationalStock(db);
    expect(stock.base.type).toBe("OFFICIAL_SNAPSHOT");
    expect(stock.currentTotal).toBe(1);
    expect(stock.movementsTotal).toBe(0);
  });

  it("uma sessão vazia nunca pode ser forçada, mesmo com movimentação durante a contagem", () => {
    const { db, requestId } = initializedDb();
    const session = svc.createSession(db, { responsibleName: "Joao" });

    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 5 }],
    });
    recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 5 }] });

    expect(() =>
      svc.finalizeSession(db, session.id, { finalizedBy: "Joao", forceIncomplete: true, forceReason: "justificativa bem longa aqui" }),
    ).toThrow(CountingError);
  });
});

describe("Cenário de integração completo (importação -> inicialização -> compra -> recebimento -> contagem)", () => {
  it("executa os 20 passos do cenário sem executar nenhum match", () => {
    const { db, requestId } = initializedDb();

    // 3. nova importação bloqueada
    // (coberto em tests/system-initialization.test.ts; aqui seguimos o fluxo operacional)

    // 4-5. seleciona solicitação aprovada e gera pedido de 10
    const order = proc.createPurchaseOrder(db, {
      createdBy: "Joao",
      items: [{ purchaseRequestId: requestId, referencia: "PC-1", chavePeca: "BAT", quantity: 10 }],
    });

    // 6-7. recebe 6, pedido parcialmente recebido
    const r1 = recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 6 }] });
    expect(r1.order.status).toBe("PARTIALLY_RECEIVED");

    // 8. estoque aumentado em 6 (base 1 + 6 = 7)
    expect(getCurrentOperationalStock(db).currentTotal).toBe(7);

    // 9-10. recebe as 4 restantes, pedido RECEIVED
    const r2 = recv.confirmReceipt(db, order.id, { receivedBy: "Joao", items: [{ purchaseOrderItemId: order.items[0].id, quantity: 4 }] });
    expect(r2.order.status).toBe("RECEIVED");

    // 11. estoque aumentado no total em 10 (base 1 + 10 = 11)
    expect(getCurrentOperationalStock(db).currentTotal).toBe(11);

    // 12. inicia contagem (baseline congela em 11, sem movimentos pendentes)
    const session = svc.createSession(db, { responsibleName: "Joao" });
    expect(session.baseline_total_units).toBe(11);

    // 13. bipa referência desconhecida duas vezes
    svc.registerScan(db, session.id, { reference: "REF-DESCONHECIDA" });
    svc.registerScan(db, session.id, { reference: "REF-DESCONHECIDA" });

    // 14. resolve
    svc.resolveReferenceManually(db, session.id, { referenceNorm: "REF-DESCONHECIDA", chavePeca: "BAT", responsibleName: "Joao" });

    // 15. bipa mais três vezes
    svc.registerScan(db, session.id, { reference: "REF-DESCONHECIDA" });
    svc.registerScan(db, session.id, { reference: "REF-DESCONHECIDA" });
    svc.registerScan(db, session.id, { reference: "REF-DESCONHECIDA" });

    // 16. recarrega a sessão (simulando F5)
    const state = svc.getSessionState(db, session.id);

    // 17. confirma total 5
    expect(state.summary.activeScans).toBe(5);
    expect(state.totalsByReference.find((t) => t.referenceNorm === "REF-DESCONHECIDA")?.total).toBe(5);

    // 18. finaliza
    const finalized = svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });
    expect(finalized.alreadyFinalized).toBe(false);

    // 19. confirma integridade do snapshot
    expect(finalized.snapshot.total_units).toBe(5);

    // 20. confirma que nenhum match foi executado
    const matchRuns = db.prepare("SELECT COUNT(*) AS c FROM match_runs").get() as { c: number };
    const matchResults = db.prepare("SELECT COUNT(*) AS c FROM match_results").get() as { c: number };
    expect(matchRuns.c).toBe(0);
    expect(matchResults.c).toBe(0);
  });
});
