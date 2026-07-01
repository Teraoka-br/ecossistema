import type { TableRole } from "../shared/types.js";
import { normalizeHeader } from "../domain/text.js";
import { ROLE_SPECS, resolveColumns, type ColumnIndex } from "./columns.js";
import type { SheetMatrix } from "./xlsx-reader.js";

/** União de todos os apelidos de cabeçalho conhecidos (para achar a linha-cabeçalho). */
const KNOWN_HEADERS: ReadonlySet<string> = new Set(
  ROLE_SPECS.flatMap((s) => Object.values(s.fields).flat()),
);

/**
 * Nomes de aba candidatos por papel (heurística para REDUZIR o conjunto inicial
 * de abas lidas — nunca a autoridade final). A detecção por conteúdo de
 * cabeçalho (`detectSheet`) continua decidindo o papel real de cada aba.
 */
const ROLE_NAME_HINTS: Record<"ORDERS" | "INVENTORY" | "QUOTATIONS" | "ANALYSIS", string[]> = {
  ORDERS: ["PEDIDOS", "ANALISE_MI", "ANALISE MI", "PEDIDOS FULL"],
  INVENTORY: ["BIPAGEM DE PECAS", "CONTAGEM DE PECAS"],
  ANALYSIS: ["ANALISEMI", "ANALISE"],
  QUOTATIONS: ["PECAS A PEDIR"],
};

const ALL_NAME_HINTS_NORMALIZED: string[] = Object.values(ROLE_NAME_HINTS)
  .flat()
  .map(normalizeHeader);

/**
 * Abas claramente históricas/volumosas, conhecidas por nunca conter as
 * tabelas de pedidos/estoque/cotação/análise — nunca são lidas, nem na
 * primeira passagem nem na expansão de fallback (mesmo só para cabeçalho).
 */
const HISTORICAL_NAME_SUBSTRINGS: string[] = [
  "HIS ESTOQUE",
  "TODOS",
  "COM SALDO",
  "DEMONSTRATIVO DE SALDO",
  "TABELA DE AVALIACAO",
].map(normalizeHeader);
const HISTORICAL_EXACT_NAMES: string[] = ["SH"].map(normalizeHeader);

/** Aba claramente histórica/volumosa — nunca é lida (nem para cabeçalho). */
export function isHistoricalSheetName(name: string): boolean {
  const n = normalizeHeader(name);
  if (HISTORICAL_EXACT_NAMES.includes(n)) return true;
  return HISTORICAL_NAME_SUBSTRINGS.some((h) => n.includes(h));
}

/** Nome de aba candidato a algum papel conhecido (heurística de 1ª passagem). */
export function isCandidateSheetName(name: string): boolean {
  if (isHistoricalSheetName(name)) return false;
  const n = normalizeHeader(name);
  return ALL_NAME_HINTS_NORMALIZED.some((hint) => n.includes(hint));
}

export interface RoleMatch {
  role: TableRole;
  score: number;
  columns: ColumnIndex;
  matched: string[];
  missingRequired: string[];
  /** true quando todos os obrigatórios estão presentes. */
  ok: boolean;
}

export interface SheetDetection {
  fileName: string;
  sheetName: string;
  /** índice (0-based) da linha-cabeçalho dentro da matriz. */
  headerRowIndex: number;
  /** número da linha do Excel (1-based) onde está o cabeçalho. */
  headerRowNumber: number;
  /** número da linha do Excel (1-based) da primeira linha de DADOS. */
  firstDataRowNumber: number;
  normalizedHeader: string[];
  roleMatches: RoleMatch[];
}

/** Acha a linha-cabeçalho: a que casa mais apelidos conhecidos (mínimo 3). */
export function detectHeaderRow(matrix: SheetMatrix): { index: number; normalized: string[] } | null {
  let bestIndex = -1;
  let bestCount = 0;
  let bestNormalized: string[] = [];
  const scan = Math.min(matrix.rows.length, 15);
  for (let i = 0; i < scan; i++) {
    const normalized = matrix.rows[i].map((c) => normalizeHeader(c.value));
    const count = normalized.filter((h) => h !== "" && KNOWN_HEADERS.has(h)).length;
    if (count > bestCount) {
      bestCount = count;
      bestIndex = i;
      bestNormalized = normalized;
    }
  }
  if (bestIndex < 0 || bestCount < 3) return null;
  return { index: bestIndex, normalized: bestNormalized };
}

