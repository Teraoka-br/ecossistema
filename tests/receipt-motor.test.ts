/**
 * Testes de integração: recebimento → estoque → motor → MATCH.
 * Usa banco em memória — nunca toca data/app.sqlite.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { createRepairCase, addPart } from "../src/repair/repair-service.js";
import * as recv from "../src/operational/receiving-service.js";
import * as proc from "../src/operational/procurement-service.js";
import { runRepairMatchEngine } from "../src/match/engine-orchestrator.js";
import { getCurrentOperationalStock } from "../src/operational/stock-service.js";
import { ensurePurchaseRequestForPart } from "../src/operational/purchase-request-service.js";
import {
  startRepair, completeRepair, directToTechnician,
  reserveKit,
} from "../src/operational/reservation-service.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

function seedUser(db: Db): number {
  const r = db.prepare(
    "INSERT INTO users (username, display_name, pin_hash, role) VALUES ('admin','Admin','x','ADMIN')"
  ).run();
  return r.lastInsertRowid as number;
}

function seedTech(db: Db): number {
  const r = db.prepare(
    "INSERT INTO staff_members (name, type, active) VALUES ('Carlos','TECHNICIAN',1)"
  ).run();
  return r.lastInsertRowid as number;
}

/**
 * O motor mantém sempre 10 casos elegíveis-mas-sem-match em VENDA_ESTADO
 * (piores margin_points), preenchendo vagas a cada run. Em bancos de teste
 * pequenos, o caso sob teste seria varrido para VENDA_ESTADO por ser o único
 * elegível. Pré-preenchemos as 10 vagas com casos já em VENDA_ESTADO — o motor
 * não mexe neles (permanente) e o caso testado fica protegido desde o primeiro run.
 */
function seedFillerCases(db: Db, count = 10): void {
  for (let i = 0; i < count; i++) {
    const rc = createRepairCase(db, { imei: `FILLER${i}`, createdByUserId: 1 });
    addPart(db, rc.id, { description: "Filler", chavePeca: `FILLER-PART-${i}`, createdByUserId: 1 });
    db.prepare(
      "UPDATE repair_cases SET analysis_status='COMPLETED', workflow_status='VENDA_ESTADO', age_days=30, cost=100000, estimated_sale=1, margin=-99999, deposito_atual='AGUARDANDO PECA' WHERE id=?",
    ).run(rc.id);
    db.prepare("UPDATE part_requests SET status='PEDIR_PECA' WHERE repair_case_id=?").run(rc.id);
  }
}

/**
 * Cria pedido de compra com item vinculado a uma purchase_request.
 * Retorna os IDs para controle no teste.
 */
function createPurchaseFlow(
  db: Db,
  partRequestId: number,
  chavePeca: string,
  referencia: string,
  quantity: number,
): { purchaseOrderId: number; purchaseOrderItemId: number } {
  const pr = ensurePurchaseRequestForPart(db, partRequestId);
  const order = proc.createPurchaseOrder(db, {
    createdBy: "Admin",
    items: [{ purchaseRequestId: pr.purchaseRequestId, referencia, chavePeca, quantity }],
  });
  return { purchaseOrderId: order.id, purchaseOrderItemId: order.items[0].id };
}

// ---------------------------------------------------------------------------
// 1. Recebimento cria stock_movement
// ---------------------------------------------------------------------------

