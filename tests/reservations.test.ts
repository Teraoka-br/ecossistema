import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import {
  reserveKit, reservePartial, releaseReservation, consumeReservation,
  getReservationByPartRequest, getReservedQuantity, ReservationError,
} from "../src/operational/reservation-service.js";

let db: Db;

function seedRepairCase(db: Db, imei: string): number {
  const r = db.prepare(`
    INSERT INTO repair_cases (imei, os, workflow_status, created_at, updated_at)
    VALUES (?, 'OS-1', 'MATCH', datetime('now'), datetime('now'))
  `).run(imei);
  return r.lastInsertRowid as number;
}

function seedPartRequest(db: Db, caseId: number, chave: string): number {
  const r = db.prepare(`
    INSERT INTO part_requests (repair_case_id, chave_peca, chave_peca_norm, status, created_at, updated_at)
    VALUES (?, ?, lower(?), 'AGUARDANDO', datetime('now'), datetime('now'))
  `).run(caseId, chave, chave);
  return r.lastInsertRowid as number;
}

function seedStock(db: Db, chaveNorm: string, qty: number): void {
  // Insert an OFFICIAL snapshot with items to serve as the stock base
  const snap = db.prepare(
    "INSERT INTO stock_snapshots (session_id, status, finalized_at) SELECT id, 'OFFICIAL', datetime('now') FROM count_sessions LIMIT 1"
  ).run();
  if (!snap.lastInsertRowid) return;

  // Seed directly via stock_movements (INITIAL_BALANCE)
  db.prepare(`
    INSERT INTO stock_movements (movement_type, chave_peca, chave_peca_norm, quantity, source_type, source_id, created_at)
    VALUES ('INITIAL_BALANCE', ?, ?, ?, 'seed', 0, datetime('now', '-1 day'))
  `).run(chaveNorm, chaveNorm, qty);
}

beforeEach(async () => {
  db = await createDb();
});

describe("reserveKit", () => {
  it("kit completo transacional — cria reservas e atualiza status do caso", () => {
    const caseId = seedRepairCase(db, "IMEI-001");
    const pr1 = seedPartRequest(db, caseId, "TELA-A");
    const pr2 = seedPartRequest(db, caseId, "TELA-A");

    seedStock(db, "tela-a", 5);

    const reservations = reserveKit(db, caseId, [
      { partRequestId: pr1, chavePeca: "TELA-A", reference: null, quantity: 1, availableQty: 5 },
      { partRequestId: pr2, chavePeca: "TELA-A", reference: null, quantity: 1, availableQty: 4 },
    ], null);

    expect(reservations).toHaveLength(2);
    expect(reservations[0].status).toBe("ACTIVE");
    expect(reservations[1].status).toBe("ACTIVE");

    const caseRow = db.prepare("SELECT workflow_status FROM repair_cases WHERE id = ?").get(caseId) as { workflow_status: string };
    expect(caseRow.workflow_status).toBe("EM_SEPARACAO");
  });

  it("não reserva duas vezes o mesmo part_request", () => {
    const caseId = seedRepairCase(db, "IMEI-002");
    const pr1 = seedPartRequest(db, caseId, "BATERIA-X");
    seedStock(db, "bateria-x", 5);

    reserveKit(db, caseId, [
      { partRequestId: pr1, chavePeca: "BATERIA-X", reference: null, quantity: 1, availableQty: 5 },
    ], null);

    expect(() =>
      reserveKit(db, caseId, [
        { partRequestId: pr1, chavePeca: "BATERIA-X", reference: null, quantity: 1, availableQty: 4 },
      ], null)
    ).toThrow(ReservationError);
  });

  it("saldo alterado aborta reserva de kit com STOCK_CHANGED", () => {
    const caseId = seedRepairCase(db, "IMEI-003");
    const pr1 = seedPartRequest(db, caseId, "FLEX-Y");
    const pr2 = seedPartRequest(db, caseId, "FLEX-Y");

    // Only 1 in stock, but we pretend we have 2
    seedStock(db, "flex-y", 1);

    expect(() =>
      reserveKit(db, caseId, [
        { partRequestId: pr1, chavePeca: "FLEX-Y", reference: null, quantity: 1, availableQty: 2 },
        { partRequestId: pr2, chavePeca: "FLEX-Y", reference: null, quantity: 1, availableQty: 1 },
      ], null)
    ).toThrow(ReservationError);
  });

  it("físico não muda na reserva (só reservedQuantity aumenta)", () => {
    const caseId = seedRepairCase(db, "IMEI-004");
    const pr1 = seedPartRequest(db, caseId, "CONECTOR-Z");
    seedStock(db, "conector-z", 3);

    const qtyBefore = getReservedQuantity(db, "conector-z");
    expect(qtyBefore).toBe(0);

    reserveKit(db, caseId, [
      { partRequestId: pr1, chavePeca: "CONECTOR-Z", reference: null, quantity: 1, availableQty: 3 },
    ], null);

    const qtyAfter = getReservedQuantity(db, "conector-z");
    expect(qtyAfter).toBe(1);

    // No stock_movement was created for a reservation (physical unchanged)
    const moves = db.prepare(
      "SELECT COUNT(*) AS c FROM stock_movements WHERE chave_peca_norm = 'conector-z' AND movement_type != 'INITIAL_BALANCE'"
    ).get() as { c: number };
    expect(moves.c).toBe(0);
  });
});

