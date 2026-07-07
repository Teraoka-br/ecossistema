/**
 * Streaming parser for XLSX "His Estoque" worksheets.
 *
 * Reads only columns B (Serial/IMEI), R (Dias em Estoque), S (Custo estoque),
 * U (Data Relatorio) without materialising every cell in memory.
 *
 * Approach: manual ZIP directory → zlib.inflateRaw stream → row-accumulator →
 * targeted column extraction via indexOf (no full-row regex).
 * Shared strings are loaded once into memory via indexOf-based parser (O(n)).
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import type { ImportIssueRaw } from "./import-central-service.js";

// ---------------------------------------------------------------------------
// Column indices (0-based): B=1, R=17, S=18, U=20
// ---------------------------------------------------------------------------
const COL_IMEI = 1;   // B
const COL_AGE  = 17;  // R
const COL_COST = 18;  // S
const COL_DATE = 20;  // U

// Only parse cells in these column letters
const TARGET_COLS = new Set(["B", "R", "S", "U"]);

/** Last-occurrence row collected per IMEI */
export interface HisRowData {
  imeiRaw: string;
  imeiNorm: string;
  ageDays: number | null;
  cost: number | null;
  reportDate: string | null;
  sourceLine: number;
}

export interface HisStreamResult {
  lastByImei: Map<string, HisRowData>;
  totalDataLines: number;  // data rows (excluding header)
  headerLine: number;
  warnings: ImportIssueRaw[];
  sampleRows: HisRowData[];  // first ≤20 valid rows collected
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (handles standard ZIP, not ZIP64)
// ---------------------------------------------------------------------------

interface ZipEntry {
  method: number;
  compressedSize: number;
  dataOffset: number;
}

function parseZipDirectory(buf: Buffer): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();

  let eocd = -1;
  const searchFrom = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP: EOCD não encontrado — arquivo corrompido?");

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount  = buf.readUInt16LE(eocd + 8);

  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method      = buf.readUInt16LE(pos + 10);
    const compSize    = buf.readUInt32LE(pos + 20);
    const fnLen       = buf.readUInt16LE(pos + 28);
    const extraLen    = buf.readUInt16LE(pos + 30);
    const commentLen  = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name        = buf.subarray(pos + 46, pos + 46 + fnLen).toString("utf8");

    const lhFnLen    = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + lhFnLen + lhExtraLen;

    entries.set(name, { method, compressedSize: compSize, dataOffset });
    pos += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.method === 0) {
    return buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  }
  const compressed = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  return zlib.inflateRawSync(compressed);
}

/** Create a streaming Readable that yields decompressed bytes of a ZIP entry. */
function streamEntry(buf: Buffer, entry: ZipEntry): NodeJS.ReadableStream {
  const compressed = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) {
    return Readable.from(compressed);
  }
  const src = Readable.from(compressed);
  const inflate = zlib.createInflateRaw();
  src.pipe(inflate);
  return inflate;
}

// ---------------------------------------------------------------------------
// Shared strings (xl/sharedStrings.xml) — O(n) indexOf-based parser
// ---------------------------------------------------------------------------

function parseSharedStrings(xmlBuf: Buffer): string[] {
  const xml = xmlBuf.toString("utf8");
  const result: string[] = [];
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const siStart = xml.indexOf("<si>", i);
    if (siStart < 0) break;
    const siEnd = xml.indexOf("</si>", siStart + 4);
    if (siEnd < 0) break;
    const siContent = xml.slice(siStart + 4, siEnd);

    // Concatenate all <t>...</t> segments (handles rich text)
    let text = "";
    let j = 0;
    while (j < siContent.length) {
      const tStart = siContent.indexOf("<t", j);
      if (tStart < 0) break;
      const tClose = siContent.indexOf(">", tStart);
      if (tClose < 0) break;
      const tEnd = siContent.indexOf("</t>", tClose + 1);
      if (tEnd < 0) break;
      text += unescapeXml(siContent.slice(tClose + 1, tEnd));
      j = tEnd + 4;
    }
    result.push(text);
    i = siEnd + 5;
  }
  return result;
}

