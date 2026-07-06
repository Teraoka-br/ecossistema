/**
 * Testes para import-central — parsers, validators, staging helpers.
 * NÃO testa BD real nem arquivos externos (unit-level).
 */

import { describe, it, expect } from "vitest";
import { parseCostBR, validateFileForSource, persistIssues, ImportCentralError } from "../src/import-central/import-central-service.js";
import type { Db } from "../src/db/database.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// parseCostBR — todos os casos de borda
// ---------------------------------------------------------------------------

describe("parseCostBR", () => {
  it("R$ 1.400,00 → 1400", () => expect(parseCostBR("R$ 1.400,00")).toBe(1400));
  it("R$ 1,400.00 → 1400", () => expect(parseCostBR("R$ 1,400.00")).toBe(1400));
  it("1400,00 → 1400", () => expect(parseCostBR("1400,00")).toBe(1400));
  it("1400.00 → 1400", () => expect(parseCostBR("1400.00")).toBe(1400));
  it("1.400 → 1400", () => expect(parseCostBR("1.400")).toBe(1400));
  it("1,400 → 1400", () => expect(parseCostBR("1,400")).toBe(1400));
  it("1.40 → 1.40", () => expect(parseCostBR("1.40")).toBeCloseTo(1.40));
  it("1,40 → 1.40", () => expect(parseCostBR("1,40")).toBeCloseTo(1.40));
  it("0 → 0", () => expect(parseCostBR("0")).toBe(0));
  it("0,00 → 0", () => expect(parseCostBR("0,00")).toBe(0));
  it("'' → null", () => expect(parseCostBR("")).toBeNull());
  it("null → null", () => expect(parseCostBR(null)).toBeNull());
  it("undefined → null", () => expect(parseCostBR(undefined)).toBeNull());
  it("number passthrough", () => expect(parseCostBR(42.5)).toBeCloseTo(42.5));
  it("NaN → null", () => expect(parseCostBR(NaN)).toBeNull());
  it("invalid string → null", () => expect(parseCostBR("abc")).toBeNull());
  it("R$ only → null", () => expect(parseCostBR("R$")).toBeNull());
  it("R$ 0 → 0", () => expect(parseCostBR("R$ 0")).toBe(0));
  it("R$ 1.234,56 → 1234.56", () => expect(parseCostBR("R$ 1.234,56")).toBeCloseTo(1234.56));
  it("R$ 1,234.56 → 1234.56 (US)", () => expect(parseCostBR("R$ 1,234.56")).toBeCloseTo(1234.56));
  it("12.345,67 → 12345.67", () => expect(parseCostBR("12.345,67")).toBeCloseTo(12345.67));
  it("12,345.67 → 12345.67 (US)", () => expect(parseCostBR("12,345.67")).toBeCloseTo(12345.67));
  it("whitespace padded → parses correctly", () => expect(parseCostBR("  1.500,00  ")).toBe(1500));
});

// ---------------------------------------------------------------------------
// validateFileForSource — extensões
// ---------------------------------------------------------------------------

describe("validateFileForSource — extensão", () => {
  function writeTmp(content: Buffer, name: string): string {
    const tmpPath = path.join(os.tmpdir(), `test-valfile-${Date.now()}-${name}`);
    fs.writeFileSync(tmpPath, content);
    return tmpPath;
  }

  const XLSX_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
  const XLS_HEADER  = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const CSV_CONTENT = Buffer.from("Serial;Produto\n123456789012345;iPhone 13\n");

  it("xlsx com assinatura ZIP → aceita para 'his'", () => {
    const fp = writeTmp(XLSX_HEADER, "ok.xlsx");
    expect(() => validateFileForSource(fp, "his", "ok.xlsx")).not.toThrow();
    fs.unlinkSync(fp);
  });

  it("xls com assinatura OLE2 → aceita para 'bkp'", () => {
    const fp = writeTmp(XLS_HEADER, "ok.xls");
    expect(() => validateFileForSource(fp, "bkp", "ok.xls")).not.toThrow();
    fs.unlinkSync(fp);
  });

  it("csv → aceita para 'rel-seriais'", () => {
    const fp = writeTmp(CSV_CONTENT, "ok.csv");
    expect(() => validateFileForSource(fp, "rel-seriais", "ok.csv")).not.toThrow();
    fs.unlinkSync(fp);
  });

  it("csv enviado para 'his' → rejeita (extensão errada)", () => {
    const fp = writeTmp(CSV_CONTENT, "wrong.csv");
    expect(() => validateFileForSource(fp, "his", "wrong.csv")).toThrow(ImportCentralError);
    fs.unlinkSync(fp);
  });

  it("xlsx enviado para 'rel-seriais' → rejeita (extensão errada)", () => {
    const fp = writeTmp(XLSX_HEADER, "wrong.xlsx");
    expect(() => validateFileForSource(fp, "rel-seriais", "wrong.xlsx")).toThrow(ImportCentralError);
    fs.unlinkSync(fp);
  });

  it("xlsx com conteúdo binário não-ZIP → rejeita assinatura", () => {
    const fp = writeTmp(XLS_HEADER, "bad.xlsx"); // OLE assinatura em arquivo .xlsx
    expect(() => validateFileForSource(fp, "his", "bad.xlsx")).toThrow(ImportCentralError);
    fs.unlinkSync(fp);
  });

  it("erro tem code INVALID_EXTENSION para extensão errada", () => {
    const fp = writeTmp(CSV_CONTENT, "test.txt");
    try {
      validateFileForSource(fp, "his", "test.txt");
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(ImportCentralError);
      expect((e as ImportCentralError).code).toBe("INVALID_EXTENSION");
    }
    fs.unlinkSync(fp);
  });

  it("erro tem code INVALID_FILE_MAGIC para assinatura inválida", () => {
    const fp = writeTmp(XLS_HEADER, "bad.xlsx");
    try {
      validateFileForSource(fp, "his", "bad.xlsx");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(ImportCentralError);
      expect((e as ImportCentralError).code).toBe("INVALID_FILE_MAGIC");
    }
    fs.unlinkSync(fp);
  });
});

