/**
 * Testes do serviço de match (runMatch, fingerprint, reutilização, staleness).
 */

import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { preview, confirm } from "../src/import/import-service.js";
import { runMatch, isRunStale, getCurrentState } from "../src/match/match-service.js";
import { MatchError, MatchConfigError, computeCurrentFingerprint } from "../src/match/match-fingerprint.js";
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

/** DB inicializado com 1 pedido (IMEI001, BAT) e 1 unidade de estoque (PC-1, BAT). */
function baseDb() {
  const db = freshDb();
  const ordersPath = makeXlsx(
    [
      {
        name: "PEDIDOS",
        aoa: [
          ORDERS_HEADER,
          orderRow({ idPedido: "PED1", imei: "IMEI001", os: "OS1", chave: "BAT", ref: "PC-1", status: "SOLICITADO", qtde: 1, idade: 30, custo: 100, venda: 200 }),
        ],
      },
      {
        name: "BIPAGEM DE PEÇAS",
        aoa: [
          BIPAGEM_HEADER,
          ["PC-1", "BAT Samsung", "QUARTT", "BAT", "DISPONÍVEL", "PC-1"],
        ],
      },
    ],
    "PEDIDOS.xlsx",
  );
  const analysisPath = makeXlsx(
    [
      { name: "PEÇAS A PEDIR", aoa: [QUOTATION_HEADER] },
      { name: "ANALISEMI", aoa: [ANALYSIS_HEADER] },
    ],
    "ANALISE MI.xlsx",
  );
  created.push(ordersPath, analysisPath);
  const orders = { filePath: ordersPath, fileName: "PEDIDOS.xlsx" };
  const analysis = { filePath: analysisPath, fileName: "ANALISE MI.xlsx" };
  confirm(db, preview(db, orders, analysis).previewBatchId);
  return db;
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe("runMatch — pré-requisitos", () => {
  it("lança MatchError quando createdBy está vazio", () => {
    const db = freshDb();
    expect(() => runMatch(db, { createdBy: "" })).toThrow(MatchError);
  });

  it("lança MatchError quando sistema não foi inicializado", () => {
    const db = freshDb();
    expect(() => runMatch(db, { createdBy: "Teste" })).toThrow(MatchError);
  });

  it("lança MatchConfigError quando não há regra de decisão ativa", () => {
    const db = baseDb();
    db.prepare("UPDATE decision_rules SET active = 0").run();
    expect(() => runMatch(db, { createdBy: "Teste" })).toThrow(MatchConfigError);
  });
});

describe("runMatch — execução básica", () => {
  it("retorna run COMPLETED ou COMPLETED_WITH_WARNINGS após execução bem-sucedida", () => {
    const db = baseDb();
    const result = runMatch(db, { createdBy: "Tester" });
    expect(result.run.status).toMatch(/^COMPLETED/);
    expect(result.reused).toBe(false);
  });

  it("grava o hash da execução em input_hash", () => {
    const db = baseDb();
    const result = runMatch(db, { createdBy: "Tester" });
    expect(result.run.input_hash).toBeTruthy();
    expect(result.run.input_hash).toHaveLength(64); // SHA-256 hex
  });

  it("criado_by é persistido corretamente", () => {
    const db = baseDb();
    const result = runMatch(db, { createdBy: "UsuarioFoo" });
    expect(result.run.created_by).toBe("UsuarioFoo");
  });

  it("notes é persistido quando fornecido", () => {
    const db = baseDb();
    const result = runMatch(db, { createdBy: "Tester", notes: "Execução de teste" });
    expect(result.run.notes).toBe("Execução de teste");
  });

  it("result não cria stock_movements (imutável)", () => {
    const db = baseDb();
    const before = (db.prepare("SELECT COUNT(*) AS c FROM stock_movements").get() as { c: number }).c;
    runMatch(db, { createdBy: "Tester" });
    const after = (db.prepare("SELECT COUNT(*) AS c FROM stock_movements").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("result não cria operational_events (imutável)", () => {
    const db = baseDb();
    const before = (db.prepare("SELECT COUNT(*) AS c FROM operational_events").get() as { c: number }).c;
    runMatch(db, { createdBy: "Tester" });
    const after = (db.prepare("SELECT COUNT(*) AS c FROM operational_events").get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe("runMatch — reutilização (fingerprint idempotente)", () => {
  it("reutiliza resultado quando estado não mudou e force=false", () => {
    const db = baseDb();
    const r1 = runMatch(db, { createdBy: "Tester" });
    const r2 = runMatch(db, { createdBy: "Tester" });
    expect(r2.reused).toBe(true);
    expect(r2.run.id).toBe(r1.run.id);
  });

  it("força nova execução quando force=true mesmo com estado igual", () => {
    const db = baseDb();
    const r1 = runMatch(db, { createdBy: "Tester" });
    const r2 = runMatch(db, { createdBy: "Tester", force: true });
    expect(r2.reused).toBe(false);
    expect(r2.run.id).toBeGreaterThan(r1.run.id);
  });

  it("nova execução quando um operational_event é adicionado", () => {
    const db = baseDb();
    const r1 = runMatch(db, { createdBy: "Tester" });

    // Adicionar evento operacional para um pedido
    db.prepare(
      `INSERT INTO operational_events (entity_type, entity_id, event_type, new_status, responsible_name)
       VALUES ('ORDER_PART', 'PED1', 'STATUS_CHANGE', 'SEPARADO', 'Operador')`,
    ).run();

    const r2 = runMatch(db, { createdBy: "Tester" });
    expect(r2.reused).toBe(false);
    expect(r2.run.id).toBeGreaterThan(r1.run.id);
  });
});

describe("isRunStale", () => {
  it("run recém-executado não é stale", () => {
    const db = baseDb();
    const result = runMatch(db, { createdBy: "Tester" });
    expect(isRunStale(db, result.run)).toBe(false);
  });

  it("run fica stale quando regra de decisão muda", () => {
    const db = baseDb();
    const result = runMatch(db, { createdBy: "Tester" });
    // Mudar parâmetro da regra
    db.prepare("UPDATE decision_rules SET age_days_per_point = 99 WHERE active = 1").run();
    expect(isRunStale(db, result.run)).toBe(true);
  });

  it("run FAILED sempre retorna false (não é stale)", () => {
    const db = baseDb();
    const result = runMatch(db, { createdBy: "Tester" });
    const run = { ...result.run, status: "FAILED" as const };
    expect(isRunStale(db, run)).toBe(false);
  });

  it("run sem input_hash é stale", () => {
    const db = baseDb();
    const result = runMatch(db, { createdBy: "Tester" });
    const run = { ...result.run, input_hash: null };
    expect(isRunStale(db, run)).toBe(true);
  });
});

describe("getCurrentState", () => {
  it("retorna sistema não inicializado quando sem importação", () => {
    const db = freshDb();
    const state = getCurrentState(db);
    expect(state.initialized).toBe(false);
  });

  it("retorna hash e regra ativa após inicialização", () => {
    const db = baseDb();
    const state = getCurrentState(db);
    expect(state.initialized).toBe(true);
    expect(state.hash).toHaveLength(64);
    expect(state.activeRule).not.toBeNull();
  });

  it("hash muda após mudança no estoque", () => {
    const db = baseDb();
    const h1 = computeCurrentFingerprint(db).hash;
    // Adicionar movimento de estoque
    const refNorm = (db.prepare("SELECT chave_peca_norm FROM source_inventory_items LIMIT 1").get() as { chave_peca_norm: string } | undefined)?.chave_peca_norm;
    if (refNorm) {
      db.prepare(
        `INSERT INTO stock_movements (movement_type, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity, source_type, created_by)
         VALUES ('MANUAL_ADJUSTMENT', 'PC-999', 'pc-999', 'BAT', ?, 5, NULL, 'Tester')`,
      ).run(refNorm);
    }
    const h2 = computeCurrentFingerprint(db).hash;
    if (refNorm) expect(h2).not.toBe(h1);
  });
});

describe("runMatch — validação de regra numérica (item 10)", () => {
  it("age_days_per_point = 0 lança MatchConfigError", () => {
    const db = baseDb();
    db.prepare("UPDATE decision_rules SET age_days_per_point = 0 WHERE active = 1").run();
    expect(() => runMatch(db, { createdBy: "Tester" })).toThrow(MatchConfigError);
  });

  it("age_days_per_point negativo lança MatchConfigError", () => {
    const db = baseDb();
    db.prepare("UPDATE decision_rules SET age_days_per_point = -5 WHERE active = 1").run();
    expect(() => runMatch(db, { createdBy: "Tester" })).toThrow(MatchConfigError);
  });

  it("age_max_points negativo lança MatchConfigError", () => {
    const db = baseDb();
    db.prepare("UPDATE decision_rules SET age_max_points = -1 WHERE active = 1").run();
    expect(() => runMatch(db, { createdBy: "Tester" })).toThrow(MatchConfigError);
  });

  it("margin_per_point = 0 lança MatchConfigError", () => {
    const db = baseDb();
    db.prepare("UPDATE decision_rules SET margin_per_point = 0 WHERE active = 1").run();
    expect(() => runMatch(db, { createdBy: "Tester" })).toThrow(MatchConfigError);
  });
});

describe("runMatch — FAILED run após rollback (item 8)", () => {
  it("nenhum run RUNNING fica após falha — cria exatamente um FAILED", () => {
    const db = baseDb();
    // Corromper a tabela match_results para forçar falha na transação
    // (DROP e recriar como VIEW vazia para causar erro de INSERT)
    db.prepare("ALTER TABLE match_results RENAME TO _match_results_bkp").run();
    db.prepare("CREATE VIEW match_results AS SELECT * FROM _match_results_bkp WHERE 0").run();

    try {
      runMatch(db, { createdBy: "Tester" });
    } catch { /* esperado */ }

    // Restaurar
    db.prepare("DROP VIEW match_results").run();
    db.prepare("ALTER TABLE _match_results_bkp RENAME TO match_results").run();

    // Não deve existir nenhum run RUNNING
    const running = (db.prepare("SELECT COUNT(*) AS c FROM match_runs WHERE status = 'RUNNING'").get() as { c: number }).c;
    expect(running).toBe(0);

    // Deve existir exatamente um FAILED
    const failed = (db.prepare("SELECT COUNT(*) AS c FROM match_runs WHERE status = 'FAILED'").get() as { c: number }).c;
    expect(failed).toBe(1);

    // Sem resultados parciais
    const results = (db.prepare("SELECT COUNT(*) AS c FROM match_results").get() as { c: number }).c;
    expect(results).toBe(0);
  });
});

describe("isRunStale — reversão de movimento (item 9)", () => {
  it("reversão de movimento antigo torna run stale mesmo quando MAX(id) não muda", () => {
    const db = baseDb();

    // Criar dois movimentos
    const chaveNorm = (db.prepare("SELECT chave_peca_norm FROM source_inventory_items LIMIT 1").get() as { chave_peca_norm: string } | undefined)?.chave_peca_norm ?? "bat";

    db.prepare(
      `INSERT INTO stock_movements (movement_type, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity, source_type, created_by)
       VALUES ('MANUAL_ADJUSTMENT','PC-A','pc-a','BAT',?,3,NULL,'Tester')`,
    ).run(chaveNorm);
    const mv1 = (db.prepare("SELECT id FROM stock_movements ORDER BY id DESC LIMIT 1").get() as { id: number }).id;

    db.prepare(
      `INSERT INTO stock_movements (movement_type, referencia, referencia_norm, chave_peca, chave_peca_norm, quantity, source_type, created_by)
       VALUES ('MANUAL_ADJUSTMENT','PC-B','pc-b','BAT',?,2,NULL,'Tester')`,
    ).run(chaveNorm);

    // Executar match com dois movimentos presentes
    const r1 = runMatch(db, { createdBy: "Tester" });
    expect(isRunStale(db, r1.run)).toBe(false);

    // Reverter o primeiro movimento (MAX(id) permanece — é o mv2)
    db.prepare(`UPDATE stock_movements SET reversed_at = datetime('now'), reversed_by = 'Tester' WHERE id = ?`).run(mv1);

    // Run deve estar stale — stockStateHash mudou por causa da reversão
    expect(isRunStale(db, r1.run)).toBe(true);
  });
});

describe("runMatch — integridade", () => {
  it("SUM(reserved_units) == allocated_units do run", () => {
    const db = baseDb();
    const result = runMatch(db, { createdBy: "Tester" });
    const runId = result.run.id;
    const sumR = (
      db
        .prepare("SELECT COALESCE(SUM(reserved_units), 0) AS s FROM match_results WHERE match_run_id = ?")
        .get(runId) as { s: number }
    ).s;
    expect(sumR).toBe(result.run.allocated_units);
  });

  it("nenhuma linha de permanente tem reserved_units > 0", () => {
    const db = baseDb();
    // Criar pedido permanente via evento
    db.prepare(
      `INSERT INTO operational_events (entity_type, entity_id, event_type, new_status, responsible_name)
       VALUES ('ORDER_PART', 'PED1', 'STATUS_CHANGE', 'CONCLUIDO', 'Tester')`,
    ).run();
    const result = runMatch(db, { createdBy: "Tester" });
    const bad = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM match_results WHERE match_run_id = ?
           AND allocation_phase = 'PRESERVED' AND reserved_units > 0`,
        )
        .get(result.run.id) as { c: number }
    ).c;
    expect(bad).toBe(0);
  });
});