function unescapeXml(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------------------
// Workbook → find sheet XML path
// ---------------------------------------------------------------------------

function findSheetPath(buf: Buffer, entries: Map<string, ZipEntry>, sheetName: string): string {
  const wbEntry = entries.get("xl/workbook.xml");
  if (!wbEntry) throw new Error("xl/workbook.xml não encontrado no XLSX");
  const wbXml = inflateEntry(buf, wbEntry).toString("utf8");

  const sheetRe = /<sheet\s[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*/g;
  let m: RegExpExecArray | null;
  let rId: string | null = null;
  while ((m = sheetRe.exec(wbXml)) !== null) {
    if (m[1] === sheetName) { rId = m[2]; break; }
  }
  if (!rId) {
    const allSheets: string[] = [];
    const listRe = /<sheet\s[^>]*name="([^"]*)"/g;
    let n: RegExpExecArray | null;
    while ((n = listRe.exec(wbXml)) !== null) allSheets.push(n[1]);
    throw new Error(`Aba "${sheetName}" não encontrada. Abas: ${allSheets.join(", ")}`);
  }

  const relsEntry =
    entries.get("xl/_rels/workbook.xml.rels") ??
    entries.get("xl/workbook.xml.rels");
  if (!relsEntry) throw new Error("xl/_rels/workbook.xml.rels não encontrado");
  const relsXml = inflateEntry(buf, relsEntry).toString("utf8");
  const relRe = new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*Target="([^"]*)"`, "i");
  const relMatch = relRe.exec(relsXml);
  if (!relMatch) throw new Error(`Relacionamento rId="${rId}" não encontrado em rels`);
  return "xl/" + relMatch[1];
}

// ---------------------------------------------------------------------------
// Cell parsing — targeted extraction (only B, R, S, U columns)
// ---------------------------------------------------------------------------

/** Convert column letters (A, B, ..., Z, AA, ...) to 0-based index */
function colLettersToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

/**
 * Extract only target-column cells from a <row>...</row> XML string.
 * Uses indexOf instead of regex to avoid O(n²) behavior on wide rows.
 */
function extractTargetCells(rowXml: string): Map<number, { rawValue: string; isSharedStr: boolean }> {
  const cells = new Map<number, { rawValue: string; isSharedStr: boolean }>();
  let pos = 0;
  const len = rowXml.length;

  while (pos < len) {
    const cs = rowXml.indexOf("<c ", pos);
    if (cs < 0) break;

    // Find end of the opening tag (<c ... >)
    const tagEnd = rowXml.indexOf(">", cs);
    if (tagEnd < 0) break;

    const tag = rowXml.slice(cs, tagEnd + 1);

    // Extract column letters from r="COLrow" attribute
    const rAttr = tag.indexOf(' r="');
    if (rAttr < 0) { pos = cs + 3; continue; }
    let colEnd = rAttr + 4;
    while (colEnd < tag.length) {
      const ch = tag.charCodeAt(colEnd);
      if (ch < 65 || ch > 90) break; // A-Z only
      colEnd++;
    }
    const colLetter = tag.slice(rAttr + 4, colEnd);

    // Find next <c to bound this cell's extent
    const nextC = rowXml.indexOf("<c ", cs + 3);
    const cellEnd = nextC > 0 ? nextC : len;

    if (TARGET_COLS.has(colLetter)) {
      const colIdx = colLettersToIndex(colLetter);
      const isSharedStr = tag.includes(' t="s"');
      const vStart = rowXml.indexOf("<v>", cs);
      const vEnd = (vStart >= 0 && vStart < cellEnd) ? rowXml.indexOf("</v>", vStart) : -1;
      const rawValue = (vEnd >= 0 && vEnd < cellEnd) ? rowXml.slice(vStart + 3, vEnd) : "";
      cells.set(colIdx, { rawValue, isSharedStr });
    }

    pos = cellEnd;
  }
  return cells;
}

