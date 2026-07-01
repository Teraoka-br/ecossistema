import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { preview, confirm } from "../src/import/import-service.js";
import * as repo from "../src/db/repository.js";
import {
  activeBatchId,
  distinctOrderStatuses,
  groupByDevice,
  inventoryTotalUnits,
  listInventoryGroups,
  listOrderParts,
} from "../src/db/queries.js";
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
  vi.restoreAllMocks();
  while (created.length) cleanup(created.pop()!);
});

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

function buildPair(orders: unknown[][], inventory: unknown[][], quotations: unknown[][]) {
  const ordersPath = makeXlsx(
    [
      { name: "PEDIDOS", aoa: [ORDERS_HEADER, ...orders] },
      { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ...inventory] },
    ],
    "PEDIDOS.xlsx",
  );
  const analysisPath = makeXlsx(
    [
      { name: "PEÇAS A PEDIR", aoa: [QUOTATION_HEADER, ...quotations] },
      { name: "ANALISEMI", aoa: [ANALYSIS_HEADER] },
    ],
    "ANALISE MI.xlsx",
  );
  created.push(ordersPath, analysisPath);
  return {
    orders: { filePath: ordersPath, fileName: "PEDIDOS.xlsx" },
    analysis: { filePath: analysisPath, fileName: "ANALISE MI.xlsx" },
  };
}

const baseOrders = [
  orderRow({ idPedido: "PED1", imei: "111", chave: "BATERIA 13", status: "Concluído", statusKit: "KIT POSSÍVEL", custo: 50, venda: 200 }),
  orderRow({ idPedido: "PED2", imei: "222", chave: "TELA X", status: "PEDIR PEÇA", statusKit: "KIT INCOMPLETO" }),
];
const baseInventory = [
  ["PC-1", "BAT 13", "QUARTT", "BATERIA 13", "DISPONÍVEL", "PC-1"],
  ["PC-1", "BAT 13", "QUARTT", "BATERIA 13", "DISPONÍVEL", "PC-1"],
];
const baseQuotations = [["PED2", "TELA X", 3, 40, 120, "2026-06-26", "COTANDO"]];

