import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { preview, confirm, ImportError } from "../src/import/import-service.js";
import { getSystemState, isInitialized } from "../src/system/system-service.js";
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
  delete process.env.ALLOW_LEGACY_REIMPORT;
});

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

function buildPair(
  quotations: unknown[][] = [["PED1", "BAT", 2, 10, 20, "2026-06-01", "APROVADO"]],
) {
  const ordersPath = makeXlsx(
    [
      { name: "PEDIDOS", aoa: [ORDERS_HEADER, orderRow({ idPedido: "PED1", imei: "1", chave: "BAT", status: "MATCH", statusKit: "KIT POSSÍVEL" })] },
      { name: "BIPAGEM DE PEÇAS", aoa: [BIPAGEM_HEADER, ["PC-1", "BAT", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"]] },
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

describe("Etapa 2 — importação Excel como inicialização única", () => {
  it("primeira importação inicializa o sistema", () => {
    const db = freshDb();
    expect(isInitialized(db)).toBe(false);
    const f = buildPair();
    const res = confirm(db, preview(db, f.orders, f.analysis).previewBatchId);

    const state = getSystemState(db);
    expect(state.initialized).toBe(1);
    expect(state.initial_import_batch_id).toBe(res.batchId);
    expect(state.initialized_at).not.toBeNull();
  });

  it("segunda importação (arquivos diferentes) é bloqueada por padrão", () => {
    const db = freshDb();
    const f1 = buildPair();
    confirm(db, preview(db, f1.orders, f1.analysis).previewBatchId);

    const f2 = buildPair([["PED2", "TELA", 1, 5, 5, "2026-06-02", "APROVADO"]]);
    const pv2 = preview(db, f2.orders, f2.analysis);
    expect(() => confirm(db, pv2.previewBatchId)).toThrow(ImportError);
    try {
      confirm(db, pv2.previewBatchId);
    } catch (e) {
      expect((e as ImportError).statusCode).toBe(409);
    }
  });

  it("ALLOW_LEGACY_REIMPORT=true permite reimportação em dev/teste", () => {
    process.env.ALLOW_LEGACY_REIMPORT = "true";
    const db = freshDb();
    const f1 = buildPair();
    confirm(db, preview(db, f1.orders, f1.analysis).previewBatchId);

    const f2 = buildPair([["PED2", "TELA", 1, 5, 5, "2026-06-02", "APROVADO"]]);
    const res2 = confirm(db, preview(db, f2.orders, f2.analysis).previewBatchId);
    expect(res2.alreadyImported).toBe(false);
  });

  it("tabelas source_* permanecem imutáveis após a inicialização (sem reimportação)", () => {
    const db = freshDb();
    const f = buildPair();
    confirm(db, preview(db, f.orders, f.analysis).previewBatchId);

    const before = db.prepare("SELECT COUNT(*) AS c FROM source_order_parts").get() as { c: number };
    // Tenta uma segunda importação (bloqueada) — não deve alterar nada.
    const f2 = buildPair([["PED2", "TELA", 1, 5, 5, "2026-06-02", "APROVADO"]]);
    const pv2 = preview(db, f2.orders, f2.analysis);
    expect(() => confirm(db, pv2.previewBatchId)).toThrow();
    const after = db.prepare("SELECT COUNT(*) AS c FROM source_order_parts").get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("solicitações aprovadas são criadas uma única vez a partir de cotações APROVADO/APROVADA", () => {
    const db = freshDb();
    const f = buildPair([
      ["PED1", "BAT", 2, 10, 20, "2026-06-01", "APROVADO"],
      ["PED2", "TELA", 1, 5, 5, "2026-06-02", "aprovada"],
      ["PED3", "CARCACA", 1, 8, 8, "2026-06-03", "COTANDO"],
    ]);
    confirm(db, preview(db, f.orders, f.analysis).previewBatchId);

    const requests = db.prepare("SELECT * FROM purchase_requests").all() as { id_pedido: string; status: string }[];
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.id_pedido).sort()).toEqual(["PED1", "PED2"]);
    expect(requests.every((r) => r.status === "APPROVED")).toBe(true);
  });

  it("status não aprovado (COTANDO/vazio) não cria solicitação", () => {
    const db = freshDb();
    const f = buildPair([["PED1", "BAT", 2, 10, 20, "2026-06-01", "COTANDO"]]);
    confirm(db, preview(db, f.orders, f.analysis).previewBatchId);
    const requests = db.prepare("SELECT COUNT(*) AS c FROM purchase_requests").get() as { c: number };
    expect(requests.c).toBe(0);
  });

  it("inicialização repetida é idempotente (não duplica solicitações)", async () => {
    const db = freshDb();
    const f = buildPair();
    const batchId = confirm(db, preview(db, f.orders, f.analysis).previewBatchId).batchId;

    // Chama initializeSystem novamente diretamente (idempotência interna).
    const { initializeSystem } = await import("../src/system/system-service.js");
    const result = initializeSystem(db, batchId, "teste");
    expect(result.initialized).toBe(false);

    const requests = db.prepare("SELECT COUNT(*) AS c FROM purchase_requests").get() as { c: number };
    expect(requests.c).toBe(1);
  });
});
