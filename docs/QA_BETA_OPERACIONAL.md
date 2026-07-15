# QA Beta Operacional — Sistema de Peças

> Checklist de validação manual por tela. Executar antes de cada implantação em produção.
> Risco: **CRÍTICO** = altera dados permanentemente; **ALTO** = altera banco mas reversível via suporte; **BAIXO** = leitura ou UI apenas.

---

## 1. Login / Autenticação

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 1.1 | Fazer login com credenciais válidas | Redireciona para /home ou última tela | Nenhum (JWT session) | BAIXO | Verificar token no localStorage |
| 1.2 | Tentar login com senha errada | Mensagem de erro, sem redirecionamento | Nenhum | BAIXO | Contador de tentativas em log |
| 1.3 | Acessar rota protegida sem login | Redireciona para /login | Nenhum | BAIXO | Verificar URL |
| 1.4 | Sessão expirada → nova aba | Redireciona para /login | Nenhum | BAIXO | Limpar cookie e recarregar |

---

## 2. Home / Dashboard

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 2.1 | Carregar /home | Cards de status carregam sem erro 500 | Nenhum | BAIXO | Verificar console do browser |
| 2.2 | Clicar em card de status | Navega para tela correta | Nenhum | BAIXO | Verificar URL |

---

## 3. Dados / Importação

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 3.1 | Upload de Rel. Estoque de Seriais (com saldo) | Sincroniza depósitos; só aparelhos em AGUARDANDO PECA e MANUTENCAO INTERNA entram como novos casos | repair_cases (insert/update) | ALTO | Verificar contagem de criados vs. ignorados na resposta |
| 3.2 | Upload de Rel. Estoque de Seriais (sem saldo) | Marca aparelhos como sem saldo | repair_cases.source_disponivel | ALTO | Confirmar que status avançados (EM_REPARO, CONCLUIDO) não foram revertidos |
| 3.3 | Tentar importar Excel após sistema já inicializado | Erro claro de "já inicializado" | Nenhum | BAIXO | Verificar mensagem de bloqueio |
| 3.4 | Upload com arquivo corrompido | Mensagem de erro amigável | Nenhum | BAIXO | Testar com arquivo .txt renomeado para .xlsx |

---

## 4. Análise de Aparelhos

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 4.1 | Abrir ficha de análise de aparelho | Peças do aparelho listadas, status DRAFT | Nenhum | BAIXO | Verificar analysis_status |
| 4.2 | Adicionar peça na análise | Peça adicionada à lista | part_requests (insert) | ALTO | Recarregar e confirmar |
| 4.3 | Remover peça | Peça removida da lista | part_requests (delete) | ALTO | Recarregar e confirmar |
| 4.4 | Finalizar análise (botão Concluir) | analysis_status → COMPLETED; motor reagenda recompute | repair_cases, part_requests | CRÍTICO | Confirmar que status não pode voltar para DRAFT sem pedido explícito |
| 4.5 | Finalizar análise sem peças | Bloqueio ou confirmação de alerta | Nenhum | BAIXO | Verificar mensagem |

---

## 5. Fila de Reparos

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 5.1 | Carregar fila | Lista de casos com status correto | Nenhum | BAIXO | Verificar contagem vs. banco |
| 5.2 | Filtrar por status | Lista filtra corretamente | Nenhum | BAIXO | Comparar com query direta |
| 5.3 | Abrir detalhe de caso | Dados do aparelho e peças corretos | Nenhum | BAIXO | Conferir IMEI e peças |

---

## 6. Detalhe do Caso / Separação

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 6.1 | Iniciar separação (status MATCH) | workflow_status → EM_SEPARACAO | repair_cases | ALTO | Verificar no banco |
| 6.2 | Confirmar separação | workflow_status → APTO_REPARO; reservas criadas | repair_cases, reservations | CRÍTICO | Verificar reservas no banco |
| 6.3 | Cancelar separação | workflow_status volta; reservas canceladas | repair_cases, reservations | ALTO | Verificar integridade das reservas |

---

## 7. Técnico

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 7.1 | Iniciar reparo | workflow_status → EM_REPARO; repair_started_at preenchido | repair_cases | ALTO | Verificar timestamp |
| 7.2 | Finalizar reparo | workflow_status → REPARO_EXECUTADO; repair_finished_at preenchido | repair_cases | ALTO | Verificar timestamp |
| 7.3 | Lançar devolução/retorno técnico | workflow_status → RETORNO_TECNICO | repair_cases | ALTO | Verificar log |

---

## 8. Compras

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 8.1 | Criar solicitação de compra | purchase_requests criada com status PENDING | purchase_requests | ALTO | Verificar no banco |
| 8.2 | Aprovar solicitação | status → APPROVED | purchase_requests | ALTO | Verificar log de aprovação |
| 8.3 | Criar pedido de compra | purchase_orders criado | purchase_orders, purchase_order_items | CRÍTICO | Verificar vinculação com solicitações |
| 8.4 | Cancelar solicitação | status → CANCELLED | purchase_requests | ALTO | Verificar que part_request voltou para PENDENTE |

