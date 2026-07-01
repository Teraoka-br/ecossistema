import type { TableRole } from "../shared/types.js";
import { normalizeHeader } from "../domain/text.js";

/**
 * Definição de uma tabela de origem: campos canônicos e os apelidos de
 * cabeçalho (já normalizados) que mapeiam para cada campo. A detecção localiza
 * a tabela pelo CONTEÚDO dos cabeçalhos — nunca pela posição da aba.
 */
export interface RoleSpec {
  role: TableRole;
  label: string;
  /** campo canônico → lista de apelidos de cabeçalho (texto cru; normalizados aqui). */
  fields: Record<string, string[]>;
  /** campos canônicos obrigatórios para classificar a aba neste papel. */
  required: string[];
}

function norm(aliases: string[]): string[] {
  return aliases.map(normalizeHeader);
}

export const ROLE_SPECS: RoleSpec[] = [
  {
    role: "ORDERS",
    label: "Pedidos (peças por aparelho)",
    fields: {
      idPedido: norm(["ID PEDIDO", "IDPEDIDO"]),
      imei: norm(["IMEI"]),
      os: norm(["OS"]),
      concatPeca: norm(["CONCATPEÇA", "CONCAT PEÇA", "CONCATPECA"]),
      status: norm(["STATUS"]),
      refPeca: norm(["REFPEÇA", "REF PEÇA", "REFPECA"]),
      qtdePecas: norm(["QTDE DE PEÇAS", "QTDE PEÇAS", "QUANTIDADE DE PEÇAS"]),
      idade: norm(["IDADE"]),
      custo: norm(["CUSTO"]),
      venda: norm(["VENDA"]),
      margem: norm(["MARGEM"]),
      chavePeca: norm(["CHAVEPEÇA", "CHAVE PEÇA", "CHAVEPECA"]),
      notaIdade: norm(["NOTA IDADE"]),
      notaMargem: norm(["NOTA MARGEM"]),
      score: norm(["SCORE PRIORIDADE", "SCORE"]),
      ordemConsumo: norm(["ORDEMCONSUMO", "ORDEM CONSUMO", "ORDEM DE CONSUMO"]),
      qtdEstoque: norm(["QTDESTOQUE", "QTD ESTOQUE", "QUANTIDADE ESTOQUE"]),
      pecasSemEstoque: norm(["PEÇAS SEM ESTOQUE", "PECAS SEM ESTOQUE"]),
      statusKit: norm(["STATUS KIT"]),
      prioridadeKit: norm(["PRIORIDADE KIT"]),
    },
    required: ["idPedido", "imei", "status", "chavePeca", "statusKit"],
  },
  {
    role: "INVENTORY",
    label: "Estoque físico (bipagem)",
    fields: {
      idPecaEstoque: norm([
        "IDPEÇA",
        "ID PEÇA",
        "IDPECA",
        "ID PECA",
        "ID_PECA_ESTOQUE",
        "ID PECA ESTOQUE",
      ]),
      referencia: norm(["REFERENCIA", "REFERÊNCIA"]),
      descricao: norm(["DESCRIÇÃO", "DESCRICAO"]),
      fornecedor: norm(["FORNECEDOR"]),
      chavePeca: norm(["CHAVEPECA", "CHAVE PECA", "CHAVEPEÇA"]),
      status: norm(["STATUS"]),
      arrumar: norm(["ARRUMAR"]),
      qtde: norm(["QTDE", "QUANTIDADE"]),
    },
    required: ["referencia", "chavePeca"],
  },
  {
    role: "QUOTATIONS",
    label: "Cotações (peças a pedir)",
    fields: {
      idPedido: norm(["ID PEDIDO", "IDPEDIDO"]),
      chavePeca: norm(["CHAVEPEÇA", "CHAVE PEÇA", "CHAVEPECA"]),
      quantidade: norm(["QTDE", "QUANTIDADE"]),
      valorUnitario: norm(["VALOR UN", "VALOR UNITÁRIO", "VALOR UNITARIO", "VALOR UNIT"]),
      valorTotal: norm(["VALOR TOTAL"]),
      dataCotacao: norm(["DATA COTAÇÃO", "DATA COTACAO"]),
      status: norm(["STATUS"]),
    },
    required: ["chavePeca", "valorUnitario", "valorTotal", "dataCotacao"],
  },
  {
    role: "ANALYSIS",
    label: "Origem analítica (análise MI)",
    fields: {
      imei: norm(["IMEI"]),
      os: norm(["OS"]),
      marca: norm(["MARCA"]),
      modelo: norm(["MODELO"]),
      cor: norm(["COR"]),
      pecaSolicitada: norm(["PEÇASOLICITADA", "PEÇA SOLICITADA", "PECASOLICITADA"]),
      corNaPeca: norm(["CORNAPEÇA", "COR NA PEÇA", "CORNAPECA"]),
      dataPedido: norm(["DATAPEDIDO", "DATA PEDIDO"]),
      status: norm(["STATUS"]),
      concatPeca: norm(["CONCATPEÇA", "CONCAT PEÇA", "CONCATPECA"]),
      deposito: norm(["DEPÓSITO", "DEPOSITO"]),
      descricao: norm(["DESCRIÇÃO", "DESCRICAO"]),
      ref: norm(["REF"]),
      idPedido: norm(["ID PEDIDO", "IDPEDIDO"]),
      solicitante: norm(["SOLICITANTE"]),
    },
    required: ["imei", "marca", "modelo", "pecaSolicitada", "idPedido"],
  },
];

export function specFor(role: TableRole): RoleSpec {
  const spec = ROLE_SPECS.find((s) => s.role === role);
  if (!spec) throw new Error(`RoleSpec ausente para ${role}`);
  return spec;
}

/** Mapa campo-canônico → índice de coluna, dado o cabeçalho normalizado. */
export type ColumnIndex = Record<string, number>;

/**
 * Resolve os índices de coluna para um papel a partir do cabeçalho normalizado.
 * Retorna também quais apelidos foram casados e quais obrigatórios faltaram.
 */
export function resolveColumns(
  spec: RoleSpec,
  normalizedHeader: string[],
): { columns: ColumnIndex; matched: string[]; missingRequired: string[] } {
  const columns: ColumnIndex = {};
  const matched: string[] = [];
  for (const [field, aliases] of Object.entries(spec.fields)) {
    const idx = normalizedHeader.findIndex((h) => aliases.includes(h));
    if (idx >= 0) {
      columns[field] = idx;
      matched.push(field);
    }
  }
  const missingRequired = spec.required.filter((f) => !(f in columns));
  return { columns, matched, missingRequired };
}
