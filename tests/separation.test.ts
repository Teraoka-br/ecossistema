/**
 * Testes da fase de separação operacional.
 *
 * Usa banco em memória isolado (nunca toca data/app.sqlite).
 * Cada describe-block cria seu próprio banco via openDatabase(":memory:") + runMigrations.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Db } from "../src/db/database.js";
import { deriveBatchStatus, countItemStatuses } from "../src/separation/separation-status.js";
import type { SeparationItemStatus } from "../src/separation/separation-types.js";
import {
  createSeparationBatch,
  confirmPartialItem,
  confirmFullDevice,
  confirmAll,
  cancelPartialItem,
  cancelBatch,
  getBatchState,
  SeparationError,
} from "../src/separation/separation-service.js";
import { getCurrentOperationalStock } from "../src/operational/stock-service.js";
import { computeCurrentFingerprint } from "../src/match/match-fingerprint.js";

// ---------------------------------------------------------------------------
// Helpers de semeadura
// ---------------------------------------------------------------------------

function seedBase(db: Db): { batchId: number; ruleId: number } {
  // import_batch
  const batchRes = db
    .prepare(
      `INSERT INTO import_batches (analysis_file_name, orders_file_name, analysis_file_hash, orders_file_hash, status)
       VALUES ('a.xlsx', 'o.xlsx', 'ah', 'oh', 'COMPLETED')`,
    )
    .run();
  const batchId = batchRes.lastInsertRowid as number;

  // system_state (migration 005 já inseriu (id=1, initialized=0); basta atualizar)
  db.prepare(
    `UPDATE system_state SET initialized=1, initial_import_batch_id=?, initialized_at=datetime('now'), initialized_by='teste' WHERE id=1`,
  ).run(batchId);

  // decision_rule — migration 001 já inseriu a regra padrão com active=1; usa ela
  const rule = db
    .prepare("SELECT id FROM decision_rules WHERE active=1 ORDER BY id LIMIT 1")
    .get() as { id: number };
  const ruleId = rule.id;

  return { batchId, ruleId };
}

function seedInventory(db: Db, batchId: number, items: { ref: string; refNorm: string; chave: string; chaveNorm: string; qty: number }[]) {
  for (const it of items) {
    for (let i = 0; i < it.qty; i++) {
      db.prepare(
        `INSERT INTO source_inventory_items (import_batch_id, referencia, referencia_norm, chave_peca, chave_peca_norm, status_fisico, raw_json)
         VALUES (?, ?, ?, ?, ?, 'DISPONÍVEL', '{}')`,
      ).run(batchId, it.ref, it.refNorm, it.chave, it.chaveNorm);
    }
  }
}

function seedOrderPart(db: Db, batchId: number, idPedido: string, imei: string | null = null): number {
  const r = db
    .prepare(
      `INSERT INTO source_order_parts (import_batch_id, id_pedido, imei, concat_peca, status_atual_legado, raw_json)
       VALUES (?, ?, ?, 'TELA IPHONE 13', 'MATCH', '{}')`,
    )
    .run(batchId, idPedido, imei);
  return r.lastInsertRowid as number;
}

interface MatchRunSeed {
  inputHash: string;
  ruleId: number;
  batchId: number;
}

function seedMatchRun(db: Db, seed: MatchRunSeed): number {
  const r = db
    .prepare(
      `INSERT INTO match_runs
         (import_batch_id, decision_rule_id, algorithm_version, status, input_hash,
          created_by, started_at, finished_at,
          stock_base_type, stock_usable_units, stock_total_units, stock_unmapped_units,
          stock_cutoff_movement_id, stock_max_movement_id)
       VALUES (?, ?, '1', 'COMPLETED', ?, '(teste)', datetime('now'), datetime('now'),
               'INITIAL_IMPORT', 2, 2, 0, 0, 0)`,
    )
    .run(seed.batchId, seed.ruleId, seed.inputHash);
  return r.lastInsertRowid as number;
}

function seedDevice(db: Db, runId: number, imei: string, phase: string = "FULL"): number {
  const r = db
    .prepare(
      `INSERT INTO match_device_results
         (match_run_id, device_key, imei, allocation_phase, kit_status,
          total_parts, open_parts, score)
       VALUES (?, ?, ?, ?, 'KIT POSSIVEL', 1, 1, 5)`,
    )
    .run(runId, imei, imei, phase);
  return r.lastInsertRowid as number;
}

function seedMatchResult(
  db: Db,
  opts: {
    runId: number;
    sourceOrderPartId: number;
    deviceResultId: number | null;
    idPedido: string;
    imei: string | null;
    chavePecaNorm: string;
    refNorm: string;
    phase: string;
    status: string;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO match_results
         (match_run_id, source_order_part_id, device_result_id, id_pedido, imei,
          chave_peca, chave_peca_norm, allocated_reference, allocated_reference_norm,
          result_status, result_status_label, allocation_phase, reserved_units,
          stock_for_key_initial, effective_status_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 2, 'MATCH')`,
    )
    .run(
      opts.runId,
      opts.sourceOrderPartId,
      opts.deviceResultId,
      opts.idPedido,
      opts.imei,
      "TELA 13",
      opts.chavePecaNorm,
      "PC-REF01",
      opts.refNorm,
      opts.status,
      opts.status === "MATCH" ? "MATCH" : "MATCH PARCIAL",
      opts.phase,
    );
  return r.lastInsertRowid as number;
}

/** Cria um banco completo com um run FULL pronto para separação. */
function buildFullKitDb(): { db: Db; runId: number; deviceId: number; resultId: number; orderPartId: number } {
  const db = openDatabase(":memory:");
  runMigrations(db);

  const { batchId, ruleId } = seedBase(db);
  seedInventory(db, batchId, [{ ref: "PC-REF01", refNorm: "PC-REF01", chave: "TELA 13", chaveNorm: "TELA 13", qty: 3 }]);
  const orderPartId = seedOrderPart(db, batchId, "PED-001", "IMEI-001");

  // Compute fingerprint BEFORE inserting the run
  const { hash } = computeCurrentFingerprint(db);
  const runId = seedMatchRun(db, { inputHash: hash, ruleId, batchId });
  const deviceId = seedDevice(db, runId, "IMEI-001", "FULL");
  const resultId = seedMatchResult(db, {
    runId,
    sourceOrderPartId: orderPartId,
    deviceResultId: deviceId,
    idPedido: "PED-001",
    imei: "IMEI-001",
    chavePecaNorm: "TELA 13",
    refNorm: "PC-REF01",
    phase: "FULL",
    status: "MATCH",
  });

  return { db, runId, deviceId, resultId, orderPartId };
}