---

## 9. Recebimento

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 9.1 | Receber item de pedido | receipt_items criado; stock_movements registrado | receipt_items, stock_movements | CRÍTICO | Verificar saldo operacional após recebimento |
| 9.2 | Receber parcialmente | purchase_order.status → PARTIALLY_RECEIVED | purchase_orders | ALTO | Verificar status do pedido |
| 9.3 | Receber tudo | purchase_order.status → RECEIVED | purchase_orders | ALTO | Verificar fechamento do pedido |

---

## 10. Estoque

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 10.1 | Carregar tela de estoque | Itens listados com saldo operacional correto | Nenhum | BAIXO | Comparar com query `getCurrentOperationalStock` |
| 10.2 | Filtrar por peça | Filtra corretamente | Nenhum | BAIXO | Visual |

---

## 11. Contagem / Bipagem

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 11.1 | Iniciar sessão de contagem | stock_count_sessions criada com status OPEN | stock_count_sessions | ALTO | Verificar no banco |
| 11.2 | Bipar serial válido | count_scans inserido; referência mapeada ou pendente | count_scans | ALTO | Verificar mapping_status |
| 11.3 | Bipar mesmo serial duas vezes | Segunda bipagem registrada como DUPLICADA | count_scans | BAIXO | Verificar no banco |
| 11.4 | Cancelar scan | cancelled_at preenchido; scan histórico preservado | count_scans | ALTO | Confirmar que mapping_status original não foi alterado |
| 11.5 | Finalizar sessão (canFinalize=true) | status → FINALIZED; snapshots OFFICIAL criados | stock_snapshots, stock_count_sessions | CRÍTICO | Verificar que saldo operacional atualiza |
| 11.6 | Tentar finalizar com pendências | Bloqueio com lista de pendências | Nenhum | BAIXO | Verificar mensagem de blockers |

---

## 12. Referências

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 12.1 | Resolver referência manualmente | reference_mappings atualizado; pendências recalculadas ao vivo | reference_mappings | ALTO | Verificar que scan original não foi alterado |
| 12.2 | Filtrar referências pendentes | Lista correta | Nenhum | BAIXO | Visual |

---

## 13. Regras do Match (AdminMatchRules)

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 13.1 | Carregar tela | Banner de cobertura carrega com totais e percentuais | Nenhum | BAIXO | Verificar se lowCoverageAlert aparece quando pertinente |
| 13.2 | Executar backfill (banner) | Campos preenchidos em repair_cases; score não pode regredir | repair_cases.age_days/cost/estimated_sale/margin | ALTO | Conferir resultado retornado (ageDaysUpdated, marginUpdated) |
| 13.3 | Criar nova versão de regra | Rascunho criado com versão incrementada | match_rule_sets | BAIXO | Verificar no banco |
| 13.4 | Simular impacto de rascunho | Resultado exibe fullKitsFound, partialKitsFound, changedComparedToActive | Nenhum (dry-run) | BAIXO | Confirmar que repair_match_runs **não** foi criado |
| 13.5 | Ativar rascunho com justificativa | Versão anterior desativada; nova ativa; motor reagendado | match_rule_sets, repair_match_runs | CRÍTICO | Verificar que somente 1 regra está active=1 |
| 13.6 | Tentar ativar sem justificativa | Bloqueio — campo obrigatório | Nenhum | BAIXO | Verificar validação no frontend |

---

## 14. Diagnóstico (se tela existir)

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 14.1 | Carregar /diagnostico ou similar | Dados de saúde do sistema visíveis | Nenhum | BAIXO | Sem erros 500 no console |

---

## 15. Usuários / Pessoas

| # | Ação | Resultado esperado | Dados alterados | Risco | Como validar |
|---|------|--------------------|-----------------|-------|--------------|
| 15.1 | Listar usuários (admin) | Lista visível | Nenhum | BAIXO | Verificar sem erros |
| 15.2 | Criar usuário | users criado; senha hasheada | users | ALTO | Confirmar que senha não aparece em plaintext no banco |
| 15.3 | Alterar role | role atualizado | users | ALTO | Verificar que permissões mudam na próxima sessão |

---

## Notas gerais

- **Nunca resetar o banco** (`data/app.sqlite`) durante o beta. Backups estão em `data/backups/`.
- Após qualquer deploy: conferir `/api/health` e testar pelo menos os itens CRÍTICOS desta lista.
- Erros 500 no console do browser ou nos logs do servidor devem bloquear o go-live.
- O motor de match executa assincronamente — aguardar até 30 segundos antes de verificar mudanças de `workflow_status`.
