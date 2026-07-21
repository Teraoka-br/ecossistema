/** Lógica compartilhada de montagem e validação de peças — usada em Analise e RepairDrawer. */

export interface PartDraft {
  key: string;
  pecaNome: string;
  incluirCor: boolean;
  /** Quando true, pecaNome já é o CHAVEPECA completo — não concatenar modelo */
  isChavePecaExistente?: boolean;
}

export interface PartPayload {
  pecaNome: string;
  incluirCor: boolean;
  corUsada: string;
  chavePeca: string;
}

export type ValidPartsResult =
  | { ok: true; parts: PartPayload[] }
  | { ok: false; error: string };

/** Constrói o CHAVEPECA concatenando nome, modelo e (opcionalmente) cor. */
export function buildChavePeca(
  pecaNome: string,
  modelo: string,
  incluirCor: boolean,
  corUsada: string,
): string {
  const parts = [pecaNome.trim(), modelo.trim()];
  if (incluirCor && corUsada.trim()) parts.push(corUsada.trim());
  return parts.filter(Boolean).join(" ").toUpperCase();
}

/** Valida e constrói o payload de peças para envio ao backend. */
export function buildValidPartsPayload(
  parts: PartDraft[],
  model: string,
  color: string,
): ValidPartsResult {
  const nonEmpty = parts.filter((p) => p.pecaNome.trim() !== "");
  if (nonEmpty.length === 0) {
    return { ok: false, error: "Adicione pelo menos uma peça necessária." };
  }
  const corTrim = color.trim();
  const result: PartPayload[] = [];
  for (const p of nonEmpty) {
    if (p.incluirCor && !corTrim) {
      return {
        ok: false,
        error: "A cor do aparelho é obrigatória quando 'Incluir cor' estiver marcado.",
      };
    }
    let chavePeca: string;
    if (p.isChavePecaExistente) {
      chavePeca = (p.incluirCor && corTrim)
        ? (p.pecaNome.trim() + " " + corTrim).toUpperCase()
        : p.pecaNome.trim().toUpperCase();
    } else {
      chavePeca = buildChavePeca(p.pecaNome, model, p.incluirCor, color);
    }
    if (!chavePeca) {
      return { ok: false, error: "Não foi possível gerar a CHAVEPECA da peça." };
    }
    result.push({
      pecaNome: p.pecaNome.trim(),
      incluirCor: p.incluirCor,
      corUsada: (p.incluirCor && corTrim) ? corTrim : "",
      chavePeca,
    });
  }
  return { ok: true, parts: result };
}

export interface PartSuggestion {
  text: string;
  type: "nome" | "chave";
}

export async function fetchPartSuggestions(q: string): Promise<PartSuggestion[]> {
  if (q.length < 2) return [];
  const r = await fetch(`/api/analise/part-suggestions?q=${encodeURIComponent(q)}`).catch(() => null);
  if (!r?.ok) return [];
  const d = await r.json() as { suggestions: PartSuggestion[] };
  return d.suggestions;
}