/** Cria um banco completo com um run PARTIAL pronto para separação. */
function buildPartialDb(): { db: Db; runId: number; resultId: number; orderPartId: number } {
  const db = openDatabase(":memory:");
  runMigrations(db);

  const { batchId, ruleId } = seedBase(db);
  seedInventory(db, batchId, [{ ref: "PC-REF01", refNorm: "PC-REF01", chave: "TELA 13", chaveNorm: "TELA 13", qty: 3 }]);
  const orderPartId = seedOrderPart(db, batchId, "PED-002", "IMEI-002");

  const { hash } = computeCurrentFingerprint(db);
  const runId = seedMatchRun(db, { inputHash: hash, ruleId, batchId });
  // Partial lines don't have a device result (or have one with PARTIAL phase)
  const resultId = seedMatchResult(db, {
    runId,
    sourceOrderPartId: orderPartId,
    deviceResultId: null,
    idPedido: "PED-002",
    imei: "IMEI-002",
    chavePecaNorm: "TELA 13",
    refNorm: "PC-REF01",
    phase: "PARTIAL",
    status: "MATCH PARCIAL",
  });

  return { db, runId, resultId, orderPartId };
}

// ---------------------------------------------------------------------------
// deriveBatchStatus (pura)
// ---------------------------------------------------------------------------

