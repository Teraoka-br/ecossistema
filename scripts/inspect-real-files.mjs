// Inspeciona estrutura real dos 7 arquivos da Central de Dados
// node scripts/inspect-real-files.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const FILES = [
  {
    label: "Rel_Estoque_de_Seriais.csv",
    path: "C:\\Users\\Rocha Telecom\\Downloads\\Rel_Estoque_de_Seriais.csv",
    type: "csv",
  },
  {
    label: "CONTROLE DE ENTRADA TRADE-IN.xlsx",
    path: "C:\\Users\\Rocha Telecom\\Downloads\\BD-ECOSSISTEMA\\ECOSSISTEMA PEDIDO DE PEÇAS\\CONTROLE DE ENTRADA TRADE-IN.xlsx",
    type: "xlsx",
    targetSheets: ["His Estoque", "his estoque", "HIS ESTOQUE"],
  },
  {
    label: "ANALISE MI.xlsx",
    path: "C:\\Users\\Rocha Telecom\\Downloads\\BD-ECOSSISTEMA\\ECOSSISTEMA PEDIDO DE PEÇAS\\ANALISE MI.xlsx",
    type: "xlsx",
    targetSheets: ["ANALISEMI", "ANALISE MI", "ANALISE"],
  },
  {
    label: "PEDIDOS.xlsx",
    path: "C:\\Users\\Rocha Telecom\\Downloads\\BD-ECOSSISTEMA\\ECOSSISTEMA PEDIDO DE PEÇAS\\PEDIDOS.xlsx",
    type: "xlsx",
    targetSheets: ["PEDIDOS", "BIPAGEM DE PEÇAS", "BIPAGEM", "TABELA DE AVALIAÇÃO", "PEACS"],
  },
  {
    label: "BKP SISTEMICO.xlsx",
    path: "C:\\Users\\Rocha Telecom\\Downloads\\BD-ECOSSISTEMA\\ECOSSISTEMA PEDIDO DE PEÇAS\\BKP SISTEMICO.xlsx",
    type: "xlsx",
    targetSheets: ["REPAROS TECNICOS", "BAIXA_DE_PEÇA", "BAIXA DE PEÇA", "BAIXA_DE_PECA", "TRIAGEM ENTRADA"],
  },
  {
    label: "TRIAGEM SAIDA.xlsx",
    path: "C:\\Users\\Rocha Telecom\\Downloads\\BD-ECOSSISTEMA\\ECOSSISTEMA PEDIDO DE PEÇAS\\TRIAGEM SAIDA.xlsx",
    type: "xlsx",
    targetSheets: ["triagem saida", "TRIAGEM SAIDA", "Triagem Saida"],
  },
  {
    label: "sH.xls",
    path: "C:\\Users\\Rocha Telecom\\Downloads\\BD-ECOSSISTEMA\\ECOSSISTEMA PEDIDO DE PEÇAS\\REPOSITÓRIOS\\sH.xlsx",
    type: "xlsx",
    altPath: "C:\\Users\\Rocha Telecom\\Downloads\\sH.xls",
  },
];

function readXlsxHeaders(filePath, targetSheets) {
  const start = Date.now();
  let wb;
  try {
    // Performance: only parse what we need
    wb = XLSX.readFile(filePath, { sheetStubs: false, cellFormula: false, cellHTML: false });
  } catch (e) {
    return { error: String(e), ms: Date.now() - start };
  }
  const ms = Date.now() - start;

  const allSheets = wb.SheetNames;
  const result = { allSheets, sheets: {}, ms };

  // Determine which sheets to inspect
  const toInspect = targetSheets
    ? allSheets.filter(n => targetSheets.some(t => n.trim().toUpperCase() === t.toUpperCase()))
    : allSheets.slice(0, 5);

  if (toInspect.length === 0 && targetSheets) {
    // Fallback: show first 2 sheets anyway
    toInspect.push(...allSheets.slice(0, 2));
    result.targetNotFound = true;
  }

  for (const sheetName of toInspect) {
    const ws = wb.Sheets[sheetName];
    // Read first 5 rows to get headers + sample
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, range: 0, defval: null });
    const firstNonEmpty = rows.findIndex(r => r.some(c => c != null));
    const headerRow = firstNonEmpty >= 0 ? rows[firstNonEmpty] : [];
    const sampleRow = rows[firstNonEmpty + 1] ?? [];

    // Count total rows (range)
    const ref = ws["!ref"];
    let totalRows = 0;
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      totalRows = range.e.r - range.s.r;
    }

    result.sheets[sheetName] = {
      totalRows,
      headerRow: headerRow.map(h => h == null ? "(vazio)" : String(h)),
      sampleRow: sampleRow.map(v => v == null ? null : String(v).slice(0, 30)),
      headerRowIndex: firstNonEmpty,
    };
  }

  return result;
}

function readCsvHeaders(filePath) {
  const start = Date.now();
  try {
    const content = fs.readFileSync(filePath, "latin1");
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    const sep = lines[0].includes(";") ? ";" : ",";
    const header = lines[0].split(sep).map(h => h.trim());
    const sample = lines[1] ? lines[1].split(sep).map(v => v.trim().slice(0, 30)) : [];
    return { header, sample, totalRows: lines.length - 1, sep, ms: Date.now() - start };
  } catch (e) {
    return { error: String(e), ms: Date.now() - start };
  }
}

// Main
for (const file of FILES) {
  let filePath = file.path;

  // Try alt path if primary doesn't exist
  if (!fs.existsSync(filePath) && file.altPath) {
    filePath = file.altPath;
  }

  console.log("\n" + "=".repeat(70));
  console.log(`FILE: ${file.label}`);
  console.log(`PATH: ${filePath}`);
  console.log(`EXISTS: ${fs.existsSync(filePath)}`);

  if (!fs.existsSync(filePath)) {
    console.log("  *** ARQUIVO NÃO ENCONTRADO ***");
    // Try to find it
    const base = path.basename(filePath);
    console.log(`  Tentando localizar '${base}'...`);
    continue;
  }

  const stat = fs.statSync(filePath);
  console.log(`SIZE: ${(stat.size / 1024).toFixed(1)} KB`);

  if (file.type === "csv") {
    const r = readCsvHeaders(filePath);
    if (r.error) { console.log("ERRO:", r.error); continue; }
    console.log(`SEP: '${r.sep}' | ROWS: ${r.totalRows} | TIME: ${r.ms}ms`);
    console.log("HEADERS:", JSON.stringify(r.header));
    console.log("SAMPLE: ", JSON.stringify(r.sample));
  } else {
    const r = readXlsxHeaders(filePath, file.targetSheets);
    if (r.error) { console.log("ERRO:", r.error); continue; }
    console.log(`ALL SHEETS: ${JSON.stringify(r.allSheets)} | TIME: ${r.ms}ms`);
    if (r.targetNotFound) console.log("  *** SHEET ALVO NÃO ENCONTRADO — mostrando primeiras abas ***");
    for (const [sheet, info] of Object.entries(r.sheets)) {
      console.log(`\n  SHEET: "${sheet}" (${info.totalRows} rows, header at row ${info.headerRowIndex})`);
      console.log("  HEADERS:", JSON.stringify(info.headerRow));
      console.log("  SAMPLE: ", JSON.stringify(info.sampleRow));
    }
  }
}
console.log("\n" + "=".repeat(70));
console.log("DONE");
