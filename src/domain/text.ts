/**
 * Normalizadores de texto.
 *
 * Toda comparação interna (cabeçalhos, status, chaves) é feita sobre a forma
 * normalizada — sem acentos, sem espaços duplicados e em caixa alta. O valor
 * original é sempre preservado para exibição no frontend.
 */

/** Remove acentos/diacríticos (NFD + remoção de marcas combinantes). */
export function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** Colapsa qualquer sequência de espaços/quebras de linha em um único espaço. */
export function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normaliza um cabeçalho de coluna para casamento robusto.
 * Ex.: "CHAVEPEÇA", "Chave Peca", "CHAVE_PECA" → "CHAVEPECA".
 */
export function normalizeHeader(value: unknown): string {
  if (value === null || value === undefined) return "";
  return collapseSpaces(stripAccents(String(value)))
    .toUpperCase()
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normaliza um status para um token canônico.
 * Ex.: "Concluído", "CONCLUIDO ", "concluido" → "CONCLUIDO".
 */
export function normalizeStatus(value: unknown): string {
  if (value === null || value === undefined) return "";
  return collapseSpaces(stripAccents(String(value))).toUpperCase();
}

/**
 * Normaliza uma CHAVEPEÇA / referência para casamento entre tabelas.
 * Preserva o conteúdo mas remove ruído de caixa, acento e espaços nas pontas.
 */
export function normalizeKey(value: unknown): string {
  if (value === null || value === undefined) return "";
  return collapseSpaces(stripAccents(String(value))).toUpperCase();
}

/** Texto exibível: apenas apara espaços nas pontas, preservando o original. */
export function cleanDisplay(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}
