import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import * as svc from "../src/counting/counting-service.js";
import { CountingError } from "../src/counting/counting-service.js";
import * as repo from "../src/db/counting-repository.js";
import * as q from "../src/db/counting-queries.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

/** Cria um lote COMPLETED mínimo (sem rodar a importação real) e seu estoque legado. */
function setupBatch(
  db: Db,
  inventory: { referencia: string; chave?: string }[],
  status: "COMPLETED" | "PREVIEW" = "COMPLETED",
): number {
  const r = db
    .prepare(
      `INSERT INTO import_batches (analysis_file_name, orders_file_name, analysis_file_hash, orders_file_hash, status)
       VALUES ('a.xlsx', 'p.xlsx', ?, ?, ?)`,
    )
    .run(`ha-${Math.random()}`, `hp-${Math.random()}`, status);
  const batchId = Number(r.lastInsertRowid);
  const stmt = db.prepare(
    `INSERT INTO source_inventory_items (import_batch_id, referencia, referencia_norm, chave_peca, chave_peca_norm, raw_json)
     VALUES (?, ?, ?, ?, ?, '{}')`,
  );
  for (const item of inventory) {
    const refNorm = item.referencia.toUpperCase().trim();
    stmt.run(batchId, item.referencia, refNorm, item.chave ?? null, item.chave ? item.chave.toUpperCase().trim() : null);
  }
  return batchId;
}

function openSession(db: Db, responsibleName = "Joao") {
  return svc.createSession(db, { responsibleName });
}

describe("1. Sessões", () => {
  it("criação de sessão vincula ao lote ativo", () => {
    const db = freshDb();
    const batchId = setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    expect(session.import_batch_id).toBe(batchId);
    expect(session.status).toBe("OPEN");
  });

  it("bloqueia criação sem lote importado concluído", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1" }], "PREVIEW"); // não COMPLETED
    expect(() => openSession(db)).toThrow(CountingError);
    try {
      openSession(db);
    } catch (e) {
      expect((e as CountingError).statusCode).toBe(422);
    }
  });

  it("permite apenas uma sessão aberta (409 com a sessão existente)", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const first = openSession(db);
    try {
      openSession(db, "Maria");
      expect.fail("deveria ter lançado conflito");
    } catch (e) {
      expect(e).toBeInstanceOf(CountingError);
      expect((e as CountingError).statusCode).toBe(409);
      expect((e as CountingError).details).toMatchObject({ sessionId: first.id });
    }
  });
});

describe("2. Beeps", () => {
  it("dez beeps iguais geram dez scans e quantidade consolidada dez", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    for (let i = 0; i < 10; i++) svc.registerScan(db, session.id, { reference: "REF1" });

    const rows = db.prepare("SELECT COUNT(*) AS c FROM count_scans WHERE session_id = ?").get(session.id) as { c: number };
    expect(rows.c).toBe(10); // beeps repetidos não são deduplicados — dez linhas reais
    expect(q.activeScanCountForReference(db, session.id, "REF1")).toBe(10);
  });

  it("normaliza a referência (acento/caixa/espaço) para a mesma referenceNorm", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "BATERIA 13", chave: "BAT" }]);
    const session = openSession(db);
    const r1 = svc.registerScan(db, session.id, { reference: " bateria 13 " });
    const r2 = svc.registerScan(db, session.id, { reference: "BATERIA   13" });
    expect(r1.scan.reference_norm).toBe(r2.scan.reference_norm);
    expect(q.activeScanCountForReference(db, session.id, r1.scan.reference_norm)).toBe(2);
  });

  it("referência reconhecida quando o catálogo tem exatamente uma CHAVEPECA", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    const r = svc.registerScan(db, session.id, { reference: "REF1" });
    expect(r.scan.mapping_status).toBe("RECOGNIZED");
    expect(r.scan.chave_peca_norm).toBe("BAT");
  });

  it("referência desconhecida (fora do catálogo)", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    const r = svc.registerScan(db, session.id, { reference: "NAO-EXISTE" });
    expect(r.scan.mapping_status).toBe("UNKNOWN_REFERENCE");
  });

  it("referência existente no catálogo, mas sem CHAVEPECA", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1" }]); // sem chave
    const session = openSession(db);
    const r = svc.registerScan(db, session.id, { reference: "REF1" });
    expect(r.scan.mapping_status).toBe("MISSING_KEY");
  });

  it("conflito defensivo: referência com duas CHAVEPECA distintas no catálogo nunca é resolvida silenciosamente", () => {
    const db = freshDb();
    setupBatch(db, [
      { referencia: "REF1", chave: "BAT A" },
      { referencia: "REF1", chave: "BAT B" },
    ]);
    const session = openSession(db);
    const r = svc.registerScan(db, session.id, { reference: "REF1" });
    expect(r.scan.mapping_status).toBe("CONFLICT");
    expect(r.scan.chave_peca_norm).toBeNull(); // nunca escolhe uma chave por MAX/MIN/primeira linha
  });

  it("scan após finalização é bloqueado", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "REF1" });
    svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });

    try {
      svc.registerScan(db, session.id, { reference: "REF1" });
      expect.fail("deveria ter bloqueado o beep");
    } catch (e) {
      expect(e).toBeInstanceOf(CountingError);
      // Mutação em sessão não-OPEN: 409 (conflito de estado) — 409 ou 422 são aceitáveis.
      expect([409, 422]).toContain((e as CountingError).statusCode);
    }
  });
});