describe("countItemStatuses", () => {
  it("conta corretamente vários status", () => {
    const counts = countItemStatuses(["RESERVED", "RESERVED", "CONFIRMED", "CANCELLED"] as SeparationItemStatus[]);
    expect(counts.reserved).toBe(2);
    expect(counts.confirmed).toBe(1);
    expect(counts.cancelled).toBe(1);
  });

  it("retorna zeros para lista vazia", () => {
    expect(countItemStatuses([])).toEqual({ reserved: 0, confirmed: 0, cancelled: 0 });
  });
});

describe("deriveBatchStatus", () => {
  it("lista vazia → CANCELLED", () => {
    expect(deriveBatchStatus([])).toBe("CANCELLED");
  });

  it("todos RESERVED e nenhum confirmado → OPEN", () => {
    expect(deriveBatchStatus(["RESERVED", "RESERVED"])).toBe("OPEN");
  });

  it("todos CONFIRMED → COMPLETED", () => {
    expect(deriveBatchStatus(["CONFIRMED", "CONFIRMED"])).toBe("COMPLETED");
  });

  it("todos CANCELLED e nenhum confirmado → CANCELLED", () => {
    expect(deriveBatchStatus(["CANCELLED", "CANCELLED"])).toBe("CANCELLED");
  });

  it("mix confirmado + reservado → PARTIALLY_COMPLETED", () => {
    expect(deriveBatchStatus(["CONFIRMED", "RESERVED"])).toBe("PARTIALLY_COMPLETED");
  });

  it("mix confirmado + cancelado → PARTIALLY_COMPLETED", () => {
    expect(deriveBatchStatus(["CONFIRMED", "CANCELLED"])).toBe("PARTIALLY_COMPLETED");
  });

  it("um único RESERVED → OPEN", () => {
    expect(deriveBatchStatus(["RESERVED"])).toBe("OPEN");
  });

  it("um único CONFIRMED → COMPLETED", () => {
    expect(deriveBatchStatus(["CONFIRMED"])).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// createSeparationBatch — validações de entrada
// ---------------------------------------------------------------------------

describe("createSeparationBatch — validações", () => {
  let db: Db;
  let runId: number;
  let deviceId: number;
  let resultId: number;

  beforeEach(() => {
    ({ db, runId, deviceId, resultId } = buildFullKitDb());
  });

  it("lança SeparationError 400 se createdBy vazio", () => {
    expect(() =>
      createSeparationBatch(db, {
        createdBy: "",
        matchRunId: runId,
        idempotencyKey: "key1",
        fullDeviceResultIds: [deviceId],
        partialMatchResultIds: [],
      }),
    ).toThrow(SeparationError);
  });

  it("lança SeparationError 400 se idempotencyKey vazio", () => {
    expect(() =>
      createSeparationBatch(db, {
        createdBy: "teste",
        matchRunId: runId,
        idempotencyKey: "",
        fullDeviceResultIds: [deviceId],
        partialMatchResultIds: [],
      }),
    ).toThrow(SeparationError);
  });

  it("lança SeparationError 400 se nenhum item selecionado", () => {
    expect(() =>
      createSeparationBatch(db, {
        createdBy: "teste",
        matchRunId: runId,
        idempotencyKey: "key1",
        fullDeviceResultIds: [],
        partialMatchResultIds: [],
      }),
    ).toThrow(SeparationError);
  });

  it("lança SeparationError 404 se matchRunId não existe", () => {
    expect(() =>
      createSeparationBatch(db, {
        createdBy: "teste",
        matchRunId: 9999,
        idempotencyKey: "key1",
        fullDeviceResultIds: [deviceId],
        partialMatchResultIds: [],
      }),
    ).toThrow(SeparationError);
  });

  it("lança SeparationError 422 se device não pertence ao run", () => {
    // Criar outro run para confundir
    const { db: db2, runId: runId2, deviceId: deviceId2 } = buildFullKitDb();
    // Tentar usar deviceId2 (de outro banco) é improvável de ocorrer em prod,
    // então testamos com device_id que tem run_id diferente inserido manualmente
    const otherRunRes = db
      .prepare(
        `INSERT INTO match_runs (import_batch_id, decision_rule_id, algorithm_version, status, input_hash,
          created_by, started_at, finished_at, stock_base_type, stock_usable_units, stock_total_units,
          stock_unmapped_units, stock_cutoff_movement_id, stock_max_movement_id)
         VALUES (1, 1, '1', 'COMPLETED', 'fakehash2', '(teste)', datetime('now'), datetime('now'),
                 'INITIAL_IMPORT', 0, 0, 0, 0, 0)`,
      )
      .run();
    const otherRunId = otherRunRes.lastInsertRowid as number;
    const otherDevRes = db
      .prepare(
        `INSERT INTO match_device_results (match_run_id, device_key, imei, allocation_phase, kit_status, total_parts, open_parts, score)
         VALUES (?, 'IMEI-999', 'IMEI-999', 'FULL', 'KIT POSSIVEL', 1, 1, 5)`,
      )
      .run(otherRunId);
    const otherDevId = otherDevRes.lastInsertRowid as number;
    db2.close();

    expect(() =>
      createSeparationBatch(db, {
        createdBy: "teste",
        matchRunId: runId,
        idempotencyKey: "key-mismatch",
        fullDeviceResultIds: [otherDevId],
        partialMatchResultIds: [],
      }),
    ).toThrow(SeparationError);
  });

  it("retorna lote existente em segunda chamada com mesma idempotencyKey (idempotência)", () => {
    const b1 = createSeparationBatch(db, {
      createdBy: "teste",
      matchRunId: runId,
      idempotencyKey: "idem-key-1",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    const b2 = createSeparationBatch(db, {
      createdBy: "teste",
      matchRunId: runId,
      idempotencyKey: "idem-key-1",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    expect(b1.id).toBe(b2.id);
    expect(b1.batch_number).toBe(b2.batch_number);
  });
});

// ---------------------------------------------------------------------------
// createSeparationBatch — criação de kit FULL
// ---------------------------------------------------------------------------

describe("createSeparationBatch — kit FULL", () => {
  it("cria lote com número SEP-AAAAMMDD-0001 e itens RESERVED", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const batch = createSeparationBatch(db, {
      createdBy: "operador",
      matchRunId: runId,
      idempotencyKey: "key-full-1",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });

    expect(batch.batch_number).toMatch(/^SEP-\d{8}-\d{4}$/);
    expect(batch.status).toBe("OPEN");
    expect(batch.created_by).toBe("operador");

    // Verifica itens no banco
    const items = db
      .prepare("SELECT * FROM separation_items WHERE separation_batch_id = ?")
      .all(batch.id) as { status: string; id_pedido: string; match_allocation_phase: string }[];
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("RESERVED");
    expect(items[0].id_pedido).toBe("PED-001");
    expect(items[0].match_allocation_phase).toBe("FULL");
  });

  it("reserva lógica reduz availableQuantity sem alterar currentQuantity", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const before = getCurrentOperationalStock(db);
    const beforeGroup = before.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(beforeGroup.currentQuantity).toBe(3);
    expect(beforeGroup.reservedQuantity).toBe(0);
    expect(beforeGroup.availableQuantity).toBe(3);

    createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-reserve",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });

    const after = getCurrentOperationalStock(db);
    const afterGroup = after.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(afterGroup.currentQuantity).toBe(3);   // físico não muda
    expect(afterGroup.reservedQuantity).toBe(1);  // reserva lógica
    expect(afterGroup.availableQuantity).toBe(2); // disponível reduz
  });

  it("impede segunda reserva do mesmo id_pedido (índice único ativo)", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-dup-1",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    expect(() =>
      createSeparationBatch(db, {
        createdBy: "op",
        matchRunId: runId,
        idempotencyKey: "key-dup-2",
        fullDeviceResultIds: [deviceId],
        partialMatchResultIds: [],
      }),
    ).toThrow(SeparationError);
  });

  it("batch number segue formato SEP-AAAAMMDD-0001 e começa em 0001", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const b1 = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "k1",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    // formato: SEP-YYYYMMDD-0001
    const parts = b1.batch_number.split("-");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("SEP");
    expect(parts[1]).toMatch(/^\d{8}$/);
    expect(parts[2]).toBe("0001");
  });
});

// ---------------------------------------------------------------------------
// createSeparationBatch — linha PARTIAL
// ---------------------------------------------------------------------------

describe("createSeparationBatch — linha PARTIAL", () => {
  it("cria lote com item PARTIAL RESERVED", () => {
    const { db, runId, resultId } = buildPartialDb();
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-partial-1",
      fullDeviceResultIds: [],
      partialMatchResultIds: [resultId],
    });
    expect(batch.status).toBe("OPEN");
    const items = db
      .prepare("SELECT * FROM separation_items WHERE separation_batch_id = ?")
      .all(batch.id) as { match_allocation_phase: string; id_pedido: string }[];
    expect(items[0].match_allocation_phase).toBe("PARTIAL");
    expect(items[0].id_pedido).toBe("PED-002");
  });

  it("lança SeparationError 422 se match_result não é PARTIAL", () => {
    const { db, runId, resultId } = buildFullKitDb();
    expect(() =>
      createSeparationBatch(db, {
        createdBy: "op",
        matchRunId: runId,
        idempotencyKey: "key-partial-bad",
        fullDeviceResultIds: [],
        partialMatchResultIds: [resultId], // Este é FULL
      }),
    ).toThrow(SeparationError);
  });
});

// ---------------------------------------------------------------------------
// Estoque insuficiente
// ---------------------------------------------------------------------------

describe("createSeparationBatch — estoque insuficiente", () => {
  it("lança SeparationError 422 quando availableQuantity < 1", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);

    const { batchId, ruleId } = seedBase(db);
    // Nenhum item de inventário → estoque = 0
    const orderPartId = seedOrderPart(db, batchId, "PED-ZERO", "IMEI-ZERO");

    const { hash } = computeCurrentFingerprint(db);
    const runId = seedMatchRun(db, { inputHash: hash, ruleId, batchId });
    const devId = seedDevice(db, runId, "IMEI-ZERO", "FULL");
    seedMatchResult(db, {
      runId,
      sourceOrderPartId: orderPartId,
      deviceResultId: devId,
      idPedido: "PED-ZERO",
      imei: "IMEI-ZERO",
      chavePecaNorm: "TELA 13",
      refNorm: "PC-REF01",
      phase: "FULL",
      status: "MATCH",
    });

    expect(() =>
      createSeparationBatch(db, {
        createdBy: "op",
        matchRunId: runId,
        idempotencyKey: "key-zero",
        fullDeviceResultIds: [devId],
        partialMatchResultIds: [],
      }),
    ).toThrow(SeparationError);
  });
});