/** Excel serial date → ISO date string */
function excelSerialToISO(serial: number): string {
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const date = new Date(epoch.getTime() + serial * 86400000);
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function normalizeImeiLocal(raw: string): string | null {
  const s = raw.replace(/'/g, "").replace(/\D/g, "").trim();
  return s.length >= 10 ? s : null;
}

function parseCostLocal(raw: string): number | null {
  if (!raw) return null;
  const s = raw.replace(/[R$\s]/g, "").trim();
  if (!s) return null;
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  let normalized: string;
  if (hasDot && hasComma) {
    normalized = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    normalized = s.replace(",", ".");
  } else {
    normalized = s;
  }
  const v = parseFloat(normalized);
  return isNaN(v) ? null : v;
}

// ---------------------------------------------------------------------------
// Main streaming function
// ---------------------------------------------------------------------------

export async function streamHisEstoque(
  filePath: string,
  sheetName = "His Estoque",
): Promise<HisStreamResult> {
  const buf = fs.readFileSync(filePath);
  const entries = parseZipDirectory(buf);

  let sharedStrings: string[] = [];
  const ssEntry = entries.get("xl/sharedStrings.xml");
  if (ssEntry) {
    sharedStrings = parseSharedStrings(inflateEntry(buf, ssEntry));
  }

  const sheetPath = findSheetPath(buf, entries, sheetName);
  const sheetEntry = entries.get(sheetPath);
  if (!sheetEntry)
    throw new Error(`Arquivo de planilha "${sheetPath}" não encontrado no ZIP`);

  const lastByImei = new Map<string, HisRowData>();
  const warnings: ImportIssueRaw[] = [];
  const sampleRows: HisRowData[] = [];
  let totalDataLines = 0;
  let headerLine = 0;
  let isHeaderFound = false;

  const xmlStream = streamEntry(buf, sheetEntry);

  let rowBuf = "";
  let xmlRowNum = 0;

  const rowProcessor = (rowXml: string, rNum: number) => {
    const cells = extractTargetCells(rowXml);
    const bCell = cells.get(COL_IMEI);
    if (!isHeaderFound) {
      if (bCell) {
        const bVal = bCell.isSharedStr
          ? (sharedStrings[parseInt(bCell.rawValue, 10)] ?? "")
          : bCell.rawValue;
        const norm = bVal.toUpperCase().replace(/\s+/g, "");
        if (norm === "SERIAL" || norm === "IMEI") {
          isHeaderFound = true;
          headerLine = rNum;
          return;
        }
      }
      if (rNum >= 3) { isHeaderFound = true; headerLine = 1; }
      else return;
    }

    totalDataLines++;

    if (!bCell) return;

    const imeiRaw = bCell.isSharedStr
      ? (sharedStrings[parseInt(bCell.rawValue, 10)] ?? "")
      : bCell.rawValue;
    const imeiNorm = normalizeImeiLocal(imeiRaw);
    if (!imeiNorm) return;

    const ageCell = cells.get(COL_AGE);
    let ageDays: number | null = null;
    if (ageCell && ageCell.rawValue !== "") {
      const n = parseFloat(ageCell.rawValue);
      ageDays = isNaN(n) ? null : Math.round(n);
    }

    const costCell = cells.get(COL_COST);
    let cost: number | null = null;
    if (costCell && costCell.rawValue !== "") {
      if (costCell.isSharedStr) {
        cost = parseCostLocal(sharedStrings[parseInt(costCell.rawValue, 10)] ?? "");
      } else {
        const n = parseFloat(costCell.rawValue);
        cost = isNaN(n) ? null : n;
      }
    }

    const dateCell = cells.get(COL_DATE);
    let reportDate: string | null = null;
    if (dateCell && dateCell.rawValue !== "") {
      if (dateCell.isSharedStr) {
        reportDate = sharedStrings[parseInt(dateCell.rawValue, 10)] ?? null;
      } else {
        const n = parseFloat(dateCell.rawValue);
        if (!isNaN(n) && n > 1) {
          try { reportDate = excelSerialToISO(n); } catch { /* ignore */ }
        } else if (dateCell.rawValue.length > 5) {
          reportDate = dateCell.rawValue;
        }
      }
    }

    const prev = lastByImei.get(imeiNorm);
    if (prev && prev.reportDate && reportDate && reportDate < prev.reportDate) {
      if (warnings.length < 50) {
        warnings.push({
          row: rNum,
          severity: "WARNING",
          code: "DATE_OUT_OF_ORDER",
          message: `IMEI ${imeiNorm}: data ${reportDate} < ocorrência anterior ${prev.reportDate}. Última linha física vence.`,
          rawValue: reportDate,
        });
      }
    }

    const rowData: HisRowData = { imeiRaw, imeiNorm, ageDays, cost, reportDate, sourceLine: rNum };
    lastByImei.set(imeiNorm, rowData);
    if (sampleRows.length < 20) sampleRows.push(rowData);
  };

  await new Promise<void>((resolve, reject) => {
    xmlStream.on("error", reject);
    xmlStream.on("data", (chunk: Buffer | string) => {
      rowBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");

      let start = 0;
      while (true) {
        const rowStart = rowBuf.indexOf("<row ", start);
        if (rowStart < 0) {
          rowBuf = rowBuf.slice(start);
          break;
        }
        const rowEnd = rowBuf.indexOf("</row>", rowStart);
        if (rowEnd < 0) {
          rowBuf = rowBuf.slice(rowStart);
          break;
        }
        const rowXml = rowBuf.slice(rowStart, rowEnd + 6);
        const rAttr = /\br="(\d+)"/.exec(rowXml);
        const rNum = rAttr ? parseInt(rAttr[1], 10) : (xmlRowNum + 1);
        xmlRowNum = rNum;
        try { rowProcessor(rowXml, rNum); } catch { /* skip malformed row */ }
        start = rowEnd + 6;
      }
    });
    xmlStream.on("end", () => {
      let start = 0;
      while (true) {
        const rowStart = rowBuf.indexOf("<row ", start);
        if (rowStart < 0) break;
        const rowEnd = rowBuf.indexOf("</row>", rowStart);
        if (rowEnd < 0) break;
        const rowXml = rowBuf.slice(rowStart, rowEnd + 6);
        const rAttr = /\br="(\d+)"/.exec(rowXml);
        const rNum = rAttr ? parseInt(rAttr[1], 10) : (xmlRowNum + 1);
        xmlRowNum = rNum;
        try { rowProcessor(rowXml, rNum); } catch { /* ignore */ }
        start = rowEnd + 6;
      }
      resolve();
    });
  });

  return { lastByImei, totalDataLines, headerLine, warnings, sampleRows };
}