describe("3. Cancelamento", () => {
  it("cancelamento de scan nunca exclui a linha (sem DELETE)", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    const { scan } = svc.registerScan(db, session.id, { reference: "REF1" });
    svc.cancelScan(db, scan.id, { cancelledBy: "Joao", cancelReason: "erro de leitura" });

    const stillThere = db.prepare("SELECT * FROM count_scans WHERE id = ?").get(scan.id);
    expect(stillThere).toBeTruthy();
  });

  it("scan cancelado deixa de contar nos totais ativos", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    const a = svc.registerScan(db, session.id, { reference: "REF1" });
    svc.registerScan(db, session.id, { reference: "REF1" });
    expect(q.activeScanCountForReference(db, session.id, "REF1")).toBe(2);

    svc.cancelScan(db, a.scan.id, { cancelledBy: "Joao", cancelReason: "duplicado" });
    expect(q.activeScanCountForReference(db, session.id, "REF1")).toBe(1);
  });

  it("cancelamento de scan é idempotente", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    const { scan } = svc.registerScan(db, session.id, { reference: "REF1" });
    const c1 = svc.cancelScan(db, scan.id, { cancelledBy: "Joao", cancelReason: "motivo 1" });
    const c2 = svc.cancelScan(db, scan.id, { cancelledBy: "Maria", cancelReason: "motivo 2" });
    expect(c1.cancelled_at).toBe(c2.cancelled_at);
    expect(c2.cancelled_by).toBe("Joao"); // não sobrescreve o cancelamento original
  });
});

