/**
 * Motor de match — algoritmo puro.
 *
 * Sem acesso a banco. Dado o mesmo input, sempre produz o mesmo output.
 * MATCH É RECOMENDAÇÃO CALCULADA: não cria stock_movements nem operational_events.
 */

import { normalizeKey } from "../domain/text.js";
import { computeScore, comparePriority, type DecisionRuleConfig } from "../domain/scoring.js";
import { isPermanentStatus, orderStatusLabel } from "../domain/status.js";
import type { OperationalStockGroup } from "../operational/stock-service.js";

export const ALGORITHM_VERSION = "1";

// ---------------------------------------------------------------------------
// Tipos de input
// ---------------------------------------------------------------------------

export interface SourceOrderPartRow {
  id: number;
  id_pedido: string;
  imei: string | null;
  os: string | null;
  chave_peca: string | null;
  chave_peca_norm: string | null;
  referencia: string | null;
  status_atual_legado: string | null;
  status_atual_label: string | null;
  status_kit_legado: string | null;
  prioridade_kit_legado: number | null;
  quantidade_pecas_aparelho: number | null;
  idade: number | null;
  custo: number | null;
  venda: number | null;
  margem_legada: number | null;
  nota_idade_legada: number | null;
  nota_margem_legada: number | null;
  score_legado: number | null;
  ordem_consumo_legada: number | null;
  quantidade_estoque_legada: number | null;
}

export interface EngineInput {
  demandLines: SourceOrderPartRow[];
  /** idPedido → new_status do evento mais recente (pode estar vazio). */
  operationalEvents: Map<string, string>;
  stockGroups: OperationalStockGroup[];
  rule: DecisionRuleConfig;
}

// ---------------------------------------------------------------------------
// Tipos de output
// ---------------------------------------------------------------------------

export type AllocationPhase = "FULL" | "PARTIAL" | "PRESERVED" | "NONE";

export interface EngineLineResult {
  sourceOrderPartId: number;
  idPedido: string;
  imei: string | null;
  os: string | null;
  chavePeca: string | null;
  chavePecaNorm: string | null;
  effectiveStatusBefore: string;
  resultStatus: string;
  resultStatusLabel: string;
  kitStatus: string | null;
  kitPriority: number | null;
  allocationPhase: AllocationPhase;
  reservedUnits: number;
  ordemConsumo: number | null;
  allocatedReference: string | null;
  allocatedReferenceNorm: string | null;
  stockForKeyInitial: number;
  stockForKeyBefore: number;
  stockForKeyAfter: number;
  margin: number | null;
  notaIdade: number;
  notaMargem: number;
  score: number;
  devicePriorityRank: number | null;
  reasonCode: string | null;
  warningCodes: string[];
}

export interface EngineDeviceResult {
  deviceKey: string;
  imei: string | null;
  osValues: string[];
  osConflict: boolean;
  totalParts: number;
  openParts: number;
  permanentParts: number;
  score: number;
  margin: number | null;
  ageScore: number;
  marginScore: number;
  priorityRank: number | null;
  stableId: string | null;
  kitStatus: string | null;
  kitPriority: number | null;
  allocationPhase: AllocationPhase;
  warningCodes: string[];
  lines: EngineLineResult[];
}

export interface EngineStockPoolSummary {
  chavePecaNorm: string;
  chavePeca: string | null;
  initialTotal: number;
  allocatedFull: number;
  allocatedPartial: number;
  remaining: number;
  refs: Array<{
    referenciaNorm: string;
    referencia: string;
    initialAvailable: number;
    allocatedFull: number;
    allocatedPartial: number;
    remaining: number;
  }>;
}

export interface EngineStats {
  devicesTotal: number;
  devicesConsidered: number;
  devicesFullMatch: number;
  devicesPartial: number;
  devicesIncomplete: number;
  devicesVerify: number;
  devicesPreserved: number;
  linesTotal: number;
  linesMatch: number;
  linesPartial: number;
  linesRequestPiece: number;
  linesNoBalance: number;
  linesVerify: number;
  linesPreserved: number;
  allocatedUnits: number;
  remainingUsableUnits: number;
  warningsCount: number;
  stockTotalUnits: number;
  stockUsableUnits: number;
  stockUnmappedUnits: number;
}

