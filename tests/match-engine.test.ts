/**
 * Testes unitários do motor de match (algoritmo puro — sem banco de dados).
 */

import { describe, expect, it } from "vitest";
import { runMatchEngine, type EngineInput, type SourceOrderPartRow } from "../src/match/match-engine.js";
import type { OperationalStockGroup } from "../src/operational/stock-service.js";
import type { DecisionRuleConfig } from "../src/domain/scoring.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_RULE: DecisionRuleConfig = {
  ageDaysPerPoint: 10,
  ageMaxPoints: 10,
  marginPerPoint: 50,
  marginAllowsNegative: false,
};

let nextId = 1;

function line(o: Partial<SourceOrderPartRow> & { id_pedido: string }): SourceOrderPartRow {
  return {
    id: nextId++,
    id_pedido: o.id_pedido,
    imei: o.imei ?? "IMEI001",
    os: o.os ?? "OS1",
    chave_peca: o.chave_peca ?? "BAT",
    chave_peca_norm: o.chave_peca_norm ?? "bat",
    referencia: o.referencia ?? null,
    status_atual_legado: o.status_atual_legado ?? "SOLICITADO",
    status_atual_label: o.status_atual_label ?? null,
    status_kit_legado: o.status_kit_legado ?? null,
    prioridade_kit_legado: o.prioridade_kit_legado ?? null,
    quantidade_pecas_aparelho: o.quantidade_pecas_aparelho ?? 1,
    idade: o.idade ?? 30,
    custo: o.custo ?? 100,
    venda: o.venda ?? 200,
    margem_legada: o.margem_legada ?? null,
    nota_idade_legada: o.nota_idade_legada ?? null,
    nota_margem_legada: o.nota_margem_legada ?? null,
    score_legado: o.score_legado ?? null,
    ordem_consumo_legada: o.ordem_consumo_legada ?? null,
    quantidade_estoque_legada: o.quantidade_estoque_legada ?? null,
  };
}

function stockGroup(o: {
  referencia?: string;
  referenciaNorm?: string;
  chavePeca?: string;
  chavePecaNorm?: string;
  qty?: number;
}): OperationalStockGroup {
  return {
    referencia: o.referencia ?? "PC-1",
    referenciaNorm: o.referenciaNorm ?? "pc-1",
    chavePeca: o.chavePeca ?? "BAT",
    chavePecaNorm: o.chavePecaNorm ?? "bat",
    baseQuantity: o.qty ?? 1,
    movementQuantity: 0,
    currentQuantity: o.qty ?? 1,
    mapeada: true,
  };
}

