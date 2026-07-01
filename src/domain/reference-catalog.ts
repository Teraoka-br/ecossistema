/**
 * Classificação de referência bipada contra o catálogo (estoque importado) e
 * os mapeamentos manuais — regra pura, sem acesso a banco.
 *
 * Ordem de resolução (a primeira que casar decide):
 *   1. mapeamento manual ATIVO para a referência → RECOGNIZED;
 *   2. referência ausente do catálogo importado → UNKNOWN_REFERENCE;
 *   3. referência existe, mas nenhuma linha tem CHAVEPECA → MISSING_KEY;
 *   4. referência existe com exatamente uma CHAVEPECA distinta → RECOGNIZED;
 *   5. referência existe com duas ou mais CHAVEPECA distintas → CONFLICT
 *      (nunca escolhida por MAX/MIN/primeira linha — fica pendente).
 */

export type ScanMappingStatus = "RECOGNIZED" | "UNKNOWN_REFERENCE" | "MISSING_KEY" | "CONFLICT";

export interface ChaveOption {
  chavePeca: string;
  chavePecaNorm: string;
}

export interface CatalogLookup {
  /** A referência (normalizada) existe em source_inventory_items do lote? */
  foundInCatalog: boolean;
  /** Chaves distintas e não vazias associadas à referência no catálogo. */
  distinctKeys: ChaveOption[];
}

export interface ManualMapping {
  chavePeca: string;
  chavePecaNorm: string;
}

export interface ReferenceResolution {
  mappingStatus: ScanMappingStatus;
  chavePeca: string | null;
  chavePecaNorm: string | null;
  /** Preenchido só quando mappingStatus === 'CONFLICT' (para exibir as opções). */
  conflictKeys: ChaveOption[];
}

const UNRESOLVED: Omit<ReferenceResolution, "mappingStatus"> = {
  chavePeca: null,
  chavePecaNorm: null,
  conflictKeys: [],
};

export function resolveReference(
  manualMapping: ManualMapping | null,
  catalog: CatalogLookup,
): ReferenceResolution {
  if (manualMapping) {
    return {
      mappingStatus: "RECOGNIZED",
      chavePeca: manualMapping.chavePeca,
      chavePecaNorm: manualMapping.chavePecaNorm,
      conflictKeys: [],
    };
  }

  if (!catalog.foundInCatalog) {
    return { mappingStatus: "UNKNOWN_REFERENCE", ...UNRESOLVED };
  }

  if (catalog.distinctKeys.length === 0) {
    return { mappingStatus: "MISSING_KEY", ...UNRESOLVED };
  }

  if (catalog.distinctKeys.length === 1) {
    const k = catalog.distinctKeys[0];
    return { mappingStatus: "RECOGNIZED", chavePeca: k.chavePeca, chavePecaNorm: k.chavePecaNorm, conflictKeys: [] };
  }

  return { mappingStatus: "CONFLICT", chavePeca: null, chavePecaNorm: null, conflictKeys: catalog.distinctKeys };
}
