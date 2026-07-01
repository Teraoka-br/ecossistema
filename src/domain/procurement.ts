import { normalizeStatus } from "./text.js";

/**
 * Normalização centralizada do status de uma cotação (PEÇAS A PEDIR).
 *
 * Os status reais observados nos arquivos legados são: "COTANDO", "APROVADO"
 * e vazio. Tratamos como APROVADA qualquer cotação cujo status normalizado
 * (sem acento, caixa alta, espaços colapsados) seja APROVADO ou APROVADA — a
 * variação de gênero/acentuação não deve mudar a decisão. Nenhuma outra
 * heurística é aplicada: somente uma aprovação explícita vira solicitação.
 */
export const APPROVED_QUOTATION_TOKENS: ReadonlySet<string> = new Set(["APROVADO", "APROVADA"]);

export function normalizeQuotationStatus(raw: unknown): string {
  return normalizeStatus(raw);
}

export function isApprovedQuotationStatus(raw: unknown): boolean {
  return APPROVED_QUOTATION_TOKENS.has(normalizeQuotationStatus(raw));
}