describe("4. Resolução manual de referências pendentes", () => {
  it("resolução manual de referência desconhecida torna os scans efetivamente reconhecidos", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "REF-NOVA" });
    expect(svc.getPending(db, session.id)).toHaveLength(1);

    svc.resolveReferenceManually(db, session.id, {
      referenceNorm: "REF-NOVA",
      chavePeca: "BAT", // chave válida do catálogo (REF1)
      responsibleName: "Joao",
    });

    expect(svc.getPending(db, session.id)).toHaveLength(0);
    const summary = svc.buildFinalizeSummary(db, session.id);
    expect(summary.recognizedUnits).toBe(1);
    expect(summary.unknownUnits).toBe(0);
  });

  it("mapeamento manual tem precedência sobre o catálogo", () => {
    const db = freshDb();
    // REF1 resolveria para "BAT DO CATALOGO"; "BAT MANUAL" é uma chave válida do
    // catálogo (sob outra referência) que o operador escolhe manualmente.
    setupBatch(db, [
      { referencia: "REF1", chave: "BAT DO CATALOGO" },
      { referencia: "REF-OUTRA", chave: "BAT MANUAL" },
    ]);
    const session = openSession(db);

    svc.resolveReferenceManually(db, session.id, {
      referenceNorm: "REF1",
      chavePeca: "BAT MANUAL",
      responsibleName: "Joao",
    });

    const r = svc.registerScan(db, session.id, { reference: "REF1" });
    expect(r.scan.mapping_status).toBe("RECOGNIZED");
    // O scan individual guarda o que foi detectado na hora (pode ser o catálogo);
    // o que importa é o efetivo recalculado na consolidação/resumo usar o manual.
    const summary = svc.buildFinalizeSummary(db, session.id);
    const ref1Diff = summary.differencesByReference.find((d) => d.referenceNorm === "REF1");
    expect(ref1Diff?.chavePeca).toBe("BAT MANUAL");
  });

  it("cancelamento em massa dos beeps de uma pendência", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });

    const cancelled = svc.cancelPendingScans(db, session.id, {
      referenceNorm: "DESCONHECIDA",
      cancelledBy: "Joao",
      cancelReason: "referência errada, descartar",
    });
    expect(cancelled).toBe(3);
    expect(svc.getPending(db, session.id)).toHaveLength(0);
    expect(q.activeScanCountForReference(db, session.id, "DESCONHECIDA")).toBe(0);

    // não excluiu as linhas — só cancelou
    const rows = db.prepare("SELECT COUNT(*) AS c FROM count_scans WHERE session_id = ?").get(session.id) as { c: number };
    expect(rows.c).toBe(3);
  });
});

describe("5. Bloqueadores de finalização", () => {
  it("sessão vazia (zero beeps ativos) não finaliza", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    const summary = svc.buildFinalizeSummary(db, session.id);
    expect(summary.canFinalize).toBe(false);
    expect(summary.blockers.some((b) => b.startsWith("EMPTY_SESSION"))).toBe(true);
    expect(() => svc.finalizeSession(db, session.id, { finalizedBy: "Joao" })).toThrow(CountingError);
  });

  it("pendência ativa (UNKNOWN/MISSING_KEY/CONFLICT) bloqueia a finalização", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "REF1" }); // RECOGNIZED, evita EMPTY_SESSION
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" }); // UNKNOWN_REFERENCE

    const summary = svc.buildFinalizeSummary(db, session.id);
    expect(summary.canFinalize).toBe(false);
    expect(summary.blockers.some((b) => b.startsWith("UNKNOWN_REFERENCE_PENDING"))).toBe(true);
    expect(() => svc.finalizeSession(db, session.id, { finalizedBy: "Joao" })).toThrow(CountingError);
  });

  it("contagem abaixo do limite exige forceIncomplete + responsável + justificativa >= 10 caracteres", () => {
    const db = freshDb();
    // 10 unidades legadas; só 5 bipadas ativas (50% < 80% padrão).
    setupBatch(
      db,
      Array.from({ length: 10 }, (_, i) => ({ referencia: `REF${i}`, chave: `BAT${i}` })),
    );
    const session = openSession(db);
    for (let i = 0; i < 5; i++) svc.registerScan(db, session.id, { reference: `REF${i}` });

    const summary = svc.buildFinalizeSummary(db, session.id);
    expect(summary.warnings).toContain("COUNT_BELOW_BASELINE_THRESHOLD");
    expect(summary.canFinalize).toBe(false);

    // sem força -> bloqueado
    expect(() => svc.finalizeSession(db, session.id, { finalizedBy: "Joao" })).toThrow(CountingError);
    // força com justificativa curta -> ainda bloqueado
    expect(() =>
      svc.finalizeSession(db, session.id, { finalizedBy: "Joao", forceIncomplete: true, forceReason: "curta" }),
    ).toThrow(CountingError);
    // força com justificativa válida -> finaliza
    const result = svc.finalizeSession(db, session.id, {
      finalizedBy: "Joao",
      forceIncomplete: true,
      forceReason: "contagem parcial aprovada pelo gerente",
    });
    expect(result.alreadyFinalized).toBe(false);
    expect(result.snapshot.total_units).toBe(5);
  });

  it("contagem vazia nunca pode ser forçada", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    try {
      svc.finalizeSession(db, session.id, { finalizedBy: "Joao", forceIncomplete: true, forceReason: "justificativa bem longa aqui" });
      expect.fail("deveria ter bloqueado mesmo com força");
    } catch (e) {
      expect(e).toBeInstanceOf(CountingError);
      expect((e as CountingError).message).toContain("EMPTY_SESSION");
    }
  });
});