describe("confirmReceipt — stock_movement", () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    seedUser(db);
  });

  it("cria stock_movement PURCHASE_RECEIPT", () => {
    const rc = createRepairCase(db, { imei: "111", os: "OS-1", createdByUserId: 1 });
    const p1 = addPart(db, rc.id, { description: "Bateria", chavePeca: "BATERIA A32", createdByUserId: 1 });
    db.prepare("UPDATE part_requests SET status='PEDIR_PECA' WHERE repair_case_id=?").run(rc.id);

    const { purchaseOrderId, purchaseOrderItemId } = createPurchaseFlow(db, p1.id, "BATERIA A32", "REF001", 5);

    recv.confirmReceipt(db, purchaseOrderId, {
      receivedBy: "Admin",
      items: [{ purchaseOrderItemId, quantity: 5 }],
    });

    const movement = db.prepare(
      "SELECT * FROM stock_movements WHERE movement_type='PURCHASE_RECEIPT'"
    ).get() as Record<string, unknown> | undefined;
    expect(movement).toBeDefined();
    expect(Number(movement!.quantity)).toBe(5);
    expect(movement!.chave_peca_norm).toBeTruthy();
  });

  it("atualiza purchase_order.status para RECEIVED após recebimento completo", () => {
    const rc = createRepairCase(db, { imei: "222", createdByUserId: 1 });
    const p2 = addPart(db, rc.id, { description: "Tela", chavePeca: "TELA A32", createdByUserId: 1 });

    const { purchaseOrderId, purchaseOrderItemId } = createPurchaseFlow(db, p2.id, "TELA A32", "REF002", 3);

    recv.confirmReceipt(db, purchaseOrderId, {
      receivedBy: "Admin",
      items: [{ purchaseOrderItemId, quantity: 3 }],
    });

    const po = db.prepare("SELECT status FROM purchase_orders WHERE id=?").get(purchaseOrderId) as { status: string };
    expect(po.status).toBe("RECEIVED");
  });

  it("recebimento parcial define status PARTIALLY_RECEIVED", () => {
    const rc = createRepairCase(db, { imei: "333", createdByUserId: 1 });
    const partC = addPart(db, rc.id, { description: "Carcaça", chavePeca: "CARCACA A32", createdByUserId: 1 });

    const { purchaseOrderId, purchaseOrderItemId } = createPurchaseFlow(db, partC.id, "CARCACA A32", "REF003", 5);

    recv.confirmReceipt(db, purchaseOrderId, {
      receivedBy: "Admin",
      items: [{ purchaseOrderItemId, quantity: 2 }],
    });

    const po = db.prepare("SELECT status FROM purchase_orders WHERE id=?").get(purchaseOrderId) as { status: string };
    expect(po.status).toBe("PARTIALLY_RECEIVED");
  });
});

// ---------------------------------------------------------------------------
// 2. Motor gera MATCH após recebimento
// ---------------------------------------------------------------------------