function input(o: {
  lines: SourceOrderPartRow[];
  stock?: OperationalStockGroup[];
  events?: Map<string, string>;
  rule?: DecisionRuleConfig;
}): EngineInput {
  return {
    demandLines: o.lines,
    operationalEvents: o.events ?? new Map(),
    stockGroups: o.stock ?? [],
    rule: o.rule ?? DEFAULT_RULE,
  };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe("motor de match — score e prioridade", () => {
  it("aparelho com menos peças tem prioridade maior", () => {
    nextId = 1000;
    const l1 = line({ id_pedido: "A1", imei: "IMEI001", quantidade_pecas_aparelho: 1 });
    const l2a = line({ id_pedido: "B1", imei: "IMEI002", quantidade_pecas_aparelho: 2 });
    const l2b = line({ id_pedido: "B2", imei: "IMEI002", quantidade_pecas_aparelho: 2 });
    const stock = [
      stockGroup({ referencia: "PC-1", referenciaNorm: "pc-1", chavePecaNorm: "bat", qty: 3 }),
    ];
    const out = runMatchEngine(input({ lines: [l1, l2a, l2b], stock }));
    const dev1 = out.devices.find((d) => d.imei === "IMEI001")!;
    const dev2 = out.devices.find((d) => d.imei === "IMEI002")!;
    expect(dev1.priorityRank).toBeLessThan(dev2.priorityRank!);
  });

  it("mesmo número de peças — maior score tem prioridade", () => {
    nextId = 2000;
    const young = line({ id_pedido: "Y1", imei: "IMEI_YOUNG", idade: 5, custo: 100, venda: 200 });
    const old = line({ id_pedido: "O1", imei: "IMEI_OLD", idade: 100, custo: 100, venda: 200 });
    const stock = [stockGroup({ qty: 2 })];
    const out = runMatchEngine(input({ lines: [young, old], stock }));
    const devYoung = out.devices.find((d) => d.imei === "IMEI_YOUNG")!;
    const devOld = out.devices.find((d) => d.imei === "IMEI_OLD")!;
    // Mais velho → maior nota de idade → maior score → prioridade melhor
    expect(devOld.score).toBeGreaterThan(devYoung.score);
    expect(devOld.priorityRank).toBeLessThan(devYoung.priorityRank!);
  });

  it("stableId é o menor id_pedido lexicográfico do aparelho", () => {
    nextId = 3000;
    const la = line({ id_pedido: "Z99", imei: "IMEI_MULTI" });
    const lb = line({ id_pedido: "A01", imei: "IMEI_MULTI" });
    const out = runMatchEngine(input({ lines: [la, lb], stock: [] }));
    const dev = out.devices.find((d) => d.imei === "IMEI_MULTI")!;
    expect(dev.stableId).toBe("A01");
  });
});

describe("motor de match — kit completo (FULL)", () => {
  it("kit completo quando estoque suficiente para todas as peças", () => {
    nextId = 4000;
    const l1 = line({ id_pedido: "K1", imei: "IMEIK", chave_peca_norm: "bat", quantidade_pecas_aparelho: 2 });
    const l2 = line({ id_pedido: "K2", imei: "IMEIK", chave_peca: "TELA", chave_peca_norm: "tela", quantidade_pecas_aparelho: 2 });
    const stock = [
      stockGroup({ chavePeca: "BAT", chavePecaNorm: "bat", qty: 1 }),
      stockGroup({ referencia: "PC-2", referenciaNorm: "pc-2", chavePeca: "TELA", chavePecaNorm: "tela", qty: 1 }),
    ];
    const out = runMatchEngine(input({ lines: [l1, l2], stock }));
    const dev = out.devices.find((d) => d.imei === "IMEIK")!;
    expect(dev.kitStatus).toBe("KIT POSSIVEL");
    expect(dev.lines.every((l) => l.resultStatus === "MATCH")).toBe(true);
    expect(dev.lines.every((l) => l.allocationPhase === "FULL")).toBe(true);
  });

  it("kit completo consome estoque corretamente (allocatedFull++)", () => {
    nextId = 4100;
    const l1 = line({ id_pedido: "KF1", imei: "IMEI_FULL" });
    const stock = [stockGroup({ qty: 3 })];
    const out = runMatchEngine(input({ lines: [l1], stock }));
    const pool = out.stockPools.get("bat")!;
    expect(pool.allocatedFull).toBe(1);
    expect(pool.remaining).toBe(2);
  });

  it("kit incompleto quando estoque insuficiente para kit atomico", () => {
    nextId = 4200;
    const l1 = line({ id_pedido: "I1", imei: "IMEI_INC", quantidade_pecas_aparelho: 2 });
    const l2 = line({ id_pedido: "I2", imei: "IMEI_INC", chave_peca: "TELA", chave_peca_norm: "tela", quantidade_pecas_aparelho: 2 });
    // Estoque só tem BAT, sem TELA
    const stock = [stockGroup({ chavePecaNorm: "bat", qty: 1 })];
    const out = runMatchEngine(input({ lines: [l1, l2], stock }));
    const dev = out.devices.find((d) => d.imei === "IMEI_INC")!;
    // BAT vai para parcial, TELA vai para PEDIR PECA
    expect(dev.kitStatus).toBe("MATCH PARCIAL");
  });

  it("primeira passagem é atômica — não aloca parcialmente", () => {
    nextId = 4300;
    // Dois aparelhos. Estoque tem apenas 1 BAT e 1 TELA.
    // IMEI_A precisa de BAT+TELA (kit), IMEI_B precisa de BAT+TELA (kit).
    // Somente o de maior prioridade deve ganhar o kit completo.
    const la1 = line({ id_pedido: "A1", imei: "IMEI_A", chave_peca_norm: "bat", quantidade_pecas_aparelho: 2, idade: 100 });
    const la2 = line({ id_pedido: "A2", imei: "IMEI_A", chave_peca: "TELA", chave_peca_norm: "tela", quantidade_pecas_aparelho: 2, idade: 100 });
    const lb1 = line({ id_pedido: "B1", imei: "IMEI_B", chave_peca_norm: "bat", quantidade_pecas_aparelho: 2, idade: 5 });
    const lb2 = line({ id_pedido: "B2", imei: "IMEI_B", chave_peca: "TELA", chave_peca_norm: "tela", quantidade_pecas_aparelho: 2, idade: 5 });
    const stock = [
      stockGroup({ chavePecaNorm: "bat", qty: 1 }),
      stockGroup({ referencia: "PC-2", referenciaNorm: "pc-2", chavePeca: "TELA", chavePecaNorm: "tela", qty: 1 }),
    ];
    const out = runMatchEngine(input({ lines: [la1, la2, lb1, lb2], stock }));
    const devA = out.devices.find((d) => d.imei === "IMEI_A")!;
    const devB = out.devices.find((d) => d.imei === "IMEI_B")!;
    // IMEI_A tem score mais alto (mais velho) → rank 1 → kit completo
    expect(devA.kitStatus).toBe("KIT POSSIVEL");
    // IMEI_B fica sem saldo
    expect(devB.kitStatus).toBe("KIT INCOMPLETO");
  });
});

describe("motor de match — passagem parcial", () => {
  it("MATCH PARCIAL quando estoque disponível mas kit não atômico", () => {
    nextId = 5000;
    const l1 = line({ id_pedido: "P1", imei: "IMEI_PART", quantidade_pecas_aparelho: 2 });
    const l2 = line({ id_pedido: "P2", imei: "IMEI_PART", chave_peca: "TELA", chave_peca_norm: "tela", quantidade_pecas_aparelho: 2 });
    // Estoque tem BAT mas não TELA → kit não é completo, vai para partial
    const stock = [stockGroup({ chavePecaNorm: "bat", qty: 1 })];
    const out = runMatchEngine(input({ lines: [l1, l2], stock }));
    const bat = out.devices.find((d) => d.imei === "IMEI_PART")!.lines.find((l) => l.chavePecaNorm === "bat")!;
    expect(bat.resultStatus).toBe("MATCH PARCIAL");
    expect(bat.allocationPhase).toBe("PARTIAL");
  });

  it("SEM SALDO quando estoque já foi consumido por prioritários", () => {
    nextId = 5100;
    const priority = line({ id_pedido: "PRI1", imei: "IMEI_PRIO", idade: 200 });
    const low = line({ id_pedido: "LOW1", imei: "IMEI_LOW", idade: 1 });
    // 1 unidade no estoque
    const stock = [stockGroup({ qty: 1 })];
    const out = runMatchEngine(input({ lines: [priority, low], stock }));
    const devPrio = out.devices.find((d) => d.imei === "IMEI_PRIO")!;
    const devLow = out.devices.find((d) => d.imei === "IMEI_LOW")!;
    expect(devPrio.lines[0].resultStatus).toBe("MATCH");
    expect(devLow.lines[0].resultStatus).toBe("SEM SALDO");
  });

  it("PEDIR PECA quando CHAVEPECA não existe no estoque", () => {
    nextId = 5200;
    const l = line({ id_pedido: "PP1", imei: "IMEI_PP", chave_peca_norm: "tela" });
    // Estoque não tem TELA
    const stock = [stockGroup({ chavePecaNorm: "bat", qty: 5 })];
    const out = runMatchEngine(input({ lines: [l], stock }));
    expect(out.devices[0].lines[0].resultStatus).toBe("PEDIR PECA");
  });

  it("PEDIR PECA diferente de SEM SALDO — distinção por initialTotal", () => {
    nextId = 5300;
    const l1 = line({ id_pedido: "A1", imei: "IMEI_FIRST", idade: 200, chave_peca_norm: "bat" });
    const l2 = line({ id_pedido: "B1", imei: "IMEI_SECOND", idade: 1, chave_peca_norm: "bat" });
    const l3 = line({ id_pedido: "C1", imei: "IMEI_THIRD", chave_peca_norm: "tela" });
    const stock = [stockGroup({ chavePecaNorm: "bat", qty: 1 })];
    const out = runMatchEngine(input({ lines: [l1, l2, l3], stock }));
    const lineB = out.devices.find((d) => d.imei === "IMEI_SECOND")!.lines[0];
    const lineC = out.devices.find((d) => d.imei === "IMEI_THIRD")!.lines[0];
    // BAT existe mas foi esgotado → SEM SALDO
    expect(lineB.resultStatus).toBe("SEM SALDO");
    // TELA nunca existiu no estoque → PEDIR PECA
    expect(lineC.resultStatus).toBe("PEDIR PECA");
  });
});

describe("motor de match — VERIFICAR e casos especiais", () => {
  it("linhas sem IMEI resultam em VERIFICAR com reasonCode MISSING_IMEI", () => {
    nextId = 6000;
    const l: SourceOrderPartRow = {
      id: nextId++,
      id_pedido: "V1",
      imei: null,
      os: "OS1",
      chave_peca: "BAT",
      chave_peca_norm: "bat",
      referencia: null,
      status_atual_legado: "SOLICITADO",
      status_atual_label: null,
      status_kit_legado: null,
      prioridade_kit_legado: null,
      quantidade_pecas_aparelho: 1,
      idade: 30,
      custo: 100,
      venda: 200,
      margem_legada: null,
      nota_idade_legada: null,
      nota_margem_legada: null,
      score_legado: null,
      ordem_consumo_legada: null,
      quantidade_estoque_legada: null,
    };
    const out = runMatchEngine(input({ lines: [l], stock: [stockGroup({ qty: 5 })] }));
    const lineResult = out.devices[0].lines[0];
    expect(lineResult.resultStatus).toBe("VERIFICAR");
    expect(lineResult.reasonCode).toBe("MISSING_IMEI");
  });

  it("linhas sem CHAVEPECA resultam em VERIFICAR com reasonCode MISSING_KEY", () => {
    nextId = 6100;
    // Criar objeto diretamente (o helper usa ?? então null vira default)
    const l: SourceOrderPartRow = {
      id: nextId++,
      id_pedido: "V2",
      imei: "IMEI_V2",
      os: "OS1",
      chave_peca: null,
      chave_peca_norm: null,
      referencia: null,
      status_atual_legado: "SOLICITADO",
      status_atual_label: null,
      status_kit_legado: null,
      prioridade_kit_legado: null,
      quantidade_pecas_aparelho: 1,
      idade: 30,
      custo: 100,
      venda: 200,
      margem_legada: null,
      nota_idade_legada: null,
      nota_margem_legada: null,
      score_legado: null,
      ordem_consumo_legada: null,
      quantidade_estoque_legada: null,
    };
    const out = runMatchEngine(input({ lines: [l], stock: [stockGroup({ qty: 5 })] }));
    const lineResult = out.devices[0].lines[0];
    expect(lineResult.resultStatus).toBe("VERIFICAR");
    expect(lineResult.reasonCode).toBe("MISSING_KEY");
  });

  it("kit VERIFICAR quando alguma linha é VERIFICAR", () => {
    nextId = 6200;
    const l1 = line({ id_pedido: "KV1", imei: "IMEI_KV", quantidade_pecas_aparelho: 2 });
    const l2: SourceOrderPartRow = {
      id: nextId++,
      id_pedido: "KV2",
      imei: "IMEI_KV",
      os: "OS1",
      chave_peca: null,
      chave_peca_norm: null,
      referencia: null,
      status_atual_legado: "SOLICITADO",
      status_atual_label: null,
      status_kit_legado: null,
      prioridade_kit_legado: null,
      quantidade_pecas_aparelho: 2,
      idade: 30,
      custo: 100,
      venda: 200,
      margem_legada: null,
      nota_idade_legada: null,
      nota_margem_legada: null,
      score_legado: null,
      ordem_consumo_legada: null,
      quantidade_estoque_legada: null,
    };
    const stock = [stockGroup({ qty: 5 })];
    const out = runMatchEngine(input({ lines: [l1, l2], stock }));
    const dev = out.devices.find((d) => d.imei === "IMEI_KV")!;
    expect(dev.kitStatus).toBe("VERIFICAR");
  });

  it("aparelho sem IMEI não participa do primeiro passo (kit completo)", () => {
    nextId = 6300;
    const noImei: SourceOrderPartRow = {
      id: nextId++,
      id_pedido: "NI1",
      imei: null,
      os: "OS1",
      chave_peca: "BAT",
      chave_peca_norm: "bat",
      referencia: null,
      status_atual_legado: "SOLICITADO",
      status_atual_label: null,
      status_kit_legado: null,
      prioridade_kit_legado: null,
      quantidade_pecas_aparelho: 1,
      idade: 30,
      custo: 100,
      venda: 200,
      margem_legada: null,
      nota_idade_legada: null,
      nota_margem_legada: null,
      score_legado: null,
      ordem_consumo_legada: null,
      quantidade_estoque_legada: null,
    };
    const withImei = line({ id_pedido: "WI1", imei: "IMEI_W" });
    const stock = [stockGroup({ qty: 1 })];
    const out = runMatchEngine(input({ lines: [noImei, withImei], stock }));
    // O aparelho com IMEI deve ganhar o kit completo
    const devWith = out.devices.find((d) => d.imei === "IMEI_W")!;
    expect(devWith.kitStatus).toBe("KIT POSSIVEL");
    // O sem IMEI deve ficar VERIFICAR
    const devWithout = out.devices.find((d) => d.deviceKey === "__NO_IMEI__")!;
    expect(devWithout.lines[0].resultStatus).toBe("VERIFICAR");
  });
});

describe("motor de match — permanentes (PRESERVED)", () => {
  it("permanentes não consomem estoque", () => {
    nextId = 7000;
    const perm = line({ id_pedido: "PERM1", status_atual_legado: "CONCLUIDO" });
    const open = line({ id_pedido: "OPEN1", imei: "IMEI2" });
    const stock = [stockGroup({ qty: 1 })];
    const out = runMatchEngine(input({ lines: [perm, open], stock }));
    const pool = out.stockPools.get("bat")!;
    // A peça foi para OPEN1, não para PERM1
    expect(pool.allocatedFull).toBe(1);
    const permLine = out.devices
      .flatMap((d) => d.lines)
      .find((l) => l.idPedido === "PERM1")!;
    expect(permLine.allocationPhase).toBe("PRESERVED");
    expect(permLine.reservedUnits).toBe(0);
  });

  it("status operacional sobrescreve legado para marcar permanente", () => {
    nextId = 7100;
    const l = line({ id_pedido: "OP1", status_atual_legado: "SOLICITADO" });
    const events = new Map([["OP1", "SEPARADO"]]);
    const out = runMatchEngine(input({ lines: [l], events, stock: [] }));
    const lineResult = out.devices.flatMap((d) => d.lines).find((l2) => l2.idPedido === "OP1")!;
    expect(lineResult.effectiveStatusBefore).toBe("SEPARADO");
    expect(lineResult.allocationPhase).toBe("PRESERVED");
  });

  it("CANCELADO é tratado como permanente", () => {
    nextId = 7200;
    const l = line({ id_pedido: "CAN1", status_atual_legado: "CANCELADO" });
    const out = runMatchEngine(input({ lines: [l], stock: [] }));
    const lineResult = out.devices.flatMap((d) => d.lines)[0];
    expect(lineResult.allocationPhase).toBe("PRESERVED");
    expect(lineResult.reservedUnits).toBe(0);
  });

  it("kit com apenas permanentes tem allocationPhase PRESERVED no device", () => {
    nextId = 7300;
    const l1 = line({ id_pedido: "PP1", status_atual_legado: "CONCLUIDO" });
    const l2 = line({ id_pedido: "PP2", status_atual_legado: "SEPARADO" });
    const out = runMatchEngine(input({ lines: [l1, l2], stock: [] }));
    const dev = out.devices[0];
    expect(dev.allocationPhase).toBe("PRESERVED");
    expect(dev.openParts).toBe(0);
  });
});

describe("motor de match — ordem de consumo", () => {
  it("ordem de consumo começa em 1 por CHAVEPECA", () => {
    nextId = 8000;
    const l = line({ id_pedido: "OC1" });
    const stock = [stockGroup({ qty: 1 })];
    const out = runMatchEngine(input({ lines: [l], stock }));
    const lineResult = out.devices[0].lines[0];
    expect(lineResult.ordemConsumo).toBe(1);
  });

  it("FULL antes de PARTIAL na ordem de consumo", () => {
    nextId = 8100;
    // Aparelho A (kit completo) e aparelho B (parcial) — mesma CHAVEPECA
    const fullLine = line({ id_pedido: "FULL1", imei: "IMEI_FULL2", idade: 200 });
    const partLine = line({ id_pedido: "PART1", imei: "IMEI_PART2", idade: 1, chave_peca_norm: "bat" });
    // 2 unidades — FULL1 ganha kit completo, PART1 ganha parcial
    const stock = [stockGroup({ qty: 2 })];
    const out = runMatchEngine(input({ lines: [fullLine, partLine], stock }));

    const fullResult = out.devices
      .flatMap((d) => d.lines)
      .find((l) => l.idPedido === "FULL1")!;
    const partResult = out.devices
      .flatMap((d) => d.lines)
      .find((l) => l.idPedido === "PART1")!;

    // FULL deve ter ordem 1, PARTIAL deve ter ordem 2
    expect(fullResult.ordemConsumo).toBe(1);
    expect(partResult.ordemConsumo).toBe(2);
  });

  it("ordem de consumo é contínua por CHAVEPECA (sem lacunas)", () => {
    nextId = 8200;
    const lines = Array.from({ length: 3 }, (_, i) =>
      line({ id_pedido: `OC${i + 1}`, imei: `IMEI_${i}`, idade: 10 * (i + 1) }),
    );
    const stock = [stockGroup({ qty: 3 })];
    const out = runMatchEngine(input({ lines, stock }));
    const orders = out.devices
      .flatMap((d) => d.lines)
      .map((l) => l.ordemConsumo)
      .filter((o) => o !== null)
      .sort((a, b) => a! - b!);
    expect(orders).toEqual([1, 2, 3]);
  });

  it("ordem de consumo reseta por CHAVEPECA diferente", () => {
    nextId = 8300;
    const l1 = line({ id_pedido: "BAT1", imei: "IMEI_BAT", chave_peca_norm: "bat" });
    const l2 = line({ id_pedido: "TEL1", imei: "IMEI_TEL", chave_peca: "TELA", chave_peca_norm: "tela" });
    const stock = [
      stockGroup({ chavePecaNorm: "bat", qty: 1 }),
      stockGroup({ referencia: "PC-2", referenciaNorm: "pc-2", chavePecaNorm: "tela", qty: 1 }),
    ];
    const out = runMatchEngine(input({ lines: [l1, l2], stock }));
    const batLine = out.devices.flatMap((d) => d.lines).find((l) => l.chavePecaNorm === "bat")!;
    const telLine = out.devices.flatMap((d) => d.lines).find((l) => l.chavePecaNorm === "tela")!;
    // Cada CHAVEPECA começa em 1 independente
    expect(batLine.ordemConsumo).toBe(1);
    expect(telLine.ordemConsumo).toBe(1);
  });
});

describe("motor de match — warnings", () => {
  it("OS conflitante gera DEVICE_OS_CONFLICT", () => {
    nextId = 9000;
    const l1 = line({ id_pedido: "OS1", imei: "IMEI_OS", os: "OS_A" });
    const l2 = line({ id_pedido: "OS2", imei: "IMEI_OS", os: "OS_B" });
    const out = runMatchEngine(input({ lines: [l1, l2], stock: [] }));
    const dev = out.devices.find((d) => d.imei === "IMEI_OS")!;
    expect(dev.warningCodes).toContain("DEVICE_OS_CONFLICT");
  });

  it("OS sem conflito não gera warning", () => {
    nextId = 9100;
    const l1 = line({ id_pedido: "NOC1", imei: "IMEI_OK", os: "OS_A" });
    const l2 = line({ id_pedido: "NOC2", imei: "IMEI_OK", os: "OS_A" });
    const out = runMatchEngine(input({ lines: [l1, l2], stock: [] }));
    const dev = out.devices.find((d) => d.imei === "IMEI_OK")!;
    expect(dev.warningCodes).not.toContain("DEVICE_OS_CONFLICT");
  });
});

describe("motor de match — estoque não mapeado", () => {
  it("grupo sem mapeamento não entra nos pools", () => {
    nextId = 10000;
    const l = line({ id_pedido: "NM1" });
    const unmapped: OperationalStockGroup = {
      referencia: "X-999",
      referenciaNorm: "x-999",
      chavePeca: null,
      chavePecaNorm: null,
      baseQuantity: 10,
      movementQuantity: 0,
      currentQuantity: 10,
      mapeada: false,
    };
    const out = runMatchEngine(input({ lines: [l], stock: [unmapped] }));
    expect(out.stats.stockUnmappedUnits).toBe(10);
    expect(out.stats.stockUsableUnits).toBe(0);
    // A linha deve virar PEDIR PECA (nunca existiu mapeamento)
    expect(out.devices[0].lines[0].resultStatus).toBe("PEDIR PECA");
  });
});

describe("motor de match — scores negativos (item 1)", () => {
  it("score negativo é selecionado corretamente — -1 > -7", () => {
    nextId = 12000;
    // Dois aparelhos com scores negativos (custo > venda → margem negativa)
    // marginAllowsNegative=true: notaMargem negativa pune o score abaixo de zero
    const rule: DecisionRuleConfig = {
      ageDaysPerPoint: 10,
      ageMaxPoints: 10,
      marginPerPoint: 50,
      marginAllowsNegative: true,
    };
    // IMEI_NEG1: idade=0 (notaIdade=0), margem=-200 → notaMargem=floor(-200/50)=-4 → score=-4
    const l1 = line({ id_pedido: "N1", imei: "IMEI_NEG1", idade: 0, custo: 300, venda: 100 });
    // IMEI_NEG2: idade=0, margem=-600 → notaMargem=floor(-600/50)=-12 → score=-12
    const l2 = line({ id_pedido: "N2", imei: "IMEI_NEG2", idade: 0, custo: 700, venda: 100 });
    const stock = [stockGroup({ qty: 1 })];
    const out = runMatchEngine(input({ lines: [l1, l2], stock, rule }));
    const dev1 = out.devices.find((d) => d.imei === "IMEI_NEG1")!;
    const dev2 = out.devices.find((d) => d.imei === "IMEI_NEG2")!;
    // dev1 tem score mais alto (menos negativo: -4 > -12) → prioridade melhor
    expect(dev1.score).toBeGreaterThan(dev2.score);
    expect(dev1.priorityRank).toBeLessThan(dev2.priorityRank!);
    // IMEI_NEG1 recebe a peça
    expect(dev1.lines[0].resultStatus).toBe("MATCH");
    expect(dev2.lines[0].resultStatus).toBe("SEM SALDO");
  });

  it("device.score = score da linha representativa mesmo quando todos negativos", () => {
    nextId = 12100;
    // marginAllowsNegative=true: notaMargem negativa pune o score abaixo de zero
    const rule: DecisionRuleConfig = {
      ageDaysPerPoint: 10,
      ageMaxPoints: 10,
      marginPerPoint: 50,
      marginAllowsNegative: true,
    };
    // Aparelho com duas linhas — ambas com scores negativos
    // l1: margem=-400 → notaMargem=floor(-400/50)=-8 → score=-8
    // l2: margem=-700 → notaMargem=floor(-700/50)=-14 → score=-14
    const l1 = line({ id_pedido: "MN1", imei: "IMEI_MULTI_NEG", idade: 0, custo: 500, venda: 100 });
    const l2 = line({ id_pedido: "MN2", imei: "IMEI_MULTI_NEG", chave_peca: "TELA", chave_peca_norm: "tela", idade: 0, custo: 800, venda: 100 });
    const out = runMatchEngine(input({ lines: [l1, l2], stock: [], rule }));
    const dev = out.devices.find((d) => d.imei === "IMEI_MULTI_NEG")!;
    // device.score = score da linha representativa (maior, menos negativo: -8)
    const maxScore = Math.max(...dev.lines.map((l) => l.score));
    expect(dev.score).toBe(maxScore);
    // Não deve ser zero quando todos os scores são negativos
    expect(dev.score).toBeLessThan(0);
  });
});

describe("motor de match — stats", () => {
  it("estatísticas agregam corretamente", () => {
    nextId = 11000;
    const full = line({ id_pedido: "ST1", imei: "IMEI_ST1" });
    const pedir = line({ id_pedido: "ST2", imei: "IMEI_ST2", chave_peca_norm: "tela" });
    const perm = line({ id_pedido: "ST3", imei: "IMEI_ST3", status_atual_legado: "CONCLUIDO" });
    const stock = [stockGroup({ chavePecaNorm: "bat", qty: 1 })];
    const out = runMatchEngine(input({ lines: [full, pedir, perm], stock }));
    expect(out.stats.linesMatch).toBe(1);
    expect(out.stats.linesRequestPiece).toBe(1);
    expect(out.stats.linesPreserved).toBe(1);
    expect(out.stats.allocatedUnits).toBe(1);
  });

  it("output sem demanda retorna stats zerados (chamada de getCurrentState)", () => {
    nextId = 11100;
    const stock = [stockGroup({ qty: 5 })];
    const out = runMatchEngine(input({ lines: [], stock }));
    expect(out.stats.linesTotal).toBe(0);
    expect(out.stats.stockUsableUnits).toBe(5);
  });
});