describe("6. Finalização e snapshot", () => {
  it("finalização cria um snapshot oficial", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "REF1" });
    const result = svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });
    expect(result.snapshot.status).toBe("OFFICIAL");
    expect(q.getSnapshotById(db, result.snapshot.id)).not.toBeNull();
  });

  it("consolidação soma corretamente referências repetidas", () => {
    const db = freshDb();
    setupBatch(db, [
      { referencia: "REF1", chave: "BAT" },
      { referencia: "REF2", chave: "TELA" },
    ]);
    const session = openSession(db);
    for (let i = 0; i < 7; i++) svc.registerScan(db, session.id, { reference: "REF1" });
    for (let i = 0; i < 3; i++) svc.registerScan(db, session.id, { reference: "ref2" }); // caixa diferente

    const result = svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });
    const items = q.listSnapshotItems(db, result.snapshot.id);
    const ref1 = items.find((it) => it.reference_norm === "REF1");
    const ref2 = items.find((it) => it.reference_norm === "REF2");
    expect(ref1?.counted_quantity).toBe(7);
    expect(ref2?.counted_quantity).toBe(3);
    expect(result.snapshot.total_units).toBe(10);
  });

  it("finalização repetida é idempotente — não duplica snapshot", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "REF1" });

    const first = svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });
    const second = svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });

    expect(second.alreadyFinalized).toBe(true);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    const count = db.prepare("SELECT COUNT(*) AS c FROM stock_snapshots WHERE count_session_id = ?").get(session.id) as { c: number };
    expect(count.c).toBe(1);
  });

  it("falha durante a finalização executa rollback completo (sessão continua aberta)", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "REF1" });

    vi.spyOn(repo, "insertSnapshotItems").mockImplementation(() => {
      throw new Error("falha forçada na gravação dos itens do snapshot");
    });

    expect(() => svc.finalizeSession(db, session.id, { finalizedBy: "Joao" })).toThrow();

    const fresh = svc.getSessionOrThrow(db, session.id);
    expect(fresh.status).toBe("OPEN");
    const snapshotCount = db.prepare("SELECT COUNT(*) AS c FROM stock_snapshots WHERE count_session_id = ?").get(session.id) as { c: number };
    expect(snapshotCount.c).toBe(0);
    // scans permanecem intactos
    expect(q.activeScanCountForReference(db, session.id, "REF1")).toBe(1);
  });

  it("cancelamento de sessão não altera o estoque oficial anterior", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session1 = openSession(db);
    svc.registerScan(db, session1.id, { reference: "REF1" });
    const finalized1 = svc.finalizeSession(db, session1.id, { finalizedBy: "Joao" });

    setupBatch(db, [{ referencia: "REF2", chave: "TELA" }]);
    const session2 = openSession(db, "Maria");
    svc.registerScan(db, session2.id, { reference: "REF2" });
    svc.cancelSession(db, session2.id, { cancelledBy: "Maria", cancelReason: "erro operacional" });

    const latest = q.latestOfficialSnapshot(db);
    expect(latest?.id).toBe(finalized1.snapshot.id);
    expect(q.getSnapshotBySession(db, session2.id)).toBeNull();
  });

  it("o último snapshot finalizado é o estoque oficial", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session1 = openSession(db);
    svc.registerScan(db, session1.id, { reference: "REF1" });
    const finalized1 = svc.finalizeSession(db, session1.id, { finalizedBy: "Joao" });

    const batch2 = setupBatch(db, [{ referencia: "REF2", chave: "TELA" }]);
    const session2 = openSession(db, "Maria");
    svc.registerScan(db, session2.id, { reference: "REF2" });
    const finalized2 = svc.finalizeSession(db, session2.id, { finalizedBy: "Maria" });

    const latest = q.latestOfficialSnapshot(db);
    expect(latest?.id).toBe(finalized2.snapshot.id);
    expect(latest?.id).not.toBe(finalized1.snapshot.id);
    expect(latest?.import_batch_id).toBe(batch2);
  });

  it("dados importados (source_inventory_items) permanecem intactos após a bipagem", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const before = (db.prepare("SELECT COUNT(*) AS c FROM source_inventory_items").get() as { c: number }).c;

    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "REF1" });
    svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });

    const after = (db.prepare("SELECT COUNT(*) AS c FROM source_inventory_items").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("nenhum match_run ou match_result é criado pela bipagem", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "REF1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "REF1" });
    svc.resolveReferenceManually(db, session.id, { referenceNorm: "OUTRA", chavePeca: "BAT", responsibleName: "Joao" });
    svc.cancelPendingScans(db, session.id, { referenceNorm: "OUTRA", cancelledBy: "Joao", cancelReason: "teste manual" });
    svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });

    expect(q.countMatchRunsAndResults(db)).toEqual({ runs: 0, results: 0 });
  });
});