export interface EngineOutput {
  devices: EngineDeviceResult[];
  stockPools: Map<string, EngineStockPoolSummary>;
  stats: EngineStats;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Tipos internos (mutáveis durante o cálculo)
// ---------------------------------------------------------------------------

interface RefPool {
  referenciaNorm: string;
  referencia: string;
  available: number;
  initialAvailable: number;
  allocatedFull: number;
  allocatedPartial: number;
}

interface KeyPool {
  chavePecaNorm: string;
  chavePeca: string | null;
  refs: RefPool[];
  initialTotal: number;
  currentAvailable: number;
  allocatedFull: number;
  allocatedPartial: number;
}

interface ProcessedLine extends SourceOrderPartRow {
  effectiveStatus: string;
  isPermanent: boolean;
  computedMargin: number | null;
  computedNotaIdade: number;
  computedNotaMargem: number;
  computedScore: number;
  scoreWarnings: string[];
  imeiNorm: string | null;
}

interface AnalyzedDevice {
  deviceKey: string;
  imei: string | null;
  osValues: string[];
  osConflict: boolean;
  allLines: ProcessedLine[];
  openLines: ProcessedLine[];
  permanentLines: ProcessedLine[];
  score: number;
  margin: number | null;
  ageScore: number;
  marginScore: number;
  stableId: string;
  openParts: number;
  warningCodes: string[];
  priorityRank: number | null;
}

interface WorkingResult {
  phase: AllocationPhase | null;
  resultStatus: string | null;
  resultStatusLabel: string | null;
  allocatedReferenceNorm: string | null;
  allocatedReference: string | null;
  stockForKeyBefore: number;
  stockForKeyAfter: number;
  reasonCode: string | null;
  warningCodes: string[];
  reservedUnits?: number;
}

// ---------------------------------------------------------------------------
// Função principal
// ---------------------------------------------------------------------------

export function runMatchEngine(input: EngineInput): EngineOutput {
  const { demandLines, operationalEvents, stockGroups, rule } = input;

  // ── Passo 1: construir pools de estoque ──────────────────────────────────
  const pools = new Map<string, KeyPool>();
  let stockTotalUnits = 0;
  let stockUsableUnits = 0;
  let stockUnmappedUnits = 0;

  for (const g of stockGroups) {
    stockTotalUnits += g.currentQuantity;
    // O motor usa availableQuantity (físico − reservado); se não disponível, usa currentQuantity.
    const available = (g as { availableQuantity?: number }).availableQuantity ?? g.currentQuantity;
    if (!g.mapeada || !g.chavePecaNorm || !g.referenciaNorm || available <= 0) {
      stockUnmappedUnits += g.currentQuantity;
      continue;
    }
    stockUsableUnits += available;
    const k = g.chavePecaNorm;
    let pool = pools.get(k);
    if (!pool) {
      pool = {
        chavePecaNorm: k,
        chavePeca: g.chavePeca,
        refs: [],
        initialTotal: 0,
        currentAvailable: 0,
        allocatedFull: 0,
        allocatedPartial: 0,
      };
      pools.set(k, pool);
    }
    pool.refs.push({
      referenciaNorm: g.referenciaNorm,
      referencia: g.referencia,
      available,
      initialAvailable: available,
      allocatedFull: 0,
      allocatedPartial: 0,
    });
    pool.initialTotal += available;
    pool.currentAvailable += available;
  }

  // Ordenar referências por referenciaNorm ASC dentro de cada pool.
  for (const pool of pools.values()) {
    pool.refs.sort((a, b) => a.referenciaNorm.localeCompare(b.referenciaNorm));
  }

  // ── Passo 2: processar linhas de demanda ─────────────────────────────────
  const processedLines: ProcessedLine[] = demandLines.map((line) => {
    const eventStatus = operationalEvents.get(line.id_pedido);
    const effectiveStatus = eventStatus ?? line.status_atual_legado ?? "";
    // EM SEPARACAO é tratado como "permanente para fins do motor" — não compete por estoque.
    const isEmSeparacao = effectiveStatus === "EM SEPARACAO";
    const scoreOut = computeScore({ idade: line.idade, custo: line.custo, venda: line.venda }, rule);
    return {
      ...line,
      effectiveStatus,
      isPermanent: isPermanentStatus(effectiveStatus) || isEmSeparacao,
      computedMargin: scoreOut.margem,
      computedNotaIdade: scoreOut.notaIdade,
      computedNotaMargem: scoreOut.notaMargem,
      computedScore: scoreOut.score,
      scoreWarnings: scoreOut.warnings,
      imeiNorm: line.imei ? normalizeKey(line.imei) : null,
    };
  });

  // ── Passo 3: agrupar por aparelho (IMEI) ─────────────────────────────────
  const deviceMap = new Map<string, AnalyzedDevice>();

  for (const line of processedLines) {
    const deviceKey = line.imeiNorm || "__NO_IMEI__";
    let device = deviceMap.get(deviceKey);
    if (!device) {
      device = {
        deviceKey,
        imei: line.imei,
        osValues: [],
        osConflict: false,
        allLines: [],
        openLines: [],
        permanentLines: [],
        score: 0,
        margin: null,
        ageScore: 0,
        marginScore: 0,
        stableId: "",
        openParts: 0,
        warningCodes: [],
        priorityRank: null,
      };
      deviceMap.set(deviceKey, device);
    }
    device.allLines.push(line);
    if (line.isPermanent) {
      device.permanentLines.push(line);
    } else {
      device.openLines.push(line);
      device.openParts++;
    }
  }

  // ── Passo 4: analisar cada aparelho (OS, score, warnings) ────────────────
  for (const device of deviceMap.values()) {
    // OS
    const osSet = new Set<string>();
    for (const l of device.allLines) {
      if (l.os && l.os.trim()) osSet.add(l.os.trim());
    }
    device.osValues = [...osSet].sort();
    device.osConflict = device.osValues.length > 1;

    if (device.osConflict && device.deviceKey !== "__NO_IMEI__") {
      device.warningCodes.push("DEVICE_OS_CONFLICT");
    }

    // Quantidade declarada vs real
    if (device.deviceKey !== "__NO_IMEI__" && device.openLines.length > 0) {
      const declared = device.allLines[0]?.quantidade_pecas_aparelho ?? null;
      if (declared !== null && declared !== device.allLines.length) {
        device.warningCodes.push("DEVICE_PART_COUNT_MISMATCH");
      }
    }

    // Score e prioridade das linhas abertas
    if (device.openLines.length > 0) {
      // Verificar conflito de dados de prioridade
      const ages = new Set(device.openLines.map((l) => l.idade).filter((x) => x != null));
      const costos = new Set(device.openLines.map((l) => l.custo).filter((x) => x != null));
      const vendas = new Set(device.openLines.map((l) => l.venda).filter((x) => x != null));
      if (ages.size > 1 || costos.size > 1 || vendas.size > 1) {
        device.warningCodes.push("DEVICE_PRIORITY_DATA_CONFLICT");
      }

      // Linha representativa: maior score → maior margem → menor id_pedido (determinístico)
      // Importante: NÃO inicializar com 0 — scores negativos seriam descartados.
      const repLine = device.openLines.reduce((best, curr) => {
        if (curr.computedScore > best.computedScore) return curr;
        if (curr.computedScore < best.computedScore) return best;
        const bm = best.computedMargin ?? Number.NEGATIVE_INFINITY;
        const cm = curr.computedMargin ?? Number.NEGATIVE_INFINITY;
        if (cm > bm) return curr;
        if (cm < bm) return best;
        return curr.id_pedido < best.id_pedido ? curr : best;
      });
      device.score = repLine.computedScore;
      device.ageScore = repLine.computedNotaIdade;
      device.marginScore = repLine.computedNotaMargem;

      // Maior margem não nula (para desempate entre aparelhos, separado da linha representativa)
      for (const l of device.openLines) {
        if (l.computedMargin !== null) {
          if (device.margin === null || l.computedMargin > device.margin) {
            device.margin = l.computedMargin;
          }
        }
      }
      const sortedIds = device.openLines.map((l) => l.id_pedido).sort();
      device.stableId = sortedIds[0] ?? "";
    } else {
      // Aparelho só com permanentes
      const sortedIds = device.allLines.map((l) => l.id_pedido).sort();
      device.stableId = sortedIds[0] ?? "";
    }
  }

  // ── Passo 5: ordenar por prioridade e atribuir rank ──────────────────────
  const eligibleDevices = [...deviceMap.values()].filter(
    (d) => d.deviceKey !== "__NO_IMEI__" && d.openParts > 0,
  );
  const noImeiDevice = deviceMap.get("__NO_IMEI__");
  const preservedDevices = [...deviceMap.values()].filter(
    (d) => d.deviceKey !== "__NO_IMEI__" && d.openParts === 0,
  );

  eligibleDevices.sort((a, b) =>
    comparePriority(
      { totalParts: a.openParts, score: a.score, margem: a.margin, stableId: a.stableId },
      { totalParts: b.openParts, score: b.score, margem: b.margin, stableId: b.stableId },
    ),
  );
  eligibleDevices.forEach((d, i) => {
    d.priorityRank = i + 1;
  });

  // ── Passo 6: inicializar resultados de linha ─────────────────────────────
  const lineResults = new Map<number, WorkingResult>();

  for (const d of deviceMap.values()) {
    for (const l of d.allLines) {
      lineResults.set(l.id, {
        phase: null,
        resultStatus: null,
        resultStatusLabel: null,
        allocatedReferenceNorm: null,
        allocatedReference: null,
        stockForKeyBefore: 0,
        stockForKeyAfter: 0,
        reasonCode: null,
        warningCodes: [...l.scoreWarnings],
      });
    }
    // Marcar permanentes imediatamente
    for (const l of d.permanentLines) {
      const r = lineResults.get(l.id)!;
      r.phase = "PRESERVED";
      if (l.effectiveStatus === "EM SEPARACAO") {
        r.resultStatus = "EM SEPARACAO";
        r.resultStatusLabel = "EM SEPARAÇÃO";
        r.reasonCode = "ACTIVE_SEPARATION";
      } else {
        r.resultStatus = l.effectiveStatus;
        r.resultStatusLabel = orderStatusLabel(l.effectiveStatus) ?? l.effectiveStatus;
      }
      r.reservedUnits = 0;
    }
  }

  // ── Passo 7: primeira passagem — kits completos (atômico) ────────────────
  const fullMatchDeviceKeys = new Set<string>();

  for (const device of eligibleDevices) {
    const openLines = device.openLines;

    // Verificar se todas as linhas abertas têm CHAVEPECA válida
    if (!openLines.every((l) => !!l.chave_peca_norm)) continue;

    // Calcular necessidades: chavePecaNorm → quantidade
    const needs = new Map<string, number>();
    for (const l of openLines) {
      const k = l.chave_peca_norm!;
      needs.set(k, (needs.get(k) ?? 0) + 1);
    }

    // Verificar viabilidade (sem modificar os pools)
    let canFulfill = true;
    for (const [k, count] of needs) {
      const pool = pools.get(k);
      if (!pool || pool.currentAvailable < count) {
        canFulfill = false;
        break;
      }
    }
    if (!canFulfill) continue;

    // Alocar — linhas em ordem de ID_PEDIDO
    const sortedLines = [...openLines].sort((a, b) => a.id_pedido.localeCompare(b.id_pedido));
    fullMatchDeviceKeys.add(device.deviceKey);

    for (const l of sortedLines) {
      const pool = pools.get(l.chave_peca_norm!)!;
      const stockBefore = pool.currentAvailable;

      let allocatedRefNorm: string | null = null;
      let allocatedRef: string | null = null;
      for (const ref of pool.refs) {
        if (ref.available > 0) {
          ref.available--;
          ref.allocatedFull++;
          allocatedRefNorm = ref.referenciaNorm;
          allocatedRef = ref.referencia;
          break;
        }
      }
      if (!allocatedRefNorm) {
        throw new Error(`BUG: pool esgotou durante kit completo para ${l.chave_peca_norm}`);
      }
      pool.currentAvailable--;
      pool.allocatedFull++;

      const r = lineResults.get(l.id)!;
      r.phase = "FULL";
      r.resultStatus = "MATCH";
      r.resultStatusLabel = "MATCH";
      r.allocatedReferenceNorm = allocatedRefNorm;
      r.allocatedReference = allocatedRef;
      r.stockForKeyBefore = stockBefore;
      r.stockForKeyAfter = pool.currentAvailable;
    }
  }

  // ── Passo 8: segunda passagem — saldo restante ───────────────────────────
  const secondPassDevices = [
    ...eligibleDevices.filter((d) => !fullMatchDeviceKeys.has(d.deviceKey)),
    ...(noImeiDevice ? [noImeiDevice] : []),
  ];

  for (const device of secondPassDevices) {
    const sortedOpenLines = [...device.openLines].sort((a, b) =>
      a.id_pedido.localeCompare(b.id_pedido),
    );

    for (const l of sortedOpenLines) {
      const r = lineResults.get(l.id)!;
      if (r.phase !== null) continue;

      // Linha sem IMEI
      if (device.deviceKey === "__NO_IMEI__") {
        r.phase = "NONE";
        r.resultStatus = "VERIFICAR";
        r.resultStatusLabel = "VERIFICAR";
        r.reasonCode = "MISSING_IMEI";
        continue;
      }

      // Linha sem CHAVEPECA
      if (!l.chave_peca_norm) {
        r.phase = "NONE";
        r.resultStatus = "VERIFICAR";
        r.resultStatusLabel = "VERIFICAR";
        r.reasonCode = "MISSING_KEY";
        continue;
      }

      const pool = pools.get(l.chave_peca_norm);
      const stockBefore = pool?.currentAvailable ?? 0;

      if (pool && pool.currentAvailable > 0) {
        let allocatedRefNorm: string | null = null;
        let allocatedRef: string | null = null;
        for (const ref of pool.refs) {
          if (ref.available > 0) {
            ref.available--;
            ref.allocatedPartial++;
            allocatedRefNorm = ref.referenciaNorm;
            allocatedRef = ref.referencia;
            break;
          }
        }
        if (!allocatedRefNorm) throw new Error(`BUG: pool inconsistente para ${l.chave_peca_norm}`);
        pool.currentAvailable--;
        pool.allocatedPartial++;

        r.phase = "PARTIAL";
        r.resultStatus = "MATCH PARCIAL";
        r.resultStatusLabel = "MATCH PARCIAL";
        r.allocatedReferenceNorm = allocatedRefNorm;
        r.allocatedReference = allocatedRef;
        r.stockForKeyBefore = stockBefore;
        r.stockForKeyAfter = pool.currentAvailable;
      } else if (!pool || pool.initialTotal === 0) {
        r.phase = "NONE";
        r.resultStatus = "PEDIR PECA";
        r.resultStatusLabel = "PEDIR PEÇA";
        r.stockForKeyBefore = 0;
        r.stockForKeyAfter = 0;
      } else {
        // Pool existe com estoque inicial > 0 mas esgotado por prioritários
        r.phase = "NONE";
        r.resultStatus = "SEM SALDO";
        r.resultStatusLabel = "SEM SALDO";
        r.stockForKeyBefore = stockBefore;
        r.stockForKeyAfter = stockBefore;
      }
    }
  }

  // Garantia: qualquer linha aberta ainda não resolvida vira VERIFICAR
  for (const d of deviceMap.values()) {
    for (const l of d.openLines) {
      const r = lineResults.get(l.id)!;
      if (r.phase === null) {
        r.phase = "NONE";
        r.resultStatus = "VERIFICAR";
        r.resultStatusLabel = "VERIFICAR";
        r.reasonCode = "UNRESOLVED";
      }
    }
  }

  // ── Passo 9: ordem de consumo por CHAVEPECA ──────────────────────────────
  interface AllocationEntry {
    idPedido: string;
    chavePecaNorm: string;
    priorityRank: number;
    phase: "FULL" | "PARTIAL";
  }

  const fullAllocations: AllocationEntry[] = [];
  const partialAllocations: AllocationEntry[] = [];

  for (const device of eligibleDevices) {
    const rank = device.priorityRank ?? 999;
    const sorted = [...device.openLines].sort((a, b) => a.id_pedido.localeCompare(b.id_pedido));
    for (const l of sorted) {
      const r = lineResults.get(l.id)!;
      if (!l.chave_peca_norm) continue;
      if (r.phase === "FULL") {
        fullAllocations.push({ idPedido: l.id_pedido, chavePecaNorm: l.chave_peca_norm, priorityRank: rank, phase: "FULL" });
      } else if (r.phase === "PARTIAL") {
        partialAllocations.push({ idPedido: l.id_pedido, chavePecaNorm: l.chave_peca_norm, priorityRank: rank, phase: "PARTIAL" });
      }
    }
  }

  const sortByRankAndId = (a: AllocationEntry, b: AllocationEntry) =>
    a.priorityRank !== b.priorityRank
      ? a.priorityRank - b.priorityRank
      : a.idPedido.localeCompare(b.idPedido);

  fullAllocations.sort(sortByRankAndId);
  partialAllocations.sort(sortByRankAndId);

  const consumoCounters = new Map<string, number>();
  const ordemConsumoMap = new Map<string, number>(); // idPedido → ordem_consumo

  for (const alloc of [...fullAllocations, ...partialAllocations]) {
    const next = (consumoCounters.get(alloc.chavePecaNorm) ?? 0) + 1;
    consumoCounters.set(alloc.chavePecaNorm, next);
    ordemConsumoMap.set(alloc.idPedido, next);
  }

  // ── Passo 10: construir resultados finais por aparelho ───────────────────
  function buildDeviceResult(device: AnalyzedDevice): EngineDeviceResult {
    const lineOutputs: EngineLineResult[] = device.allLines.map((l) => {
      const wr = lineResults.get(l.id)!;
      const pool = l.chave_peca_norm ? pools.get(l.chave_peca_norm) : undefined;

      return {
        sourceOrderPartId: l.id,
        idPedido: l.id_pedido,
        imei: l.imei,
        os: l.os,
        chavePeca: l.chave_peca,
        chavePecaNorm: l.chave_peca_norm,
        effectiveStatusBefore: l.effectiveStatus,
        resultStatus: wr.resultStatus ?? l.effectiveStatus,
        resultStatusLabel: wr.resultStatusLabel ?? (orderStatusLabel(l.effectiveStatus) ?? l.effectiveStatus),
        kitStatus: null, // preenchido abaixo
        kitPriority: null,
        allocationPhase: wr.phase ?? "NONE",
        reservedUnits: wr.phase === "FULL" || wr.phase === "PARTIAL" ? 1 : 0,
        ordemConsumo: ordemConsumoMap.get(l.id_pedido) ?? null,
        allocatedReference: wr.allocatedReference,
        allocatedReferenceNorm: wr.allocatedReferenceNorm,
        stockForKeyInitial: pool?.initialTotal ?? 0,
        stockForKeyBefore: wr.stockForKeyBefore,
        stockForKeyAfter: wr.stockForKeyAfter,
        margin: l.computedMargin,
        notaIdade: l.computedNotaIdade,
        notaMargem: l.computedNotaMargem,
        score: l.computedScore,
        devicePriorityRank: device.priorityRank,
        reasonCode: wr.reasonCode,
        warningCodes: [...wr.warningCodes],
      };
    });

    // Calcular kit status com base nas linhas abertas
    let kitStatus: string | null = null;
    let kitPriority: number | null = null;
    let allocationPhase: AllocationPhase = "NONE";

    if (device.openParts === 0) {
      allocationPhase = "PRESERVED";
    } else {
      const openOutputs = lineOutputs.filter((lo) =>
        device.openLines.some((ol) => ol.id === lo.sourceOrderPartId),
      );
      const hasVerify = openOutputs.some((l) => l.resultStatus === "VERIFICAR");
      const allMatch = openOutputs.every((l) => l.resultStatus === "MATCH");
      const hasMatchOrPartial = openOutputs.some(
        (l) => l.resultStatus === "MATCH" || l.resultStatus === "MATCH PARCIAL",
      );

      if (hasVerify) {
        kitStatus = "VERIFICAR";
        kitPriority = 9;
        allocationPhase = "NONE";
      } else if (allMatch) {
        kitStatus = "KIT POSSIVEL";
        kitPriority = 1;
        allocationPhase = "FULL";
      } else if (hasMatchOrPartial) {
        kitStatus = "MATCH PARCIAL";
        kitPriority = 2;
        allocationPhase = "PARTIAL";
      } else {
        kitStatus = "KIT INCOMPLETO";
        kitPriority = 9;
        allocationPhase = "NONE";
      }
    }

    // Propagar kit status para as linhas
    for (const lo of lineOutputs) {
      lo.kitStatus = kitStatus;
      lo.kitPriority = kitPriority;
      // Linhas permanentes mantêm PRESERVED; abertas recebem allocationPhase do kit
      if (device.permanentLines.some((pl) => pl.id === lo.sourceOrderPartId)) {
        lo.allocationPhase = "PRESERVED";
      } else if (lo.allocationPhase === null || lo.allocationPhase === "NONE") {
        // manter o já calculado
      }
    }

    return {
      deviceKey: device.deviceKey,
      imei: device.imei,
      osValues: device.osValues,
      osConflict: device.osConflict,
      totalParts: device.allLines.length,
      openParts: device.openParts,
      permanentParts: device.permanentLines.length,
      score: device.score,
      margin: device.margin,
      ageScore: device.ageScore,
      marginScore: device.marginScore,
      priorityRank: device.priorityRank,
      stableId: device.stableId || null,
      kitStatus,
      kitPriority,
      allocationPhase,
      warningCodes: [...device.warningCodes],
      lines: lineOutputs,
    };
  }

  const finalDevices: EngineDeviceResult[] = [
    ...eligibleDevices.map(buildDeviceResult),
    ...preservedDevices.map(buildDeviceResult),
    ...(noImeiDevice ? [buildDeviceResult(noImeiDevice)] : []),
  ];

  // ── Passo 11: resumo de pools de estoque ─────────────────────────────────
  const stockPools = new Map<string, EngineStockPoolSummary>();
  for (const [k, pool] of pools) {
    stockPools.set(k, {
      chavePecaNorm: k,
      chavePeca: pool.chavePeca,
      initialTotal: pool.initialTotal,
      allocatedFull: pool.allocatedFull,
      allocatedPartial: pool.allocatedPartial,
      remaining: pool.currentAvailable,
      refs: pool.refs.map((r) => ({
        referenciaNorm: r.referenciaNorm,
        referencia: r.referencia,
        initialAvailable: r.initialAvailable,
        allocatedFull: r.allocatedFull,
        allocatedPartial: r.allocatedPartial,
        remaining: r.available,
      })),
    });
  }

  // ── Passo 12: estatísticas ────────────────────────────────────────────────
  const allLineResults = finalDevices.flatMap((d) => d.lines);

  const stats: EngineStats = {
    devicesTotal: finalDevices.length,
    devicesConsidered: finalDevices.filter((d) => d.openParts > 0).length,
    devicesFullMatch: finalDevices.filter((d) => d.kitStatus === "KIT POSSIVEL").length,
    devicesPartial: finalDevices.filter((d) => d.kitStatus === "MATCH PARCIAL").length,
    devicesIncomplete: finalDevices.filter((d) => d.kitStatus === "KIT INCOMPLETO").length,
    devicesVerify: finalDevices.filter((d) => d.kitStatus === "VERIFICAR").length,
    devicesPreserved: finalDevices.filter((d) => d.allocationPhase === "PRESERVED").length,
    linesTotal: allLineResults.length,
    linesMatch: allLineResults.filter((l) => l.resultStatus === "MATCH").length,
    linesPartial: allLineResults.filter((l) => l.resultStatus === "MATCH PARCIAL").length,
    linesRequestPiece: allLineResults.filter((l) => l.resultStatus === "PEDIR PECA").length,
    linesNoBalance: allLineResults.filter((l) => l.resultStatus === "SEM SALDO").length,
    linesVerify: allLineResults.filter((l) => l.resultStatus === "VERIFICAR").length,
    linesPreserved: allLineResults.filter((l) => l.allocationPhase === "PRESERVED").length,
    allocatedUnits: allLineResults.reduce((s, l) => s + l.reservedUnits, 0),
    remainingUsableUnits: [...pools.values()].reduce((s, p) => s + p.currentAvailable, 0),
    warningsCount:
      allLineResults.reduce((s, l) => s + l.warningCodes.length, 0) +
      finalDevices.reduce((s, d) => s + d.warningCodes.length, 0),
    stockTotalUnits,
    stockUsableUnits,
    stockUnmappedUnits,
  };

  return { devices: finalDevices, stockPools, stats, warnings: [] };
}