describe("preview + confirm", () => {
  it("importa e grava o snapshot; CONCLUIDO é preservado", () => {
    const db = freshDb();
    const f = buildPair(baseOrders, baseInventory, baseQuotations);
    const pv = preview(db, f.orders, f.analysis);
    expect(pv.counts.ordersFound).toBe(2);
    expect(pv.counts.inventoryFound).toBe(2);

    const res = confirm(db, pv.previewBatchId);
    expect(res.ordersImported).toBe(2);
    expect(res.inventoryImported).toBe(2);
    expect(res.alreadyImported).toBe(false);

    const bid = activeBatchId(db)!;
    expect(distinctOrderStatuses(db, bid)).toContain("CONCLUIDO");
    const parts = listOrderParts(db, bid, { status: "CONCLUIDO" });
    expect(parts).toHaveLength(1);
    expect(inventoryTotalUnits(db, bid)).toBe(2);
    expect(listInventoryGroups(db, bid)[0]?.unidades).toBe(2);

    // Cada peça preserva seu próprio ID_PEDIDO (identidade por linha).
    const all = listOrderParts(db, bid);
    expect(new Set(all.map((p) => p.idPedido)).size).toBe(all.length);
    expect(all.every((p) => p.idPedido.length > 0)).toBe(true);
  });

  it("agrupa por IMEI mantendo um ID_PEDIDO por peça", () => {
    const db = freshDb();
    const f = buildPair(
      [
        orderRow({ idPedido: "PED-A", imei: "999", chave: "BATERIA 13", status: "PEDIR PEÇA", statusKit: "MATCH PARCIAL" }),
        orderRow({ idPedido: "PED-B", imei: "999", chave: "CARCAÇA 13", status: "PEDIR PEÇA", statusKit: "MATCH PARCIAL" }),
      ],
      baseInventory,
      [],
    );
    confirm(db, preview(db, f.orders, f.analysis).previewBatchId);
    const groups = groupByDevice(listOrderParts(db, activeBatchId(db)!));
    const dev = groups.find((g) => g.imei === "999")!;
    expect(dev.parts).toHaveLength(2);
    expect(dev.parts.map((p) => p.idPedido).sort()).toEqual(["PED-A", "PED-B"]);
  });

  it("sinaliza OS divergentes no mesmo IMEI", () => {
    const db = freshDb();
    const f = buildPair(
      [
        orderRow({ idPedido: "PED-OS1", imei: "777", os: "1001", chave: "BATERIA 13", status: "PEDIR PEÇA", statusKit: "MATCH PARCIAL" }),
        orderRow({ idPedido: "PED-OS2", imei: "777", os: "1002", chave: "CARCAÇA 13", status: "PEDIR PEÇA", statusKit: "MATCH PARCIAL" }),
      ],
      baseInventory,
      [],
    );
    confirm(db, preview(db, f.orders, f.analysis).previewBatchId);
    const groups = groupByDevice(listOrderParts(db, activeBatchId(db)!));
    const dev = groups.find((g) => g.imei === "777")!;
    expect(dev.osConflict).toBe(true);
    expect(dev.osValues.sort()).toEqual(["1001", "1002"]);
  });

  it("reimportar os mesmos arquivos não duplica (idempotência por hash)", () => {
    const db = freshDb();
    const f = buildPair(baseOrders, baseInventory, baseQuotations);
    confirm(db, preview(db, f.orders, f.analysis).previewBatchId);
    const firstCount = listOrderParts(db, activeBatchId(db)!).length;

    const pv2 = preview(db, f.orders, f.analysis);
    expect(pv2.alreadyImported).toBe(true);
    const res2 = confirm(db, pv2.previewBatchId);
    expect(res2.alreadyImported).toBe(true);
    expect(listOrderParts(db, activeBatchId(db)!).length).toBe(firstCount);
  });

  it("nova importação (arquivos diferentes) não apaga operational_events [ALLOW_LEGACY_REIMPORT=true]", () => {
    // A importação Excel agora é uma inicialização única — reimportar exige
    // ALLOW_LEGACY_REIMPORT=true (só dev/teste). Este teste verifica a
    // preservação de operational_events nesse modo, não o bloqueio em si
    // (que é coberto em tests/system-initialization.test.ts).
    const prev = process.env.ALLOW_LEGACY_REIMPORT;
    process.env.ALLOW_LEGACY_REIMPORT = "true";
    try {
      const db = freshDb();
      const f1 = buildPair(baseOrders, baseInventory, baseQuotations);
      confirm(db, preview(db, f1.orders, f1.analysis).previewBatchId);

      db.prepare(
        "INSERT INTO operational_events (entity_type, entity_id, event_type, new_status) VALUES ('ORDER_PART','PED1','CONCLUSAO','CONCLUIDO')",
      ).run();
      expect(repo.countOperationalEvents(db)).toBe(1);

      // arquivos diferentes (hash novo) => novo snapshot real
      const f2 = buildPair(
        [...baseOrders, orderRow({ idPedido: "PED3", imei: "333", chave: "DOCK", status: "MATCH", statusKit: "KIT POSSÍVEL" })],
        baseInventory,
        baseQuotations,
      );
      const res2 = confirm(db, preview(db, f2.orders, f2.analysis).previewBatchId);
      expect(res2.alreadyImported).toBe(false);
      expect(res2.ordersImported).toBe(3);
      // eventos operacionais preservados
      expect(repo.countOperationalEvents(db)).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_LEGACY_REIMPORT;
      else process.env.ALLOW_LEGACY_REIMPORT = prev;
    }
  });

  it("rollback completo quando a importação falha no meio", () => {
    const db = freshDb();
    const f = buildPair(baseOrders, baseInventory, baseQuotations);
    const pv = preview(db, f.orders, f.analysis);

    vi.spyOn(repo, "insertQuotations").mockImplementation(() => {
      throw new Error("falha forçada no insert de cotações");
    });

    expect(() => confirm(db, pv.previewBatchId)).toThrow();

    // Nada do snapshot deve ter sido persistido (transação revertida).
    const partsAny = db
      .prepare("SELECT COUNT(*) AS c FROM source_order_parts WHERE import_batch_id = ?")
      .get(pv.previewBatchId) as { c: number };
    const invAny = db
      .prepare("SELECT COUNT(*) AS c FROM source_inventory_items WHERE import_batch_id = ?")
      .get(pv.previewBatchId) as { c: number };
    expect(partsAny.c).toBe(0);
    expect(invAny.c).toBe(0);

    const batch = repo.getBatch(db, pv.previewBatchId);
    expect(batch?.status).toBe("FAILED");
    // não há lote ativo (nenhuma importação concluída)
    expect(activeBatchId(db)).toBeNull();
  });

  it("estoque agrupado separa unidade com chave e unidade sem chave da mesma referência", () => {
    const db = freshDb();
    const f = buildPair(
      baseOrders,
      [
        ["REF1", "BAT 13", "QUARTT", "BATERIA 13", "DISPONÍVEL", "REF1"], // com chave
        ["REF1", "BAT 13", "QUARTT", "", "DISPONÍVEL", "REF1"], // sem chave
      ],
      baseQuotations,
    );
    confirm(db, preview(db, f.orders, f.analysis).previewBatchId);
    const groups = listInventoryGroups(db, activeBatchId(db)!).filter((g) => g.referencia === "REF1");

    expect(groups).toHaveLength(2);
    const mapeado = groups.find((g) => g.mapeada);
    const semChave = groups.find((g) => !g.mapeada);
    expect(mapeado?.unidades).toBe(1);
    expect(mapeado?.chavePeca).toBe("BATERIA 13");
    expect(semChave?.unidades).toBe(1);
    // Unidade sem chave nunca aparece como mapeada, nem herda a chave do outro grupo.
    expect(semChave?.chavePeca).toBeNull();
    expect(semChave?.mapeada).toBe(false);
  });

  it("conflito de status entre as fontes não é fatal e conflicts_count é persistido", () => {
    const db = freshDb();
    // PEDIDOS (primário) tem PED1 com status MATCH; ANALISE MI/PEDIDOS FULL (secundário) diverge.
    const ordersPath = makeXlsx(
      [
        { name: "PEDIDOS", aoa: [ORDERS_HEADER, orderRow({ idPedido: "PED1", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })] },
        { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ["PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"]] },
      ],
      "PEDIDOS.xlsx",
    );
    const analysisPath = makeXlsx(
      [
        { name: "PEÇAS A PEDIR", aoa: [QUOTATION_HEADER] },
        { name: "PEDIDOS FULL", aoa: [ORDERS_HEADER, orderRow({ idPedido: "PED1", imei: "1", chave: "BAT", status: "PEDIR PEÇA", statusKit: "KIT POSSÍVEL" })] },
      ],
      "ANALISE MI.xlsx",
    );
    created.push(ordersPath, analysisPath);

    const pv = preview(db, { filePath: ordersPath, fileName: "PEDIDOS.xlsx" }, { filePath: analysisPath, fileName: "ANALISE MI.xlsx" });
    expect(pv.canConfirm).toBe(true); // conflito de status não é fatal
    expect(pv.issues.some((i) => i.code === "STATUS_CONFLICT" && i.severity === "CONFLICT")).toBe(true);

    const res = confirm(db, pv.previewBatchId);
    expect(res.status).toBe("COMPLETED_WITH_WARNINGS");
    expect(res.conflictsCount).toBeGreaterThanOrEqual(1);

    const batch = repo.getBatch(db, res.batchId)!;
    expect(batch.conflicts_count).toBe(res.conflictsCount);
  });
});
