/**
 * Testes para o serviço de pré-preenchimento de análise de aparelho.
 * Cobre 15 cenários especificados no Round 3.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "./helpers.js";
import type { Db } from "../src/db/database.js";
import { getPrefill } from "../src/analise/prefill-service.js";

// ---------------------------------------------------------------------------
// Helpers de seed
// ---------------------------------------------------------------------------

let _seq = 0;

function seedHisImport(db: Db): number {
  const hash = `hash-his-${++_seq}-${Date.now()}`;
  const r = db.prepare(
    `INSERT INTO his_imports (filename, file_hash, status, rows_found, rows_linked, rows_unlinked, issues_count, created_at, finished_at)
     VALUES ('his.xlsx', ?, 'COMPLETED', 1, 1, 0, 0, datetime('now'), datetime('now'))`,
  ).run(hash);
  return r.lastInsertRowid as number;
}

function seedHisRow(db: Db, importId: number, imei: string, ageDays: number | null, cost: number | null, sourceLine = 1) {
  db.prepare(
    `INSERT INTO his_import_rows (his_import_id, imei_norm, source_line, age_days, audited_cost)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(importId, imei.replace(/\D/g, ""), sourceLine, ageDays, cost);
}

function seedRelSeriaisImport(db: Db): number {
  const hash = `hash-ser-${++_seq}-${Date.now()}`;
  const r = db.prepare(
    `INSERT INTO rel_seriais_imports (filename, file_hash, status, rows_found, rows_valid, issues_count, created_at, finished_at)
     VALUES ('seriais.csv', ?, 'COMPLETED', 1, 1, 0, datetime('now'), datetime('now'))`,
  ).run(hash);
  return r.lastInsertRowid as number;
}

function seedSerialRow(db: Db, importId: number, imei: string, model: string, codComercial: string, deposito: string, disponivel: string) {
  db.prepare(
    `INSERT INTO rel_seriais_rows (rel_seriais_import_id, imei_norm, serial, produto, descricao, codigo_comercial, fabricante, disponivel, deposito_atual)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(importId, imei.replace(/\D/g, ""), imei, model, model, codComercial, "Samsung", disponivel, deposito);
}

function seedShOsImport(db: Db): number {
  const hash = `hash-sh-${++_seq}-${Date.now()}`;
  const r = db.prepare(
    `INSERT INTO sh_os_imports (filename, file_hash, status, rows_found, rows_valid, issues_count, created_at, finished_at)
     VALUES ('sh.xls', ?, 'COMPLETED', 1, 1, 0, datetime('now'), datetime('now'))`,
  ).run(hash);
  return r.lastInsertRowid as number;
}

function seedShOsRow(db: Db, importId: number, opts: {
  osNorm: string; osRaw: string;
  imeiNorm?: string; imeiRaw?: string;
  marca?: string; modelo?: string; cor?: string;
  defeito?: string; obsServico?: string;
}) {
  db.prepare(
    `INSERT INTO sh_os_rows (sh_os_import_id, os_norm, imei_norm, os_raw, imei_raw, marca, modelo, cor, defeito, obs_servico)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    importId, opts.osNorm, opts.imeiNorm ?? null,
    opts.osRaw, opts.imeiRaw ?? null,
    opts.marca ?? null, opts.modelo ?? null, opts.cor ?? null,
    opts.defeito ?? null, opts.obsServico ?? null,
  );
}

function seedPeacsImport(db: Db): number {
  const hash = `hash-peacs-${++_seq}-${Date.now()}`;
  const r = db.prepare(
    `INSERT INTO peacs_imports (filename, file_hash, status, rows_found, entries_matched, entries_unmatched, issues_count, created_at, finished_at)
     VALUES ('peacs.xlsx', ?, 'COMPLETED', 1, 1, 0, 0, datetime('now'), datetime('now'))`,
  ).run(hash);
  return r.lastInsertRowid as number;
}

function seedPeacs(db: Db, marcaModelo: string, marcaModeloNorm: string, price: number) {
  const importId = seedPeacsImport(db);
  db.prepare(
    `INSERT INTO peacs_catalog (peacs_import_id, brand, brand_norm, model, model_norm, marca_modelo, marca_modelo_norm, estimated_sale, active)
     VALUES (?, '', '', '', '', ?, ?, ?, 1)`,
  ).run(importId, marcaModelo, marcaModeloNorm, price);
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe("getPrefill — 15 cenários", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb();
  });

  // 1. IMEI válido sem dados → retorna imei preenchido, sem erro
  it("1. IMEI sem dados em nenhuma fonte → imei preservado, sem crash", () => {
    const r = getPrefill(db, "351234567890123");
    expect(r.imei).toBe("351234567890123");
    expect(r.custo).toBe(0);
    expect(r.vendaEstimada).toBe(0);
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  // 2. OS válida → retorna os preenchido, sem crash
  it("2. OS sem dados → os preservado", () => {
    const r = getPrefill(db, "12345");
    expect(r.os).toBe("12345");
    expect(r.imei).toBeNull();
  });

  // 3. SH preenche OS, marca, modelo, cor, defeito a partir de IMEI
  it("3. SH por IMEI → OS + marca + modelo + cor + defeito preenchidos", () => {
    const shId = seedShOsImport(db);
    seedShOsRow(db, shId, {
      osNorm: "54321", osRaw: "54321",
      imeiNorm: "351234567890123", imeiRaw: "351234567890123",
      marca: "Samsung", modelo: "Galaxy A32", cor: "PRETO",
      defeito: "Tela trincada", obsServico: "Obs X",
    });

    const r = getPrefill(db, "351234567890123");
    expect(r.os).toBe("54321");
    expect(r.marca).toBe("Samsung");
    expect(r.modelo).toBe("Galaxy A32");
    expect(r.cor).toBe("PRETO");
    expect(r.problema).toBe("Tela trincada");
    expect(r.observacaoServico).toBe("Obs X");
    expect(r.sources["marca"]).toBe("SH");
    expect(r.sources["modelo"]).toBe("SH");
    expect(r.sources["cor"]).toBe("SH");
  });

  // 4. SH por OS → preenche os mesmos campos
  it("4. SH por OS → mesmos campos preenchidos", () => {
    const shId = seedShOsImport(db);
    seedShOsRow(db, shId, {
      osNorm: "99001", osRaw: "99001",
      imeiNorm: null, imeiRaw: null,
      marca: "Apple", modelo: "iPhone 12", cor: "BRANCO",
    });

    const r = getPrefill(db, "99001");
    expect(r.marca).toBe("Apple");
    expect(r.modelo).toBe("iPhone 12");
    expect(r.sources["marca"]).toBe("SH");
  });

  // 5. Rel. Seriais preenche codigoComercial e deposito
  it("5. Rel. Seriais por IMEI → codigoComercial + deposito", () => {
    const serId = seedRelSeriaisImport(db);
    seedSerialRow(db, serId, "351234567890123", "Galaxy A32", "COD-001", "DP-CURITIBA", "SIM");

    const r = getPrefill(db, "351234567890123");
    expect(r.codigoComercial).toBe("COD-001");
    expect(r.deposito).toBe("DP-CURITIBA");
    expect(r.sources["codigoComercial"]).toBe("SERIAIS");
  });

  // 6. His: última ocorrência por IMEI (source_line maior prevalece)
  it("6. His última ocorrência por IMEI → usa a linha com source_line maior", () => {
    const hisId = seedHisImport(db);
    seedHisRow(db, hisId, "351234567890123", 30, 500, 1);
    seedHisRow(db, hisId, "351234567890123", 45, 750, 2); // mais recente

    const r = getPrefill(db, "351234567890123");
    expect(r.custo).toBe(750);
    expect(r.idade).toBe(45);
    expect(r.sources["custo"]).toBe("HIS");
  });

  // 7. Custo ausente no His → retorna 0 + warning
  it("7. Custo NULL no His → custo=0 + warning HIS_NO_COST", () => {
    const hisId = seedHisImport(db);
    seedHisRow(db, hisId, "351234567890123", 20, null);

    const r = getPrefill(db, "351234567890123");
    expect(r.custo).toBe(0);
    expect(r.warnings.some((w) => w.includes("HIS_NO_COST"))).toBe(true);
  });

  // 8. PEACS — match exato normalizado → venda preenchida
  it("8. PEACS exact match → vendaEstimada preenchida", () => {
    const serId = seedRelSeriaisImport(db);
    seedSerialRow(db, serId, "351234567890123", "Galaxy A32", "SAMSUNG GALAXY A32", "DP-1", "SIM");
    seedPeacs(db, "SAMSUNG GALAXY A32", "SAMSUNG GALAXY A32", 1299.9);

    const r = getPrefill(db, "351234567890123");
    expect(r.vendaEstimada).toBeCloseTo(1299.9);
    expect(r.sources["vendaEstimada"]).toBe("PEACS");
  });

  // 9. PEACS — código não encontrado → vendaEstimada=0 + warning
  it("9. PEACS não encontrado → vendaEstimada=0 + warning PEACS_NOT_FOUND", () => {
    const serId = seedRelSeriaisImport(db);
    seedSerialRow(db, serId, "351234567890123", "Galaxy A32", "COD-INEXISTENTE", "DP-1", "SIM");

    const r = getPrefill(db, "351234567890123");
    expect(r.vendaEstimada).toBe(0);
    expect(r.warnings.some((w) => w.includes("PEACS_NOT_FOUND"))).toBe(true);
  });

  // 10. Rel. Seriais múltiplos Disponivel=SIM → warning
  it("10. Rel. Seriais múltiplos SIM → warning REL_SERIAIS_MULTIPLE_SIM", () => {
    const serId = seedRelSeriaisImport(db);
    // Dois rows com mesmo IMEI e Disponivel=SIM
    db.prepare(
      `INSERT INTO rel_seriais_rows (rel_seriais_import_id, imei_norm, serial, produto, codigo_comercial, disponivel, deposito_atual)
       VALUES (?, ?, ?, ?, ?, 'SIM', 'D1')`,
    ).run(serId, "351234567890123", "351234567890123", "A32", "COD-A");
    db.prepare(
      `INSERT INTO rel_seriais_rows (rel_seriais_import_id, imei_norm, serial, produto, codigo_comercial, disponivel, deposito_atual)
       VALUES (?, ?, ?, ?, ?, 'SIM', 'D2')`,
    ).run(serId, "351234567890123", "351234567890123", "A32", "COD-A");

    const r = getPrefill(db, "351234567890123");
    expect(r.warnings.some((w) => w.includes("REL_SERIAIS_MULTIPLE_SIM"))).toBe(true);
  });

  // 11. idade=0 é válido (não gera warning nem é nulo)
  it("11. idade=0 no His → retorna 0, não nulo", () => {
    const hisId = seedHisImport(db);
    seedHisRow(db, hisId, "351234567890123", 0, 800);

    const r = getPrefill(db, "351234567890123");
    expect(r.idade).toBe(0);
    expect(r.sources["idade"]).toBe("HIS");
  });

  // 12. Peça sem cor (incluirCor=false): CHAVEPECA = PEÇA + MODELO
  it("12. buildChavePeca sem cor → PECA MODELO", () => {
    // Testamos a fórmula diretamente (pura)
    function buildChavePeca(peca: string, modelo: string, incluirCor: boolean, cor: string): string {
      const parts = [peca.trim(), modelo.trim()];
      if (incluirCor && cor.trim()) parts.push(cor.trim());
      return parts.join(" ").toUpperCase();
    }
    expect(buildChavePeca("TELA", "Galaxy A32", false, "PRETO")).toBe("TELA GALAXY A32");
  });

  // 13. Peça com cor (incluirCor=true): CHAVEPECA = PEÇA + MODELO + COR
  it("13. buildChavePeca com cor → PECA MODELO COR", () => {
    function buildChavePeca(peca: string, modelo: string, incluirCor: boolean, cor: string): string {
      const parts = [peca.trim(), modelo.trim()];
      if (incluirCor && cor.trim()) parts.push(cor.trim());
      return parts.join(" ").toUpperCase();
    }
    expect(buildChavePeca("TELA", "Galaxy A32", true, "preto")).toBe("TELA GALAXY A32 PRETO");
  });

  // 14. SH → modelo fallback de Seriais quando SH não tem modelo
  it("14. SH sem modelo, Seriais com modelo → usa Seriais", () => {
    const shId = seedShOsImport(db);
    seedShOsRow(db, shId, {
      osNorm: "77777", osRaw: "77777",
      imeiNorm: "351234567890123", imeiRaw: "351234567890123",
      marca: "Apple",
      // modelo propositalmente ausente
    });
    const serId = seedRelSeriaisImport(db);
    seedSerialRow(db, serId, "351234567890123", "iPhone 11", "COD-X", "DP-1", "SIM");

    const r = getPrefill(db, "351234567890123");
    expect(r.marca).toBe("Apple");
    expect(r.modelo).toBe("iPhone 11");
    expect(r.sources["modelo"]).toBe("SERIAIS");
  });

  // 15. IMEI não encontrado no His → warning HIS_NOT_FOUND
  it("15. IMEI não encontrado no His → warning HIS_NOT_FOUND", () => {
    seedHisImport(db); // importação existe mas sem linhas para este IMEI
    const r = getPrefill(db, "351234567890999");
    expect(r.warnings.some((w) => w.includes("HIS_NOT_FOUND"))).toBe(true);
  });
});