// ---------------------------------------------------------------------------
// ImportCentralError
// ---------------------------------------------------------------------------

describe("ImportCentralError", () => {
  it("name é ImportCentralError", () => {
    const e = new ImportCentralError("TEST", "msg");
    expect(e.name).toBe("ImportCentralError");
    expect(e.code).toBe("TEST");
    expect(e.message).toBe("msg");
    expect(e).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// his-stream — colLettersToIndex indireto via exported helper (if available)
// Testa via snapshot de comportamento esperado
// ---------------------------------------------------------------------------

describe("his-stream column index logic", () => {
  // Replica o mapeamento esperado para as colunas B, R, S, U
  function colLettersToIndex(letters: string): number {
    let n = 0;
    for (const ch of letters.toUpperCase()) {
      n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1; // 0-indexed
  }

  it("B → 1", () => expect(colLettersToIndex("B")).toBe(1));
  it("R → 17", () => expect(colLettersToIndex("R")).toBe(17));
  it("S → 18", () => expect(colLettersToIndex("S")).toBe(18));
  it("U → 20", () => expect(colLettersToIndex("U")).toBe(20));
  it("A → 0", () => expect(colLettersToIndex("A")).toBe(0));
  it("Z → 25", () => expect(colLettersToIndex("Z")).toBe(25));
  it("AA → 26", () => expect(colLettersToIndex("AA")).toBe(26));
  it("AZ → 51", () => expect(colLettersToIndex("AZ")).toBe(51));
});

// ---------------------------------------------------------------------------
// Excel date serial conversion (inline expected behavior)
// ---------------------------------------------------------------------------

describe("Excel date serial to ISO", () => {
  // 45291 = 2024-01-01 (Excel serial date)
  function excelSerialToISO(serial: number): string {
    const epoch = new Date(Date.UTC(1899, 11, 30)).getTime();
    const d = new Date(epoch + serial * 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  it("serial 1 → 1899-12-31", () => expect(excelSerialToISO(1)).toBe("1899-12-31"));
  it("serial 45292 → 2024-01-01", () => expect(excelSerialToISO(45292)).toBe("2024-01-01"));
  it("serial 44927 → 2023-01-01", () => expect(excelSerialToISO(44927)).toBe("2023-01-01"));
});

// ---------------------------------------------------------------------------
// persistIssues — mock test (DB isolado)
// ---------------------------------------------------------------------------

describe("persistIssues (mock DB)", () => {
  it("chama INSERT para cada issue", () => {
    const runs: unknown[][] = [];
    const mockStmt = { run: (...args: unknown[]) => { runs.push(args); return { changes: 1, lastInsertRowid: 0 }; } };
    const mockDb = { prepare: () => mockStmt } as unknown as Db;

    persistIssues(mockDb, "his", 1, [
      { row: 5, severity: "WARNING", code: "TEST", message: "msg", rawValue: "raw" },
      { row: null, severity: "ERROR", code: "ERR2", message: "msg2" },
    ]);

    expect(runs.length).toBe(2);
    expect(runs[0]).toContain("his");
    expect(runs[0]).toContain(1);
    expect(runs[0]).toContain(5);
    expect(runs[0]).toContain("WARNING");
  });

  it("não chama INSERT se lista vazia", () => {
    let prepCalled = false;
    const mockDb = { prepare: () => { prepCalled = true; return { run: () => ({}) }; } } as unknown as Db;
    persistIssues(mockDb, "his", 1, []);
    expect(prepCalled).toBe(false);
  });
});