// ---------------------------------------------------------------------------
// Confirmar item parcial
// ---------------------------------------------------------------------------

describe("confirmPartialItem", () => {
  let db: Db;
  let batchId: number;
  let itemId: number;

  beforeEach(() => {
    const setup = buildPartialDb();
    db = setup.db;
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: setup.runId,
      idempotencyKey: "key-p-confirm",
      fullDeviceResultIds: [],
      partialMatchResultIds: [setup.resultId],
    });
    batchId = batch.id;
    const items = db
      .prepare("SELECT id FROM separation_items WHERE separation_batch_id = ?")
      .all(batchId) as { id: number }[];
    itemId = items[0].id;
  });

  it("confirma item RESERVED → CONFIRMED", () => {
    const item = confirmPartialItem(db, {
      itemId,
      confirmedBy: "fulano",
      idempotencyKey: "conf-key-1",
    });
    expect(item.status).toBe("CONFIRMED");
    expect(item.confirmed_by).toBe("fulano");
  });

  it("cria REPAIR_CONSUMPTION movement (quantity = -1)", () => {
    confirmPartialItem(db, { itemId, confirmedBy: "fulano", idempotencyKey: "conf-key-2" });
    const mov = db
      .prepare("SELECT * FROM stock_movements WHERE source_type = 'SEPARATION_ITEM' AND source_item_id = ?")
      .get(itemId) as { quantity: number; movement_type: string } | undefined;
    expect(mov).toBeDefined();
    expect(mov!.movement_type).toBe("REPAIR_CONSUMPTION");
    expect(mov!.quantity).toBe(-1);
  });

  it("cria operational_event PART_SEPARATED", () => {
    confirmPartialItem(db, { itemId, confirmedBy: "fulano", idempotencyKey: "conf-key-3" });
    const ev = db
      .prepare("SELECT * FROM operational_events WHERE event_type = 'PART_SEPARATED' AND entity_id = ?")
      .get("PED-002") as { new_status: string } | undefined;
    expect(ev).toBeDefined();
    expect(ev!.new_status).toBe("SEPARADO");
  });

  it("reduz currentQuantity do estoque físico em -1", () => {
    const before = getCurrentOperationalStock(db);
    const beforeGroup = before.groups.find((g) => g.chavePecaNorm === "TELA 13")!;

    confirmPartialItem(db, { itemId, confirmedBy: "fulano", idempotencyKey: "conf-key-4" });

    const after = getCurrentOperationalStock(db);
    const afterGroup = after.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(afterGroup.currentQuantity).toBe(beforeGroup.currentQuantity - 1); // 3→2
    expect(afterGroup.reservedQuantity).toBe(0); // reserva liberada
    // available = physical - reserved = 2 - 0 = 2; before was also 2 (3-1), so unchanged
    expect(afterGroup.availableQuantity).toBe(beforeGroup.currentQuantity - 1);
  });

  it("lança SeparationError 409 se confirmar novamente com nova idempotencyKey", () => {
    confirmPartialItem(db, { itemId, confirmedBy: "fulano", idempotencyKey: "conf-key-5" });
    expect(() =>
      confirmPartialItem(db, { itemId, confirmedBy: "fulano", idempotencyKey: "conf-key-diferente" }),
    ).toThrow(SeparationError);
  });

  it("retorna idempotentemente se usar mesma idempotencyKey", () => {
    const c1 = confirmPartialItem(db, { itemId, confirmedBy: "fulano", idempotencyKey: "conf-idem-key" });
    const c2 = confirmPartialItem(db, { itemId, confirmedBy: "fulano", idempotencyKey: "conf-idem-key" });
    expect(c1.id).toBe(c2.id);
    expect(c2.status).toBe("CONFIRMED");
  });

  it("lança SeparationError 400 se confirmedBy vazio", () => {
    expect(() =>
      confirmPartialItem(db, { itemId, confirmedBy: "", idempotencyKey: "conf-key-empty" }),
    ).toThrow(SeparationError);
  });

  it("atualiza status do lote para COMPLETED quando todos confirmados", () => {
    confirmPartialItem(db, { itemId, confirmedBy: "fulano", idempotencyKey: "conf-key-6" });
    const batch = db
      .prepare("SELECT status FROM separation_batches WHERE id = ?")
      .get(batchId) as { status: string };
    expect(batch.status).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// confirmFullDevice
// ---------------------------------------------------------------------------

describe("confirmFullDevice", () => {
  let db: Db;
  let batchId: number;
  let deviceId: number;
  let runId: number;

  beforeEach(() => {
    const setup = buildFullKitDb();
    db = setup.db;
    deviceId = setup.deviceId;
    runId = setup.runId;
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-full-conf",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    batchId = batch.id;
  });

  it("confirma todos os itens do aparelho", () => {
    confirmFullDevice(db, { batchId, deviceResultId: deviceId, confirmedBy: "op", idempotencyKey: "conf-full-key-1" });
    const items = db
      .prepare("SELECT status FROM separation_items WHERE separation_batch_id = ?")
      .all(batchId) as { status: string }[];
    expect(items.every((i) => i.status === "CONFIRMED")).toBe(true);
  });

  it("atualiza batch para COMPLETED após confirmar dispositivo completo", () => {
    confirmFullDevice(db, { batchId, deviceResultId: deviceId, confirmedBy: "op", idempotencyKey: "conf-full-key-2" });
    const batch = db
      .prepare("SELECT status FROM separation_batches WHERE id = ?")
      .get(batchId) as { status: string };
    expect(batch.status).toBe("COMPLETED");
  });

  it("cria movement de REPAIR_CONSUMPTION para cada item", () => {
    confirmFullDevice(db, { batchId, deviceResultId: deviceId, confirmedBy: "op", idempotencyKey: "conf-full-key-3" });
    const movs = db
      .prepare("SELECT * FROM stock_movements WHERE movement_type = 'REPAIR_CONSUMPTION'")
      .all() as { quantity: number }[];
    expect(movs.length).toBeGreaterThan(0);
    expect(movs.every((m) => m.quantity === -1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// confirmAll
// ---------------------------------------------------------------------------

describe("confirmAll", () => {
  it("confirma todos os itens reservados do lote", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-all",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    confirmAll(db, { batchId: batch.id, confirmedBy: "gestor", idempotencyKey: "conf-all-1" });
    const updated = db
      .prepare("SELECT status FROM separation_batches WHERE id = ?")
      .get(batch.id) as { status: string };
    expect(updated.status).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// cancelPartialItem
// ---------------------------------------------------------------------------

describe("cancelPartialItem", () => {
  let db: Db;
  let batchId: number;
  let itemId: number;

  beforeEach(() => {
    const setup = buildPartialDb();
    db = setup.db;
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: setup.runId,
      idempotencyKey: "key-p-cancel",
      fullDeviceResultIds: [],
      partialMatchResultIds: [setup.resultId],
    });
    batchId = batch.id;
    const items = db
      .prepare("SELECT id FROM separation_items WHERE separation_batch_id = ?")
      .all(batchId) as { id: number }[];
    itemId = items[0].id;
  });

  it("cancela item RESERVED → CANCELLED", () => {
    const item = cancelPartialItem(db, { itemId, cancelledBy: "fulano", cancelReason: "motivo longo suficiente para o teste" });
    expect(item.status).toBe("CANCELLED");
    expect(item.cancelled_by).toBe("fulano");
  });

  it("libera reserva: reservedQuantity volta a 0", () => {
    const before = getCurrentOperationalStock(db);
    const beforeGroup = before.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(beforeGroup.reservedQuantity).toBe(1);

    cancelPartialItem(db, { itemId, cancelledBy: "fulano", cancelReason: "motivo longo suficiente para o teste" });

    const after = getCurrentOperationalStock(db);
    const afterGroup = after.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(afterGroup.reservedQuantity).toBe(0);
    expect(afterGroup.availableQuantity).toBe(afterGroup.currentQuantity); // tudo disponível novamente
  });

  it("não cria movement de estoque no cancelamento", () => {
    cancelPartialItem(db, { itemId, cancelledBy: "fulano", cancelReason: "motivo longo suficiente para o teste" });
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM stock_movements WHERE movement_type = 'REPAIR_CONSUMPTION'")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("atualiza batch para CANCELLED quando todos cancelados", () => {
    cancelPartialItem(db, { itemId, cancelledBy: "fulano", cancelReason: "motivo longo suficiente para o teste" });
    const batch = db
      .prepare("SELECT status FROM separation_batches WHERE id = ?")
      .get(batchId) as { status: string };
    expect(batch.status).toBe("CANCELLED");
  });

  it("retorna idempotentemente se item já CANCELLED", () => {
    const c1 = cancelPartialItem(db, { itemId, cancelledBy: "fulano", cancelReason: "motivo longo suficiente para o teste" });
    const c2 = cancelPartialItem(db, { itemId, cancelledBy: "fulano", cancelReason: "outro motivo longo suficiente" });
    expect(c1.id).toBe(c2.id);
    expect(c2.status).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// cancelBatch
// ---------------------------------------------------------------------------

describe("cancelBatch", () => {
  it("cancela todos os itens RESERVED e o lote", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-cancel-batch",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    cancelBatch(db, { batchId: batch.id, cancelledBy: "gestor", cancelReason: "motivo obrigatorio longo" });
    const updated = db
      .prepare("SELECT status FROM separation_batches WHERE id = ?")
      .get(batch.id) as { status: string };
    expect(updated.status).toBe("CANCELLED");
  });

  it("retorna idempotentemente se lote já CANCELLED", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-cancel-twice",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    const b1 = cancelBatch(db, { batchId: batch.id, cancelledBy: "gestor", cancelReason: "motivo obrigatorio longo" });
    const b2 = cancelBatch(db, { batchId: batch.id, cancelledBy: "gestor", cancelReason: "motivo obrigatorio longo" });
    expect(b1.id).toBe(b2.id);
    expect(b2.status).toBe("CANCELLED");
  });

  it("não altera itens confirmados quando tenta cancelar lote COMPLETED", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-cancel-completed",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    confirmAll(db, { batchId: batch.id, confirmedBy: "op", idempotencyKey: "conf-before-cancel" });
    cancelBatch(db, { batchId: batch.id, cancelledBy: "gestor", cancelReason: "nao pode cancelar completed" });
    // Batch ainda COMPLETED porque não havia itens RESERVED para cancelar
    const updated = db
      .prepare("SELECT status FROM separation_batches WHERE id = ?")
      .get(batch.id) as { status: string };
    expect(updated.status).toBe("COMPLETED");
  });

  it("libera reservas ao cancelar", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-cancel-reserve",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    const before = getCurrentOperationalStock(db);
    const beforeGroup = before.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(beforeGroup.reservedQuantity).toBe(1);

    cancelBatch(db, { batchId: batch.id, cancelledBy: "gestor", cancelReason: "motivo obrigatorio longo" });

    const after = getCurrentOperationalStock(db);
    const afterGroup = after.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(afterGroup.reservedQuantity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getBatchState
// ---------------------------------------------------------------------------

describe("getBatchState", () => {
  it("retorna estado detalhado do lote com items e totais", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-state",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    const state = getBatchState(db, batch.id);
    expect(state.batch.id).toBe(batch.id);
    expect(state.totals.totalItems).toBe(1);
    expect(state.totals.reservedItems).toBe(1);
    expect(state.totals.confirmedItems).toBe(0);
    expect(state.totals.cancelledItems).toBe(0);
    expect(state.devices).toHaveLength(1);
    expect(state.partialItems).toHaveLength(0);
  });

  it("atualiza totais após confirmação do aparelho completo", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-state-conf",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    confirmFullDevice(db, { batchId: batch.id, deviceResultId: deviceId, confirmedBy: "op", idempotencyKey: "conf-state" });
    const state = getBatchState(db, batch.id);
    expect(state.totals.confirmedItems).toBe(1);
    expect(state.totals.reservedItems).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stock service — reservedQuantity e availableQuantity
// ---------------------------------------------------------------------------

describe("getCurrentOperationalStock — reservas", () => {
  it("sem reservas: reservedQuantity=0, availableQuantity=currentQuantity", () => {
    const { db } = buildFullKitDb();
    const stock = getCurrentOperationalStock(db);
    const g = stock.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(g.reservedQuantity).toBe(0);
    expect(g.availableQuantity).toBe(g.currentQuantity);
  });

  it("com reserva: availableQuantity = currentQuantity - reservedQuantity", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-reserve-stock",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    const stock = getCurrentOperationalStock(db);
    const g = stock.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(g.reservedQuantity).toBe(1);
    expect(g.availableQuantity).toBe(g.currentQuantity - g.reservedQuantity);
    expect(g.availableQuantity).toBeGreaterThanOrEqual(0);
  });

  it("após confirmação: currentQuantity reduz, reservedQuantity volta a 0", () => {
    const { db, runId, deviceId } = buildFullKitDb();
    const batch = createSeparationBatch(db, {
      createdBy: "op",
      matchRunId: runId,
      idempotencyKey: "key-confirm-stock",
      fullDeviceResultIds: [deviceId],
      partialMatchResultIds: [],
    });
    confirmFullDevice(db, { batchId: batch.id, deviceResultId: deviceId, confirmedBy: "op", idempotencyKey: "conf-stock" });

    const stock = getCurrentOperationalStock(db);
    const g = stock.groups.find((g) => g.chavePecaNorm === "TELA 13")!;
    expect(g.currentQuantity).toBe(2); // era 3, consumiu 1
    expect(g.reservedQuantity).toBe(0);
    expect(g.availableQuantity).toBe(2);
  });
});