describe("reservePartial", () => {
  it("parcial reserva somente disponível — pula peças sem saldo", () => {
    const caseId = seedRepairCase(db, "IMEI-005");
    const pr1 = seedPartRequest(db, caseId, "TELA-B");
    const pr2 = seedPartRequest(db, caseId, "CHIP-Q"); // não tem estoque

    seedStock(db, "tela-b", 2);
    // chip-q não tem estoque

    const reservations = reservePartial(db, caseId, [
      { partRequestId: pr1, chavePeca: "TELA-B", reference: null, quantity: 1 },
      { partRequestId: pr2, chavePeca: "CHIP-Q", reference: null, quantity: 1 },
    ], null);

    expect(reservations).toHaveLength(1);
    expect(reservations[0].chavePeca).toBe("TELA-B");
  });
});

describe("releaseReservation", () => {
  it("cancelar devolve saldo (reservedQuantity zera)", () => {
    const caseId = seedRepairCase(db, "IMEI-006");
    const pr1 = seedPartRequest(db, caseId, "VISOR-C");
    seedStock(db, "visor-c", 2);

    reserveKit(db, caseId, [
      { partRequestId: pr1, chavePeca: "VISOR-C", reference: null, quantity: 1, availableQty: 2 },
    ], null);

    expect(getReservedQuantity(db, "visor-c")).toBe(1);

    releaseReservation(db, pr1, { reason: "Peça trocada por modelo correto", userId: null });

    expect(getReservedQuantity(db, "visor-c")).toBe(0);

    // part_request should revert to PEDIR_PECA
    const pr = db.prepare("SELECT status FROM part_requests WHERE id = ?").get(pr1) as { status: string };
    expect(pr.status).toBe("PEDIR_PECA");
  });

  it("razão obrigatória — lança ReservationError sem motivo", () => {
    const caseId = seedRepairCase(db, "IMEI-007");
    const pr1 = seedPartRequest(db, caseId, "FLEX-W");
    seedStock(db, "flex-w", 2);

    reserveKit(db, caseId, [
      { partRequestId: pr1, chavePeca: "FLEX-W", reference: null, quantity: 1, availableQty: 2 },
    ], null);

    expect(() => releaseReservation(db, pr1, { reason: "ab", userId: null }))
      .toThrow(ReservationError);

    expect(() => releaseReservation(db, pr1, { reason: "", userId: null }))
      .toThrow(ReservationError);
  });
});

describe("consumeReservation", () => {
  it("consumo reduz físico (cria REPAIR_CONSUMPTION) e marca status CONSUMED", () => {
    const caseId = seedRepairCase(db, "IMEI-008");
    const pr1 = seedPartRequest(db, caseId, "BOTAO-D");
    seedStock(db, "botao-d", 2);

    const [reservation] = reserveKit(db, caseId, [
      { partRequestId: pr1, chavePeca: "BOTAO-D", reference: null, quantity: 1, availableQty: 2 },
    ], null);

    consumeReservation(db, reservation.id, null);

    const res = getReservationByPartRequest(db, pr1);
    expect(res).toBeNull(); // no longer ACTIVE

    const consumed = db.prepare(
      "SELECT * FROM operational_reservations WHERE id = ?"
    ).get(reservation.id) as { status: string };
    expect(consumed.status).toBe("CONSUMED");

    // A REPAIR_CONSUMPTION movement should exist
    const move = db.prepare(
      "SELECT * FROM stock_movements WHERE movement_type = 'REPAIR_CONSUMPTION' AND chave_peca_norm = 'botao-d'"
    ).get() as { quantity: number } | undefined;
    expect(move).toBeDefined();
    expect(move!.quantity).toBe(-1);
  });
});