describe("7. Correções de integridade da bipagem (Etapa 1)", () => {
  it("dois scans antes da resolução + três depois = um item de quantidade 5 (sem perder unidades)", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "PC-1", chave: "BAT" }]);
    const session = openSession(db);

    // 1. referência desconhecida recebe dois scans
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });
    // 2. vincular manualmente a CHAVEPECA BAT (válida no catálogo)
    svc.resolveReferenceManually(db, session.id, { referenceNorm: "DESCONHECIDA", chavePeca: "BAT", responsibleName: "Joao" });
    // 3. mesma referência recebe mais três scans
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });
    // 4. finalizar
    const result = svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });

    const items = q.listSnapshotItems(db, result.snapshot.id).filter((i) => i.reference_norm === "DESCONHECIDA");
    expect(items).toHaveLength(1);
    expect(items[0].counted_quantity).toBe(5);
    expect(result.snapshot.total_units).toBe(5);

    // integridade: SUM(items) = total_units = scans ativos reconhecidos
    const sumItems = q.listSnapshotItems(db, result.snapshot.id).reduce((s, i) => s + i.counted_quantity, 0);
    expect(sumItems).toBe(result.snapshot.total_units);
    expect(sumItems).toBe(5);
  });

  it("getSessionState recupera todos os totais do backend (sobrevive a F5)", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "PC-1", chave: "BAT" }]);
    const session = openSession(db);
    for (let i = 0; i < 4; i++) svc.registerScan(db, session.id, { reference: "PC-1" });
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });

    // Reabre "do zero" só pelo id (como faria o frontend após F5).
    const state = svc.getSessionState(db, session.id);
    expect(state.session.id).toBe(session.id);
    expect(state.summary.activeScans).toBe(5);
    expect(state.totalsByReference.find((t) => t.referenceNorm === "PC-1")?.total).toBe(4);
    expect(state.pending).toHaveLength(1);
    expect(state.recentScans.length).toBe(5);
    expect(state.summary.canFinalize).toBe(false); // pendência ativa
  });

  it("cancelamento atualiza todos os totais no estado consolidado", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "PC-1", chave: "BAT" }]);
    const session = openSession(db);
    const a = svc.registerScan(db, session.id, { reference: "PC-1" });
    svc.registerScan(db, session.id, { reference: "PC-1" });

    let state = svc.getSessionState(db, session.id);
    expect(state.summary.activeScans).toBe(2);
    expect(state.totalsByReference[0].total).toBe(2);

    svc.cancelScan(db, a.scan.id, { cancelledBy: "Joao", cancelReason: "leitura duplicada" });
    state = svc.getSessionState(db, session.id);
    expect(state.summary.activeScans).toBe(1);
    expect(state.totalsByReference[0].total).toBe(1);
    expect(state.summary.cancelledScans).toBe(1);
  });

  it("sessão FINALIZED é imutável: scan/cancel/resolução/cancel-massa bloqueados (409)", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "PC-1", chave: "BAT" }]);
    const session = openSession(db);
    const scan = svc.registerScan(db, session.id, { reference: "PC-1" }).scan;
    svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });

    const expect409 = (fn: () => void) => {
      try {
        fn();
        expect.fail("deveria ter bloqueado");
      } catch (e) {
        expect(e).toBeInstanceOf(CountingError);
        expect([409, 422]).toContain((e as CountingError).statusCode);
      }
    };
    expect409(() => svc.registerScan(db, session.id, { reference: "PC-1" }));
    expect409(() => svc.cancelScan(db, scan.id, { cancelledBy: "Joao", cancelReason: "tentativa pos-final" }));
    expect409(() => svc.resolveReferenceManually(db, session.id, { referenceNorm: "PC-1", chavePeca: "BAT", responsibleName: "Joao" }));
    expect409(() => svc.cancelPendingScans(db, session.id, { referenceNorm: "PC-1", cancelledBy: "Joao", cancelReason: "tentativa pos-final" }));
  });

  it("sessão CANCELLED é imutável: novos scans bloqueados", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "PC-1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "PC-1" });
    svc.cancelSession(db, session.id, { cancelledBy: "Joao", cancelReason: "sessao errada" });
    try {
      svc.registerScan(db, session.id, { reference: "PC-1" });
      expect.fail("deveria ter bloqueado");
    } catch (e) {
      expect([409, 422]).toContain((e as CountingError).statusCode);
    }
  });

  it("resposta da finalização não contém bloqueador falso e reflete os totais persistidos", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "PC-1", chave: "BAT" }]);
    const session = openSession(db);
    for (let i = 0; i < 3; i++) svc.registerScan(db, session.id, { reference: "PC-1" });
    const result = svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });

    expect(result.alreadyFinalized).toBe(false);
    expect(result.summary.canFinalize).toBe(true);
    expect(result.summary.blockers).not.toContain("SESSION_NOT_OPEN");
    expect(result.summary.blockers.some((b) => b.startsWith("SESSION_NOT_OPEN"))).toBe(false);
    expect(result.summary.activeScans).toBe(3);
    expect(result.summary.recognizedUnits).toBe(3);
    expect(result.snapshot.total_units).toBe(3);
  });

  it("autocomplete: resolução rejeita CHAVEPECA inexistente no catálogo (400)", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "PC-1", chave: "BAT" }]);
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "DESCONHECIDA" });
    try {
      svc.resolveReferenceManually(db, session.id, { referenceNorm: "DESCONHECIDA", chavePeca: "NAO-EXISTE-NO-CATALOGO", responsibleName: "Joao" });
      expect.fail("deveria ter rejeitado chave inexistente");
    } catch (e) {
      expect(e).toBeInstanceOf(CountingError);
      expect((e as CountingError).statusCode).toBe(400);
    }
  });

  it("histórico de mapeamento é preservado ao trocar a chave de uma referência", () => {
    const db = freshDb();
    setupBatch(db, [
      { referencia: "PC-1", chave: "BAT A" },
      { referencia: "PC-2", chave: "BAT B" },
    ]);
    const session = openSession(db);

    svc.resolveReferenceManually(db, session.id, { referenceNorm: "REF-X", chavePeca: "BAT A", responsibleName: "Joao" });
    svc.resolveReferenceManually(db, session.id, { referenceNorm: "REF-X", chavePeca: "BAT B", responsibleName: "Maria" });

    const history = repo.getMappingHistory(db, "REF-X");
    expect(history.length).toBe(2); // o anterior foi desativado, não apagado
    const active = history.filter((h) => h.active === 1);
    expect(active).toHaveLength(1);
    expect(active[0].chave_peca_norm).toBe("BAT B");
    const inactive = history.filter((h) => h.active === 0);
    expect(inactive).toHaveLength(1);
    expect(inactive[0].chave_peca_norm).toBe("BAT A");
    expect(inactive[0].created_by).toBe("Joao"); // dados originais preservados
  });

  it("mesma chave não duplica mapeamento (só atualiza metadados)", () => {
    const db = freshDb();
    setupBatch(db, [{ referencia: "PC-1", chave: "BAT" }]);
    const session = openSession(db);
    svc.resolveReferenceManually(db, session.id, { referenceNorm: "REF-X", chavePeca: "BAT", responsibleName: "Joao" });
    svc.resolveReferenceManually(db, session.id, { referenceNorm: "REF-X", chavePeca: "BAT", responsibleName: "Joao", notes: "reconfirmado" });
    const history = repo.getMappingHistory(db, "REF-X");
    expect(history).toHaveLength(1);
    expect(history[0].active).toBe(1);
  });

  it("snapshot compara com a base (lote) que originou a sessão", () => {
    const db = freshDb();
    const batchId = setupBatch(db, [
      { referencia: "PC-1", chave: "BAT" },
      { referencia: "PC-2", chave: "TELA" },
    ]);
    const session = openSession(db);
    expect(session.import_batch_id).toBe(batchId);
    svc.registerScan(db, session.id, { reference: "PC-1" });

    const summary = svc.buildFinalizeSummary(db, session.id);
    expect(summary.legacyTotalUnits).toBe(2); // 2 unidades do lote da sessão
  });
});

