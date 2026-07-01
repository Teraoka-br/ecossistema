import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { preview, confirm } from "../src/import/import-service.js";
import * as svc from "../src/counting/counting-service.js";
import * as q from "../src/db/counting-queries.js";
import { activeBatchId } from "../src/db/queries.js";
import {
  ANALYSIS_HEADER,
  BIPAGEM_HEADER,
  ORDERS_HEADER,
  QUOTATION_HEADER,
  cleanup,
  makeXlsx,
  orderRow,
} from "./helpers.js";

/**
 * Teste de integração ponta a ponta: importação real (fixtures pequenas, não
 * data/app.sqlite) → sessão de contagem → dez beeps → referência desconhecida
 * → finalização bloqueada → resolução manual → finalização → snapshot →
 * confirma que nenhum match foi executado.
 */
const created: string[] = [];
afterEach(() => {
  while (created.length) cleanup(created.pop()!);
});

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

describe("integração: importação real + bipagem completa", () => {
  it("importa fixtures, bipa, bloqueia, resolve, finaliza e gera snapshot sem match", () => {
    const db = freshDb();

    // 1. Importar fixtures (mesmos componentes da importação real).
    const ordersPath = makeXlsx(
      [
        {
          name: "PEDIDOS",
          aoa: [ORDERS_HEADER, orderRow({ idPedido: "PED1", imei: "1", chave: "BATERIA 13", status: "MATCH", statusKit: "KIT POSSÍVEL" })],
        },
        {
          name: "BIPAGEM DE PEÇAS",
          aoa: [BIPAGEM_HEADER, ["PC-REF1", "BATERIA 13", "QUARTT", "BATERIA 13", "DISPONÍVEL", "PC-REF1"]],
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

    const pv = preview(db, { filePath: ordersPath, fileName: "PEDIDOS.xlsx" }, { filePath: analysisPath, fileName: "ANALISE MI.xlsx" });
    expect(pv.canConfirm).toBe(true);
    const importResult = confirm(db, pv.previewBatchId);
    expect(importResult.status).not.toBe("FAILED");
    const batchId = activeBatchId(db)!;
    expect(batchId).toBeGreaterThan(0);

    // 2. Criar sessão.
    const session = svc.createSession(db, { responsibleName: "Joao" });
    expect(session.import_batch_id).toBe(batchId);

    // 3. Registrar dez beeps iguais (referência reconhecida pelo catálogo importado).
    for (let i = 0; i < 10; i++) {
      svc.registerScan(db, session.id, { reference: "PC-REF1" });
    }

    // 4. Confirmar quantidade dez.
    expect(q.activeScanCountForReference(db, session.id, "PC-REF1")).toBe(10);

    // 5. Registrar uma referência desconhecida.
    svc.registerScan(db, session.id, { reference: "REF-NUNCA-IMPORTADA" });
    const pending = svc.getPending(db, session.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].mappingStatus).toBe("UNKNOWN_REFERENCE");

    // 6. Confirmar que a finalização foi bloqueada.
    const summaryBlocked = svc.buildFinalizeSummary(db, session.id);
    expect(summaryBlocked.canFinalize).toBe(false);
    expect(() => svc.finalizeSession(db, session.id, { finalizedBy: "Joao" })).toThrow();

    // 7. Resolver a referência.
    svc.resolveReferenceManually(db, session.id, {
      referenceNorm: "REF-NUNCA-IMPORTADA",
      chavePeca: "BATERIA 13", // chave válida do catálogo importado
      responsibleName: "Joao",
    });
    expect(svc.getPending(db, session.id)).toHaveLength(0);

    // 8. Finalizar.
    const summaryReady = svc.buildFinalizeSummary(db, session.id);
    expect(summaryReady.canFinalize).toBe(true);
    const finalizeResult = svc.finalizeSession(db, session.id, { finalizedBy: "Joao" });
    expect(finalizeResult.alreadyFinalized).toBe(false);

    // 9. Confirmar snapshot.
    const snapshot = q.getSnapshotById(db, finalizeResult.snapshot.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.total_units).toBe(11); // 10 PC-REF1 + 1 REF-NUNCA-IMPORTADA
    const items = q.listSnapshotItems(db, finalizeResult.snapshot.id);
    expect(items.find((i) => i.reference_norm === "PC-REF1")?.counted_quantity).toBe(10);
    expect(q.latestOfficialSnapshot(db)?.id).toBe(snapshot?.id);

    // 10. Confirmar que nenhum match foi executado.
    expect(q.countMatchRunsAndResults(db)).toEqual({ runs: 0, results: 0 });

    db.close();
  });
});