describe("recebimento → motor → MATCH", () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    seedUser(db);
    // migração 013 já insere a regra padrão ativa e o match_engine_state
  });

  it("caso AGUARDANDO_RECEBIMENTO vira MATCH quando peça é recebida", async () => {
    seedFillerCases(db);
    // Cria aparelho com análise completa
    const rc = createRepairCase(db, { imei: "444", os: "OS-4", createdByUserId: 1 });
    const partA32 = addPart(db, rc.id, { description: "Bateria", chavePeca: "BATERIA A32", createdByUserId: 1 });
    db.prepare("UPDATE repair_cases SET analysis_status='COMPLETED', workflow_status='PEDIR_PECA', age_days=30, cost=0, estimated_sale=50, margin=50, model='MODELO A32', deposito_atual='AGUARDANDO PECA' WHERE id=?").run(rc.id);
    db.prepare("UPDATE part_requests SET status='PEDIR_PECA' WHERE repair_case_id=?").run(rc.id);

    // Cria pedido de compra
    const { purchaseOrderId, purchaseOrderItemId } = createPurchaseFlow(db, partA32.id, "BATERIA A32", "REF-BAT", 5);

    // Motor antes do recebimento — sem estoque, deve ficar em PEDIR_PECA ou AGUARDANDO_RECEBIMENTO
    await runRepairMatchEngine(db, { triggerReason: "before-receipt" });

    // Confirma recebimento
    recv.confirmReceipt(db, purchaseOrderId, {
      receivedBy: "Admin",
      items: [{ purchaseOrderItemId, quantity: 5 }],
    });

    // Valida stock_movement positivo
    const movement = db.prepare(
      "SELECT quantity FROM stock_movements WHERE movement_type='PURCHASE_RECEIPT' AND chave_peca_norm LIKE '%BATERIA A32%'"
    ).get() as { quantity: number } | undefined;
    expect(movement).toBeDefined();
    expect(Number(movement!.quantity)).toBeGreaterThan(0);

    // Motor após recebimento
    const result = await runRepairMatchEngine(db, { triggerReason: "after-receipt" });
    expect(result.fullKitsFound).toBeGreaterThanOrEqual(1);

    // Valida repair_case = MATCH
    const updatedCase = db.prepare("SELECT workflow_status FROM repair_cases WHERE id=?").get(rc.id) as { workflow_status: string };
    expect(updatedCase.workflow_status).toBe("MATCH");

    // Valida part_request = INDICADA
    const updatedPart = db.prepare("SELECT status FROM part_requests WHERE repair_case_id=?").get(rc.id) as { status: string };
    expect(updatedPart.status).toBe("INDICADA");
  });

  it("recebimento parcial pode gerar MATCH_PARCIAL quando kit incompleto", async () => {
    const rc = createRepairCase(db, { imei: "555", createdByUserId: 1 });
    addPart(db, rc.id, { description: "Bateria", chavePeca: "BATERIA B10", createdByUserId: 1 });
    addPart(db, rc.id, { description: "Tela", chavePeca: "TELA B10", createdByUserId: 1 });
    db.prepare("UPDATE repair_cases SET analysis_status='COMPLETED', workflow_status='PEDIR_PECA', age_days=20, cost=0, estimated_sale=40, margin=40, model='MODELO A52', deposito_atual='AGUARDANDO PECA' WHERE id=?").run(rc.id);
    db.prepare("UPDATE part_requests SET status='PEDIR_PECA' WHERE repair_case_id=?").run(rc.id);

    // Cria pedido só para bateria
    const partIds = db.prepare("SELECT id FROM part_requests WHERE repair_case_id=?").all(rc.id) as { id: number }[];
    const bateriaId = partIds[0].id;
    const { purchaseOrderId, purchaseOrderItemId } = createPurchaseFlow(db, bateriaId, "BATERIA B10", "REF-BAT-B10", 2);

    // Recebe bateria (kit incompleto — tela ainda não recebida)
    recv.confirmReceipt(db, purchaseOrderId, {
      receivedBy: "Admin",
      items: [{ purchaseOrderItemId, quantity: 2 }],
    });

    const result = await runRepairMatchEngine(db, { triggerReason: "partial-receipt" });
    expect(result.partialKitsFound).toBeGreaterThanOrEqual(1);

    const updatedCase = db.prepare("SELECT workflow_status FROM repair_cases WHERE id=?").get(rc.id) as { workflow_status: string };
    expect(updatedCase.workflow_status).toBe("MATCH_PARCIAL");
  });

  it("saldo disponível fica visível no estoque operacional após recebimento", () => {
    const rc = createRepairCase(db, { imei: "666", createdByUserId: 1 });
    const partT = addPart(db, rc.id, { description: "Tampa", chavePeca: "TAMPA C20 AZUL", createdByUserId: 1 });
    db.prepare("UPDATE part_requests SET status='PEDIR_PECA' WHERE repair_case_id=?").run(rc.id);

    const { purchaseOrderId, purchaseOrderItemId } = createPurchaseFlow(db, partT.id, "TAMPA C20 AZUL", "REF-TAMPA", 3);

    recv.confirmReceipt(db, purchaseOrderId, {
      receivedBy: "Admin",
      items: [{ purchaseOrderItemId, quantity: 3 }],
    });

    const { groups } = getCurrentOperationalStock(db);
    const g = groups.find((x) => x.chavePecaNorm === "TAMPA C20 AZUL");
    expect(g).toBeDefined();
    expect(g!.availableQuantity).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Timestamps de reparo
// ---------------------------------------------------------------------------

describe("timestamps de reparo — startRepair / completeRepair", () => {
  let db: Db;
  let userId: number;
  let techId: number;

  beforeEach(() => {
    db = makeDb();
    userId = seedUser(db);
    techId = seedTech(db);
    // migração 013 já insere a regra padrão ativa e o match_engine_state
  });

  function setupApto(): { caseId: number; reservationId: number } {
    // Cria estoque
    db.prepare(`
      INSERT INTO stock_movements
        (movement_type, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity, source_type)
      VALUES ('PURCHASE_RECEIPT','REF-TS','REF-TS','BATERIA TS','BATERIA TS',5,'seed')
    `).run();

    const rc = createRepairCase(db, { imei: "TS-001", createdByUserId: userId });
    const part = addPart(db, rc.id, { description: "Bateria", chavePeca: "BATERIA TS", createdByUserId: userId });
    db.prepare("UPDATE repair_cases SET workflow_status='MATCH', analysis_status='COMPLETED' WHERE id=?").run(rc.id);

    const reservations = reserveKit(db, rc.id, [{
      partRequestId: part.id,
      chavePeca: "BATERIA TS",
      reference: "REF-TS",
      quantity: 1,
      availableQty: 5,
    }], userId);

    return { caseId: rc.id, reservationId: reservations[0].id };
  }

  it("startRepair grava repair_started_at", () => {
    const { caseId } = setupApto();
    directToTechnician(db, caseId, { technicianId: techId, userId });
    startRepair(db, caseId, { userId, responsibleName: "Admin" });

    const row = db.prepare("SELECT repair_started_at, repair_started_by_user_id FROM repair_cases WHERE id=?").get(caseId) as Record<string, unknown>;
    expect(row.repair_started_at).toBeTruthy();
    expect(row.repair_started_by_user_id).toBe(userId);
  });

  it("startRepair grava repair_started_by_user_id", () => {
    const { caseId } = setupApto();
    directToTechnician(db, caseId, { technicianId: techId, userId });
    startRepair(db, caseId, { userId, responsibleName: "Admin" });

    const row = db.prepare("SELECT repair_started_by_user_id FROM repair_cases WHERE id=?").get(caseId) as { repair_started_by_user_id: number };
    expect(row.repair_started_by_user_id).toBe(userId);
  });

  it("completeRepair grava repair_completed_at", () => {
    const { caseId } = setupApto();
    directToTechnician(db, caseId, { technicianId: techId, userId });
    startRepair(db, caseId, { userId });
    completeRepair(db, caseId, { userId, responsibleName: "Admin" });

    const row = db.prepare("SELECT repair_completed_at, repair_completed_by_user_id FROM repair_cases WHERE id=?").get(caseId) as Record<string, unknown>;
    expect(row.repair_completed_at).toBeTruthy();
    expect(row.repair_completed_by_user_id).toBe(userId);
  });

  it("duração pode ser calculada pela diferença entre timestamps", () => {
    const { caseId } = setupApto();
    directToTechnician(db, caseId, { technicianId: techId, userId });
    startRepair(db, caseId, { userId });
    completeRepair(db, caseId, { userId });

    const row = db.prepare("SELECT repair_started_at, repair_completed_at FROM repair_cases WHERE id=?").get(caseId) as { repair_started_at: string; repair_completed_at: string };
    expect(row.repair_started_at).toBeTruthy();
    expect(row.repair_completed_at).toBeTruthy();
    const start = new Date(row.repair_started_at).getTime();
    const end = new Date(row.repair_completed_at).getTime();
    expect(end).toBeGreaterThanOrEqual(start);
  });
});

// ---------------------------------------------------------------------------
// 4. Autocomplete de peças (endpoint /api/analise/part-suggestions)
// ---------------------------------------------------------------------------

describe("part-suggestions — autocomplete", () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    seedUser(db);
    db.prepare(`
      INSERT INTO repair_cases (imei, analysis_status, workflow_status, created_by_user_id)
      VALUES ('AC-001','COMPLETED','MATCH',1)
    `).run();
    const rcId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

    // Registros com description mas sem peca_nome (legado)
    db.prepare(`
      INSERT INTO part_requests (repair_case_id, description, peca_nome, chave_peca, chave_peca_norm, status, created_by_user_id)
      VALUES (?, 'FRONTAL COM ARO', NULL, 'FRONTAL COM ARO A52', 'FRONTAL COM ARO A52', 'PEDIR_PECA', 1)
    `).run(rcId);
    db.prepare(`
      INSERT INTO part_requests (repair_case_id, description, peca_nome, chave_peca, chave_peca_norm, status, created_by_user_id)
      VALUES (?, 'BATERIA', NULL, 'BATERIA A52', 'BATERIA A52', 'INDICADA', 1)
    `).run(rcId);

    // Registro com peca_nome preenchido (novo)
    db.prepare(`
      INSERT INTO part_requests (repair_case_id, description, peca_nome, chave_peca, chave_peca_norm, status, created_by_user_id)
      VALUES (?, 'TELA COMPLETA', 'TELA FRONTAL', 'TELA FRONTAL A52', 'TELA FRONTAL A52', 'PEDIR_PECA', 1)
    `).run(rcId);
  });

  type Suggestion = { text: string; type: "nome" | "chave" };

  function getSuggestions(db: Db, q: string): Suggestion[] {
    const pattern = `%${q.toUpperCase()}%`;

    const fromPecaNome = db.prepare(
      `SELECT DISTINCT peca_nome AS text FROM part_requests
       WHERE peca_nome IS NOT NULL AND upper(peca_nome) LIKE ? LIMIT 15`
    ).all(pattern) as { text: string }[];

    const fromChave = db.prepare(
      `SELECT DISTINCT chave_peca AS text FROM part_requests
       WHERE chave_peca IS NOT NULL AND upper(chave_peca) LIKE ? LIMIT 10`
    ).all(pattern) as { text: string }[];

    const fromMi = db.prepare(
      `SELECT DISTINCT peca_solicitada AS text FROM analise_mi_rows
       WHERE peca_solicitada IS NOT NULL AND upper(peca_solicitada) LIKE ? LIMIT 10`
    ).all(pattern) as { text: string }[];

    const seen = new Set<string>();
    const suggestions: Suggestion[] = [];
    for (const { text } of fromPecaNome) {
      const t = text.trim().toUpperCase();
      if (t && !seen.has(t)) { seen.add(t); suggestions.push({ text: t, type: "nome" }); }
    }
    for (const { text } of fromMi) {
      const t = text.trim().toUpperCase();
      if (t && !seen.has(t)) { seen.add(t); suggestions.push({ text: t, type: "nome" }); }
    }
    for (const { text } of fromChave) {
      const t = text.trim().toUpperCase();
      if (t && !seen.has(t)) { seen.add(t); suggestions.push({ text: t, type: "chave" }); }
    }
    return suggestions;
  }

  it("retorna sugestões ao digitar 'frontal'", () => {
    const s = getSuggestions(db, "frontal");
    expect(s.length).toBeGreaterThan(0);
    expect(s.some((x) => x.text.includes("FRONTAL"))).toBe(true);
  });

  it("retorna peca_nome como type='nome'", () => {
    const s = getSuggestions(db, "tela");
    const nome = s.find((x) => x.text === "TELA FRONTAL");
    expect(nome).toBeDefined();
    expect(nome!.type).toBe("nome");
  });

  it("retorna chave_peca como type='chave' (sem duplicar modelo)", () => {
    const s = getSuggestions(db, "frontal");
    const chave = s.find((x) => x.type === "chave" && x.text.includes("FRONTAL COM ARO"));
    expect(chave).toBeDefined();
    // chave não deve ser duplicada em nomes
    const nomeTexts = s.filter((x) => x.type === "nome").map((x) => x.text);
    expect(nomeTexts).not.toContain("FRONTAL COM ARO A52");
  });

  it("texto livre continua funcionando (sem sugestões ≠ erro)", () => {
    const s = getSuggestions(db, "xyzxyz");
    expect(s).toHaveLength(0);
  });
});