describe("9. Contagem PARCIAL_TESTE", () => {
  it("PARCIAL_TESTE finaliza com 1 item mesmo abaixo de 80%", () => {
    const db = freshDb();
    setupBatch(db, Array.from({ length: 10 }, (_, i) => ({ referencia: `REF${i}`, chave: `BAT${i}` })));
    const session = svc.createSession(db, { responsibleName: "Joao", countType: "PARCIAL_TESTE" });
    svc.registerScan(db, session.id, { reference: "REF0" });

    const summary = svc.buildFinalizeSummary(db, session.id);
    expect(summary.warnings).toContain("COUNT_BELOW_BASELINE_THRESHOLD");
    expect(summary.canFinalize).toBe(true); // não bloqueia

    const result = svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });
    expect(result.alreadyFinalized).toBe(false);
    expect(result.snapshot.status).toBe("OFFICIAL");
  });

  it("PARCIAL_TESTE não zera referências não contadas", () => {
    const db = freshDb();
    setupBatch(db, [
      { referencia: "REF1", chave: "BAT" },
      { referencia: "REF2", chave: "TELA" },
      { referencia: "REF3", chave: "FLEX" },
    ]);
    // Primeira sessão OFICIAL: bipa todas as 3 refs
    const s1 = openSession(db);
    svc.registerScan(db, s1.id, { reference: "REF1" });
    svc.registerScan(db, s1.id, { reference: "REF1" });
    svc.registerScan(db, s1.id, { reference: "REF2" });
    svc.registerScan(db, s1.id, { reference: "REF3" });
    svc.finalizeSession(db, s1.id, { finalizedBy: "Joao" });

    // Segunda sessão PARCIAL_TESTE: bipa só REF1
    const s2 = svc.createSession(db, { responsibleName: "Joao", countType: "PARCIAL_TESTE" });
    svc.registerScan(db, s2.id, { reference: "REF1" });
    svc.registerScan(db, s2.id, { reference: "REF1" });
    svc.registerScan(db, s2.id, { reference: "REF1" });
    const result = svc.finalizeSession(db, s2.id, { finalizedBy: "Joao" });

    const items = q.listSnapshotItems(db, result.snapshot.id);
    const ref1 = items.find((it) => it.reference_norm === "REF1");
    const ref2 = items.find((it) => it.reference_norm === "REF2");
    const ref3 = items.find((it) => it.reference_norm === "REF3");
    // REF1 atualizada para 3; REF2 e REF3 mantidas do snapshot anterior (1 cada)
    expect(ref1?.counted_quantity).toBe(3);
    expect(ref2?.counted_quantity).toBe(1);
    expect(ref3?.counted_quantity).toBe(1);
  });

  it("OFICIAL abaixo de 80% ainda bloqueia", () => {
    const db = freshDb();
    setupBatch(db, Array.from({ length: 10 }, (_, i) => ({ referencia: `REF${i}`, chave: `BAT${i}` })));
    const session = openSession(db);
    svc.registerScan(db, session.id, { reference: "REF0" });

    const summary = svc.buildFinalizeSummary(db, session.id);
    expect(summary.canFinalize).toBe(false);
    expect(() => svc.finalizeSession(db, session.id, { finalizedBy: "Joao" })).toThrow(CountingError);
  });
});
