/**
 * Testes para as correções do MVP operacional (itens 1–7 do commit de correção).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import {
  ensurePurchaseRequestForPart,
  PurchaseRequestLinkError,
} from "../src/operational/purchase-request-service.js";
import { createPurchaseOrder } from "../src/operational/procurement-service.js";
import { applyAnaliseMiToRepairCases } from "../src/import-central/operational-sync-service.js";

// ─── Helpers de setup ─────────────────────────────────────────────────────────

function insertRepairCase(db: Db, opts: { imei?: string; workflow?: string; analysis?: string } = {}): number {
  const res = db.prepare(
    `INSERT INTO repair_cases (imei, imei_norm, os, analysis_status, workflow_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    opts.imei ?? "123456789012345",
    opts.imei ?? "123456789012345",
    "OS-001",
    opts.analysis ?? "COMPLETED",
    opts.workflow ?? "PEDIR_PECA",
  );
  return res.lastInsertRowid as number;
}

function insertPartRequest(
  db: Db,
  caseId: number,
  opts: { chave?: string; status?: string; legacyId?: string; allocated_ref?: string } = {},
): number {
  const res = db.prepare(
    `INSERT INTO part_requests
       (repair_case_id, chave_peca, chave_peca_norm, allocated_reference, allocated_reference_norm,
        legacy_id_pedido, status, analysis_complete_at_creation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).run(
    caseId,
    opts.chave ?? "CHAVE-001",
    opts.chave ?? "chave001",
    opts.allocated_ref ?? null,
    opts.allocated_ref ?? null,
    opts.legacyId ?? "LP-001",
    opts.status ?? "PEDIR_PECA",
  );
  return res.lastInsertRowid as number;
}

function insertAnaliseMiRows(db: Db, importId: number, rows: Array<{
  id_pedido: string;
  imei?: string;
  imei_norm?: string;
  os?: string;
  concat_peca?: string;
  ref_peca?: string;
  peca_solicitada?: string;
  brand?: string;
  model?: string;
  color?: string;
  status_src?: string;
  data_pedido?: string;
}>) {
  const stmt = db.prepare(
    `INSERT INTO analise_mi_rows
       (analise_mi_import_id, id_pedido, imei, imei_norm, os, concat_peca, ref_peca,
        peca_solicitada, brand, model, color, status_src, deposito_src, solicitante, data_pedido)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      importId, r.id_pedido,
      r.imei ?? "123456789012345", r.imei_norm ?? "123456789012345",
      r.os ?? "OS-001",
      r.concat_peca ?? null, r.ref_peca ?? null,
      r.peca_solicitada ?? null,
      r.brand ?? null, r.model ?? null, r.color ?? null,
      r.status_src ?? null,
      r.data_pedido ?? "2024-01-01",
    );
  }
}

let _importSeq = 0;
function insertAnaliseMiImport(db: Db): number {
  const hash = `hash-${++_importSeq}-${Date.now()}`;
  const res = db.prepare(
    `INSERT INTO analise_mi_imports (filename, file_hash, status, created_at)
     VALUES ('analise-mi.xlsx', ?, 'COMPLETED', datetime('now'))`,
  ).run(hash);
  return res.lastInsertRowid as number;
}

function insertPurchaseRequest(
  db: Db,
  opts: { partRequestId?: number; status?: string; chave?: string; referencia?: string } = {},
): number {
  const res = db.prepare(
    `INSERT INTO purchase_requests
       (id_pedido, chave_peca, chave_peca_norm, referencia, referencia_norm,
        quantidade, origin_status, status, part_request_id, created_at, updated_at)
     VALUES ('LP-001', ?, ?, ?, ?, 1, 'PART_REQUEST', ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    opts.chave ?? "CHAVE-001",
    opts.chave ?? "chave001",
    opts.referencia ?? "REF-001",
    opts.referencia ?? "ref001",
    opts.status ?? "APPROVED",
    opts.partRequestId ?? null,
  );
  return res.lastInsertRowid as number;
}

// ─── 1. ensurePurchaseRequestForPart ─────────────────────────────────────────

describe("ensurePurchaseRequestForPart", () => {
  let db: Db;
  beforeEach(async () => { db = await createDb(); });

  it("primeira chamada cria purchase_request com status APPROVED", () => {
    const caseId = insertRepairCase(db);
    const partId = insertPartRequest(db, caseId, { chave: "CHAVE-001", legacyId: "LP-001" });

    const result = ensurePurchaseRequestForPart(db, partId);

    expect(result.created).toBe(true);
    expect(result.alreadyExisted).toBe(false);
    expect(result.purchaseRequestId).toBeGreaterThan(0);

    const pr = db.prepare("SELECT * FROM purchase_requests WHERE id = ?").get(result.purchaseRequestId) as Record<string, unknown>;
    expect(pr.status).toBe("APPROVED");
    expect(pr.origin_status).toBe("PART_REQUEST");
    expect(pr.part_request_id).toBe(partId);
    expect(pr.id_pedido).toBe("LP-001");
  });

  it("segunda chamada não duplica — retorna existente", () => {
    const caseId = insertRepairCase(db);
    const partId = insertPartRequest(db, caseId);

    const r1 = ensurePurchaseRequestForPart(db, partId);
    const r2 = ensurePurchaseRequestForPart(db, partId);

    expect(r2.created).toBe(false);
    expect(r2.alreadyExisted).toBe(true);
    expect(r2.purchaseRequestId).toBe(r1.purchaseRequestId);

    const count = (db.prepare("SELECT COUNT(*) AS c FROM purchase_requests WHERE part_request_id = ?").get(partId) as { c: number }).c;
    expect(count).toBe(1);
  });

  it("usa allocated_reference como referencia quando disponível", () => {
    const caseId = insertRepairCase(db);
    const partId = insertPartRequest(db, caseId, { chave: "CHAVE-001", allocated_ref: "REF-ALOCADA" });

    const result = ensurePurchaseRequestForPart(db, partId);
    const pr = db.prepare("SELECT referencia FROM purchase_requests WHERE id = ?").get(result.purchaseRequestId) as { referencia: string };
    expect(pr.referencia).toBe("REF-ALOCADA");
  });

  it("usa chave_peca como referencia quando não há allocated_reference", () => {
    const caseId = insertRepairCase(db);
    const partId = insertPartRequest(db, caseId, { chave: "CHAVE-XYZ" });

    const result = ensurePurchaseRequestForPart(db, partId);
    const pr = db.prepare("SELECT referencia FROM purchase_requests WHERE id = ?").get(result.purchaseRequestId) as { referencia: string };
    expect(pr.referencia).toBe("CHAVE-XYZ");
  });

  it("lança NOT_FOUND para part_request inexistente", () => {
    expect(() => ensurePurchaseRequestForPart(db, 99999))
      .toThrow(PurchaseRequestLinkError);
  });

  it("lança PART_CANCELLED para peça cancelada", () => {
    const caseId = insertRepairCase(db);
    const partId = insertPartRequest(db, caseId, { status: "CANCELADA" });

    expect(() => ensurePurchaseRequestForPart(db, partId))
      .toThrow(PurchaseRequestLinkError);
  });

  it("pode recriar após cancelamento da purchase_request", () => {
    const caseId = insertRepairCase(db);
    const partId = insertPartRequest(db, caseId);

    const r1 = ensurePurchaseRequestForPart(db, partId);
    // Cancelar a purchase_request existente
    db.prepare("UPDATE purchase_requests SET status = 'CANCELLED' WHERE id = ?").run(r1.purchaseRequestId);

    const r2 = ensurePurchaseRequestForPart(db, partId);
    expect(r2.created).toBe(true);
    expect(r2.purchaseRequestId).not.toBe(r1.purchaseRequestId);
  });
});

// ─── 2. createPurchaseOrder — atualização de part_requests e repair_cases ────

describe("createPurchaseOrder com part_request_id", () => {
  let db: Db;
  beforeEach(async () => { db = await createDb(); });

  it("atualiza purchase_request para ORDERED e part_request para AGUARDANDO_RECEBIMENTO", () => {
    const caseId = insertRepairCase(db, { workflow: "PEDIR_PECA" });
    const partId = insertPartRequest(db, caseId, { status: "PEDIR_PECA" });
    const prId = insertPurchaseRequest(db, { partRequestId: partId, status: "APPROVED", chave: "CHAVE-001", referencia: "REF-001" });

    createPurchaseOrder(db, {
      createdBy: "teste",
      items: [{ purchaseRequestId: prId, referencia: "REF-001", chavePeca: "CHAVE-001", quantity: 1 }],
    });

    const pr = db.prepare("SELECT status FROM purchase_requests WHERE id = ?").get(prId) as { status: string };
    expect(pr.status).toBe("ORDERED");

    const part = db.prepare("SELECT status FROM part_requests WHERE id = ?").get(partId) as { status: string };
    expect(part.status).toBe("AGUARDANDO_RECEBIMENTO");

    const rc = db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?").get(caseId) as { workflow_status: string };
    expect(rc.workflow_status).toBe("AGUARDANDO_RECEBIMENTO");
  });

  it("não altera repair_case em estado preservado (APTO_REPARO)", () => {
    const caseId = insertRepairCase(db, { workflow: "APTO_REPARO" });
    const partId = insertPartRequest(db, caseId, { status: "PEDIR_PECA" });
    const prId = insertPurchaseRequest(db, { partRequestId: partId, status: "APPROVED" });

    createPurchaseOrder(db, {
      createdBy: "teste",
      items: [{ purchaseRequestId: prId, referencia: "REF-001", quantity: 1 }],
    });

    const rc = db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?").get(caseId) as { workflow_status: string };
    expect(rc.workflow_status).toBe("APTO_REPARO");
  });

  it("funciona sem purchaseRequestId (item avulso)", () => {
    createPurchaseOrder(db, {
      createdBy: "teste",
      items: [{ referencia: "REF-AVULSA", quantity: 2 }],
    });
    const count = (db.prepare("SELECT COUNT(*) AS c FROM purchase_orders").get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

// ─── 3. applyAnaliseMiToRepairCases ──────────────────────────────────────────

describe("applyAnaliseMiToRepairCases", () => {
  let db: Db;
  beforeEach(async () => { db = await createDb(); });

  it("nova linha com chave válida → COMPLETED/PEDIR_PECA", () => {
    const importId = insertAnaliseMiImport(db);
    insertAnaliseMiRows(db, importId, [{
      id_pedido: "ID-001",
      imei: "111222333444555", imei_norm: "111222333444555",
      concat_peca: "CHAVE-VALIDA",
    }]);

    applyAnaliseMiToRepairCases(db, importId);

    const rc = db.prepare(
      `SELECT rc.analysis_status, rc.workflow_status
       FROM repair_cases rc
       JOIN part_requests pr ON pr.repair_case_id = rc.id
       WHERE pr.legacy_id_pedido = 'ID-001'`,
    ).get() as { analysis_status: string; workflow_status: string };

    expect(rc.analysis_status).toBe("COMPLETED");
    expect(rc.workflow_status).toBe("PEDIR_PECA");

    const pr = db.prepare("SELECT status FROM part_requests WHERE legacy_id_pedido = 'ID-001'").get() as { status: string };
    expect(pr.status).toBe("PEDIR_PECA");
  });

  it("nova linha sem chave válida → COMPLETED/VERIFICAR", () => {
    const importId = insertAnaliseMiImport(db);
    insertAnaliseMiRows(db, importId, [{
      id_pedido: "ID-002",
      imei: "222333444555666", imei_norm: "222333444555666",
      concat_peca: null,
      ref_peca: null,
    }]);

    applyAnaliseMiToRepairCases(db, importId);

    const rc = db.prepare(
      `SELECT rc.analysis_status, rc.workflow_status
       FROM repair_cases rc
       JOIN part_requests pr ON pr.repair_case_id = rc.id
       WHERE pr.legacy_id_pedido = 'ID-002'`,
    ).get() as { analysis_status: string; workflow_status: string };

    expect(rc.analysis_status).toBe("COMPLETED");
    expect(rc.workflow_status).toBe("VERIFICAR");

    const pr = db.prepare("SELECT status FROM part_requests WHERE legacy_id_pedido = 'ID-002'").get() as { status: string };
    expect(pr.status).toBe("VERIFICAR");
  });

  it("reimportação não duplica part_request", () => {
    const importId1 = insertAnaliseMiImport(db);
    insertAnaliseMiRows(db, importId1, [{
      id_pedido: "ID-003",
      imei: "333444555666777", imei_norm: "333444555666777",
      concat_peca: "CHAVE-TEST",
    }]);
    applyAnaliseMiToRepairCases(db, importId1);

    const importId2 = insertAnaliseMiImport(db);
    insertAnaliseMiRows(db, importId2, [{
      id_pedido: "ID-003",
      imei: "333444555666777", imei_norm: "333444555666777",
      concat_peca: "CHAVE-TEST",
    }]);
    applyAnaliseMiToRepairCases(db, importId2);

    const count = (db.prepare("SELECT COUNT(*) AS c FROM part_requests WHERE legacy_id_pedido = 'ID-003'").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("estado avançado de part_request não regride", () => {
    const caseId = insertRepairCase(db, { imei: "444555666777888", workflow: "APTO_REPARO" });
    insertPartRequest(db, caseId, { legacyId: "ID-004", status: "RESERVADA", chave: "CHAVE-ORIG" });

    const importId = insertAnaliseMiImport(db);
    insertAnaliseMiRows(db, importId, [{
      id_pedido: "ID-004",
      imei: "444555666777888", imei_norm: "444555666777888",
      concat_peca: "CHAVE-NOVA",
    }]);
    applyAnaliseMiToRepairCases(db, importId);

    // part_request não regrediu
    const pr = db.prepare("SELECT status FROM part_requests WHERE legacy_id_pedido = 'ID-004'").get() as { status: string };
    expect(pr.status).toBe("RESERVADA");

    // repair_case não regrediu
    const rc = db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?").get(caseId) as { workflow_status: string };
    expect(rc.workflow_status).toBe("APTO_REPARO");
  });
});

// ─── 4. Migration 022 — índice correto ───────────────────────────────────────

describe("migration 022 — índice uidx_pr_part_request_active", () => {
  let db: Db;
  beforeEach(async () => { db = await createDb(); });

  it("não permite duas purchase_requests ativas para o mesmo part_request_id", () => {
    const caseId = insertRepairCase(db);
    const partId = insertPartRequest(db, caseId);

    ensurePurchaseRequestForPart(db, partId);

    // Tentar criar diretamente um segundo registro ativo — deve falhar
    expect(() => {
      db.prepare(
        `INSERT INTO purchase_requests
           (id_pedido, chave_peca, chave_peca_norm, referencia, referencia_norm,
            quantidade, origin_status, status, part_request_id, created_at, updated_at)
         VALUES ('X','Y','y','R','r',1,'PART_REQUEST','APPROVED',?,datetime('now'),datetime('now'))`,
      ).run(partId);
    }).toThrow();
  });

  it("permite nova purchase_request após cancelamento da anterior", () => {
    const caseId = insertRepairCase(db);
    const partId = insertPartRequest(db, caseId);

    const r1 = ensurePurchaseRequestForPart(db, partId);
    db.prepare("UPDATE purchase_requests SET status = 'CANCELLED' WHERE id = ?").run(r1.purchaseRequestId);

    // Agora deve conseguir inserir
    expect(() => {
      db.prepare(
        `INSERT INTO purchase_requests
           (id_pedido, chave_peca, chave_peca_norm, referencia, referencia_norm,
            quantidade, origin_status, status, part_request_id, created_at, updated_at)
         VALUES ('X','Y','y','R','r',1,'PART_REQUEST','APPROVED',?,datetime('now'),datetime('now'))`,
      ).run(partId);
    }).not.toThrow();
  });
});
