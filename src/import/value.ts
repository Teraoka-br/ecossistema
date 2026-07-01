/**
 * Coerção de valores de célula vindos do xlsx.
 *
 * Célula de erro de fórmula (#N/A, #VALUE!, ...) é representada com
 * `error != null`. A decisão de virar null+warning (campo opcional) ou
 * erro (campo obrigatório) é tomada pela camada de mapeamento.
 */

export interface RawCell {
  value: string | number | boolean | Date | null;
  /** Texto do erro de fórmula, quando a célula é do tipo erro. */
  error: string | null;
}

/** Códigos de erro do formato XLSX → rótulo legível. */
const XLSX_ERROR_BY_CODE: Record<number, string> = {
  0x00: "#NULL!",
  0x07: "#DIV/0!",
  0x0f: "#VALUE!",
  0x17: "#REF!",
  0x1d: "#NAME?",
  0x24: "#NUM!",
  0x2a: "#N/A",
  0x2b: "#GETTING_DATA",
};

const FORMULA_ERROR_RE = /^#(N\/A|N\/D|VALUE!|REF!|NAME\?|DIV\/0!|NUM!|NULL!|GETTING_DATA)/i;

/** Mapeia um valor textual de erro de fórmula. */
export function detectFormulaErrorText(text: string): string | null {
  const t = text.trim();
  return FORMULA_ERROR_RE.test(t) ? t : null;
}

export function errorTextFromCode(code: number, fallbackText?: string): string {
  if (fallbackText && detectFormulaErrorText(fallbackText)) return fallbackText.trim();
  return XLSX_ERROR_BY_CODE[code] ?? "#ERRO";
}

export function isEmptyCell(cell: RawCell | undefined): boolean {
  if (!cell) return true;
  if (cell.error) return false;
  return (
    cell.value === null ||
    cell.value === undefined ||
    (typeof cell.value === "string" && cell.value.trim() === "")
  );
}

/** String exibível de uma célula (preserva original, apara espaços). */
export function cellText(cell: RawCell | undefined): string | null {
  if (!cell || cell.error) return null;
  if (cell.value === null || cell.value === undefined) return null;
  if (cell.value instanceof Date) return isoDate(cell.value);
  const s = String(cell.value).trim();
  return s.length === 0 ? null : s;
}

/** Número a partir da célula. Aceita number direto ou string PT-BR. */
export function cellNumber(cell: RawCell | undefined): number | null {
  if (!cell || cell.error) return null;
  const v = cell.value;
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return null;
  return parseNumberBR(String(v));
}

/** Inteiro a partir da célula (trunca em direção a zero). */
export function cellInt(cell: RawCell | undefined): number | null {
  const n = cellNumber(cell);
  if (n === null) return null;
  return Math.trunc(n);
}

/**
 * Converte texto numérico em PT-BR para number.
 * Trata "1.234,56" → 1234.56 e "1234.56" → 1234.56.
 */
export function parseNumberBR(text: string): number | null {
  let s = text.trim();
  if (s === "") return null;
  s = s.replace(/[R$\s]/gi, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Assume "." milhar e "," decimal (padrão PT-BR).
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Data da célula em ISO (YYYY-MM-DD), ou null. */
export function cellDateISO(cell: RawCell | undefined): string | null {
  if (!cell || cell.error) return null;
  const v = cell.value;
  if (v instanceof Date) return isoDate(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return isoDate(d);
    return s; // mantém o texto original se não for data reconhecível
  }
  return null;
}

function isoDate(d: Date): string {
  // Usa componentes UTC para evitar deslocamento de fuso.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
