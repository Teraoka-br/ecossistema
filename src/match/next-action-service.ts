/**
 * Deriva a próxima ação operacional de um repair_case.
 * Puro — sem acesso a banco. Chame com os dados já carregados.
 */

import type { WorkflowStatus } from "../repair/repair-service.js";

export type NextActionCode =
  | "CONTINUE_ANALYSIS"
  | "FIX_PENDING"
  | "SEPARATE_KIT"
  | "SEPARATE_AVAILABLE"
  | "ADD_TO_PURCHASE"
  | "CHECK_PURCHASE_ORDER"
  | "DIRECT_TO_TECHNICIAN"
  | "START_REPAIR"
  | "COMPLETE_REPAIR"
  | "AWAIT_TRIAGE"
  | "VIEW_HISTORY"
  | "REOPEN_OR_REVIEW";

export interface NextAction {
  code: NextActionCode;
  label: string;
  description: string;
  enabled: boolean;
  requiredRole: "OPERATOR" | "ADMIN" | "ANY";
}

export function deriveNextAction(
  workflowStatus: WorkflowStatus,
  _opts: {
    analysisCompleted: boolean;
    allPartsReserved: boolean;
    hasActiveReservations: boolean;
  } = { analysisCompleted: false, allPartsReserved: false, hasActiveReservations: false },
): NextAction {
  switch (workflowStatus) {
    case "EM_ANALISE":
      return {
        code: "CONTINUE_ANALYSIS",
        label: "Continuar análise",
        description: "Completar os dados do aparelho e das peças necessárias.",
        enabled: true,
        requiredRole: "OPERATOR",
      };

    case "VERIFICAR":
      return {
        code: "FIX_PENDING",
        label: "Corrigir pendência",
        description: "Há uma inconsistência que impede o processamento. Revise os dados do caso.",
        enabled: true,
        requiredRole: "OPERATOR",
      };

    case "MATCH":
      return {
        code: "SEPARATE_KIT",
        label: "Separar kit",
        description: "Todas as peças foram localizadas no estoque. Confirme a separação física.",
        enabled: true,
        requiredRole: "OPERATOR",
      };

    case "MATCH_PARCIAL":
      return {
        code: "SEPARATE_AVAILABLE",
        label: "Separar disponíveis",
        description: "Parte das peças está disponível. Confirme as disponíveis e solicite as faltantes.",
        enabled: true,
        requiredRole: "OPERATOR",
      };

    case "PEDIR_PECA":
      return {
        code: "ADD_TO_PURCHASE",
        label: "Incluir em compra",
        description: "As peças necessárias não estão em estoque. Inclua-as em um pedido de compra.",
        enabled: true,
        requiredRole: "OPERATOR",
      };

    case "AGUARDANDO_RECEBIMENTO":
      return {
        code: "CHECK_PURCHASE_ORDER",
        label: "Consultar pedido",
        description: "Peças foram pedidas. Aguardando recebimento do fornecedor.",
        enabled: false,
        requiredRole: "OPERATOR",
      };

    case "EM_SEPARACAO":
      return {
        code: "SEPARATE_KIT",
        label: "Concluir separação",
        description: "Separação em andamento. Confirme todas as peças para liberar ao técnico.",
        enabled: true,
        requiredRole: "OPERATOR",
      };

    case "APTO_REPARO":
      return {
        code: "DIRECT_TO_TECHNICIAN",
        label: "Direcionar ao técnico",
        description: "Todas as peças estão separadas. Selecione o técnico responsável.",
        enabled: true,
        requiredRole: "OPERATOR",
      };

    case "DIRECIONADO_TECNICO":
      return {
        code: "START_REPAIR",
        label: "Iniciar reparo",
        description: "Aparelho direcionado ao técnico. Confirme o início do reparo.",
        enabled: true,
        requiredRole: "OPERATOR",
      };

    case "EM_REPARO":
      return {
        code: "COMPLETE_REPAIR",
        label: "Concluir reparo",
        description: "Reparo em execução. Confirme a conclusão para consumir as peças reservadas.",
        enabled: true,
        requiredRole: "OPERATOR",
      };

    case "REPARO_EXECUTADO":
    case "TRIAGEM_FINAL":
      return {
        code: "AWAIT_TRIAGE",
        label: "Aguardar triagem final",
        description: "Reparo executado. Aguardando triagem final de qualidade.",
        enabled: false,
        requiredRole: "OPERATOR",
      };

    case "RETORNO_TECNICO":
      return {
        code: "REOPEN_OR_REVIEW",
        label: "Revisar retorno ao técnico",
        description: "Aparelho retornou ao técnico. Verifique o motivo e o próximo passo.",
        enabled: true,
        requiredRole: "ADMIN",
      };

    case "CONCLUIDO":
    case "VENDA_ESTADO":
    case "CANCELADO":
      return {
        code: "VIEW_HISTORY",
        label: "Consultar histórico",
        description: "Caso encerrado. Consulte o histórico para mais detalhes.",
        enabled: true,
        requiredRole: "ANY",
      };
  }
}

export type QueueFilter =
  | "DO_NOW"
  | "MATCH"
  | "MATCH_PARCIAL"
  | "AGUARDANDO_PECAS"
  | "COM_TECNICO"
  | "EM_ANALISE"
  | "VERIFICAR"
  | "VENDA_ESTADO"
  | "FINALIZADOS"
  | "TODOS";

export const QUEUE_FILTER_STATUSES: Record<QueueFilter, WorkflowStatus[] | null> = {
  DO_NOW: ["MATCH", "APTO_REPARO", "MATCH_PARCIAL", "VERIFICAR"],
  MATCH: ["MATCH"],
  MATCH_PARCIAL: ["MATCH_PARCIAL"],
  AGUARDANDO_PECAS: ["PEDIR_PECA", "AGUARDANDO_RECEBIMENTO"],
  COM_TECNICO: ["APTO_REPARO", "DIRECIONADO_TECNICO", "EM_REPARO", "REPARO_EXECUTADO", "TRIAGEM_FINAL", "RETORNO_TECNICO"],
  EM_ANALISE: ["EM_ANALISE", "EM_SEPARACAO"],
  VERIFICAR: ["VERIFICAR"],
  VENDA_ESTADO: ["VENDA_ESTADO"],
  FINALIZADOS: ["CONCLUIDO", "CANCELADO"],
  TODOS: null,
};