/** Detecta cabeçalho e papéis de uma aba. */
export function detectSheet(fileName: string, matrix: SheetMatrix): SheetDetection | null {
  const header = detectHeaderRow(matrix);
  if (!header) return null;
  const roleMatches: RoleMatch[] = [];
  for (const spec of ROLE_SPECS) {
    const { columns, matched, missingRequired } = resolveColumns(spec, header.normalized);
    if (matched.length === 0) continue;
    roleMatches.push({
      role: spec.role,
      score: matched.length,
      columns,
      matched,
      missingRequired,
      ok: missingRequired.length === 0,
    });
  }
  const headerRowNumber = matrix.firstRowNumber + header.index;
  return {
    fileName,
    sheetName: matrix.name,
    headerRowIndex: header.index,
    headerRowNumber,
    firstDataRowNumber: headerRowNumber + 1,
    normalizedHeader: header.normalized,
    roleMatches,
  };
}

export interface FileSheets {
  fileName: string;
  matrices: SheetMatrix[];
}

export interface RoleAssignment {
  detection: SheetDetection;
  match: RoleMatch;
}

export interface Assignment {
  orders?: RoleAssignment;
  inventory?: RoleAssignment;
  quotations?: RoleAssignment;
  analysis?: RoleAssignment;
  ordersSecondary?: RoleAssignment;
  allDetections: SheetDetection[];
}

function nameHas(detection: SheetDetection, needle: string): boolean {
  return normalizeHeader(detection.sheetName).includes(needle);
}

/**
 * Atribui cada papel à melhor aba entre TODOS os arquivos, pelo conteúdo dos
 * cabeçalhos (robusto a troca de posição/arquivo). Precedência:
 *   - estoque: prefere aba "por unidade" (sem coluna QTDE);
 *   - pedidos: prefere o mesmo arquivo do estoque (PEDIDOS.xlsx prevalece);
 *   - cotações/análise: melhor casamento.
 */
export function assignRoles(files: FileSheets[]): Assignment {
  const detections: SheetDetection[] = [];
  for (const f of files) {
    for (const m of f.matrices) {
      const d = detectSheet(f.fileName, m);
      if (d) detections.push(d);
    }
  }
  return assignRolesFromDetections(detections);
}

/**
 * Mesma lógica de atribuição de `assignRoles`, mas a partir de um array de
 * detecções já calculado — usada pela detecção em etapas (`import-service.ts`),
 * que só roda `detectSheet` sobre o subconjunto de abas lido em cada etapa.
 */
export function assignRolesFromDetections(detections: SheetDetection[]): Assignment {
  const okMatches = (role: TableRole): RoleAssignment[] =>
    detections
      .map((d) => ({ detection: d, match: d.roleMatches.find((r) => r.role === role && r.ok) }))
      .filter((x): x is RoleAssignment => x.match !== undefined);

  // INVENTORY: prefere "sem QTDE" (cada linha = uma unidade) e nome "BIPAG".
  const invCands = okMatches("INVENTORY").sort((a, b) => {
    const aQtde = "qtde" in a.match.columns ? 1 : 0;
    const bQtde = "qtde" in b.match.columns ? 1 : 0;
    if (aQtde !== bQtde) return aQtde - bQtde;
    const aBip = nameHas(a.detection, "BIPAG") ? 0 : 1;
    const bBip = nameHas(b.detection, "BIPAG") ? 0 : 1;
    if (aBip !== bBip) return aBip - bBip;
    return b.match.score - a.match.score;
  });
  const inventory = invCands[0];
  const inventoryFile = inventory?.detection.fileName;

  // ORDERS: prefere mesmo arquivo do estoque; evita abas "FULL".
  const orderCands = okMatches("ORDERS").sort((a, b) => {
    const aSame = a.detection.fileName === inventoryFile ? 0 : 1;
    const bSame = b.detection.fileName === inventoryFile ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;
    const aFull = nameHas(a.detection, "FULL") ? 1 : 0;
    const bFull = nameHas(b.detection, "FULL") ? 1 : 0;
    if (aFull !== bFull) return aFull - bFull;
    return b.match.score - a.match.score;
  });
  const orders = orderCands[0];

  // QUOTATIONS: melhor casamento.
  const quotations = okMatches("QUOTATIONS").sort((a, b) => b.match.score - a.match.score)[0];

  // ANALYSIS: prefere nome "ANALISE"; depois score.
  const analysis = okMatches("ANALYSIS").sort((a, b) => {
    const aAna = nameHas(a.detection, "ANALISE") ? 0 : 1;
    const bAna = nameHas(b.detection, "ANALISE") ? 0 : 1;
    if (aAna !== bAna) return aAna - bAna;
    return b.match.score - a.match.score;
  })[0];

  // ORDERS_SECONDARY: melhor aba de pedidos em arquivo diferente do primário.
  const ordersSecondary = orderCands.find(
    (c) => orders && c.detection.fileName !== orders.detection.fileName,
  );

  return { orders, inventory, quotations, analysis, ordersSecondary, allDetections: detections };
}
