# Auditoria de Estabilização — Camada de Custos de Peças

**Data:** 2026-07-22  
**Branch:** `claude/canonical-parts-cost-layer-073927`  
**Banco auditado:** `data/app-beta-audit.sqlite` (cópia de `data/app-beta-copy.sqlite`)  
**Checksum original:** `b3612c6b08b4f355a1c8e09e8934abd1578a95c713f513978d97300b0ad4067b` (SHA-256)

---

## 1. Resumo executivo

9 commits corrigem 11 problemas identificados na camada de custos de peças. Todos os 729 testes passam (18 novos), typecheck limpo, build verde. FK violations: 208 → 0. Modo sombra permanece ativo — custo de peças NÃO foi ativado no score real. Nenhum workflow foi alterado automaticamente.

---

## 2. Problemas confirmados

| # | Problema | Status | Confirmado? |
|---|----------|--------|-------------|
| 1 | FK violations por exclusão física de usuário | **Corrigido** | Sim: 208 violações, todas apontando user ID 1 → 18 tabelas |
| 2 | Override restaurado contamina resolução de custo | **Corrigido** | Sim: COST_CORRECTION e MANUAL_OVERRIDE tinham prioridade 5, podiam virar custo vigente |
| 3 | MANAGE_PART_COSTS ausente do catálogo de permissões | **Corrigido** | Sim: KNOWN_PERMISSIONS não incluía a permissão |
| 4 | part_price_events sem proteção contra UPDATE/DELETE | **Corrigido** | Sim: sem triggers de imutabilidade |
| 5 | Backfill all-or-nothing impede conclusão parcial | **Corrigido** | Sim: qualquer BACKFILL_% existente bloqueava todo o backfill |
| 6 | Resolução de custos não determinística | **Corrigido** | Sim: compatibilidade sem ordenação, sem tiebreaker estável |
| 7 | Fingerprint dependente da ordem de leitura | **Corrigido** | Sim: usava part.id e não ordenava antes do hash |
| 8 | Avaliações econômicas sem detecção de desatualização | **Corrigido** | Sim: nenhum mecanismo de staleness |
| 9 | as_is_require_approval sem efeito real | **Corrigido** | Sim: campo lido do DB mas nunca verificado |
| 10 | Migration 056 ausente no repositório | **Corrigido** | Sim: aplicada no banco beta, arquivo inexistente no Git |
| 11 | APPROVE_AS_IS inexistente — qualquer OPERATOR podia aprovar | **Corrigido** | Sim: rota usava requireOperator, sem permissão específica |

## 3. Problemas não reproduzidos

Nenhum. Todos os 11 problemas foram confirmados com evidência.

---

## 4. Causa raiz de cada problema

1. **FK violations:** `deleteUser()` usava `DELETE FROM users` com `foreign_keys=OFF` (ou antes das FKs existirem). User ID 1 foi excluído fisicamente, deixando 208 referências órfãs em 18 tabelas.

2. **Override contamina custo:** `COST_CORRECTION` (evento de auditoria da restauração) e `MANUAL_OVERRIDE` tinham prioridade 5 na tabela de prioridades do `resolveFromEvents`. Ao restaurar um override, o evento COST_CORRECTION registrava o preço antigo do override, que depois era selecionado como "melhor fonte" pelo resolvedor.

3. **Permissão ausente:** `KNOWN_PERMISSIONS` em auth-routes.ts listava apenas `OVERRIDE_REPAIR_STATUS` e `MANAGE_PART_REFERENCES`. A tentativa de conceder `MANAGE_PART_COSTS` pelo admin retornava erro 400.

4. **Sem imutabilidade:** A migration 058 criou a tabela sem triggers `BEFORE UPDATE` / `BEFORE DELETE`.

5. **Backfill all-or-nothing:** A checagem `SELECT COUNT(*) WHERE source_type LIKE 'BACKFILL_%'` retornava >0 se qualquer evento de backfill existisse, bloqueando todo o processo. Interrupção no meio = backfill permanentemente incompleto.

6. **Resolução não determinística:** `compatGroupMembers` era iterado na ordem recebida (arbitrária), e eventos com mesma prioridade e data não tinham tiebreaker por ID.

7. **Fingerprint dependente de ordem:** `fingerprintParts` era construído na ordem de retorno do DB (`ORDER BY` implícito do SQLite) e incluía `part.id` (irrelevante para identidade de custo).

8. **Sem staleness:** `getEconomicEvaluation` retornava o registro salvo sem verificar se o fingerprint de custo ou a regra ativa mudaram desde a avaliação.

9. **requireApproval sem efeito:** O campo era lido via `loadAsIsPolicy` mas `evaluateEconomics` nunca o verificava. O código sempre exigia `approveAsIs` explícito, mas a configuração sugeria que auto-aprovação era possível.

10. **Migration 056 ausente:** `056_issue_status_awaiting_test.sql` foi aplicada no banco beta em 2026-07-21 mas o arquivo não foi versionado no Git (provavelmente criada em outra branch ou sessão).

11. **APPROVE_AS_IS inexistente:** As rotas de approve/reject usavam `requireOperator`, permitindo que qualquer operador aprovasse Venda no Estado.

---

## 5. Arquivos alterados

| Arquivo | Mudança |
|---------|---------|
| `src/auth/auth-service.ts` | deleteUser: soft-delete em vez de DELETE físico |
| `src/server/routes/auth-routes.ts` | KNOWN_PERMISSIONS: +MANAGE_PART_COSTS, +APPROVE_AS_IS |
| `src/server/routes/economics-routes.ts` | approve/reject: requirePermissionOrAdmin("APPROVE_AS_IS") |
| `src/client/pages/AdminUsuarios.tsx` | Toggles para as 4 permissões no admin |
| `src/operational/cost-resolution-service.ts` | Remove MANUAL_OVERRIDE/COST_CORRECTION das prioridades, tiebreaker estável, compat keys sorted |
| `src/operational/part-price-backfill.ts` | Idempotência por cotacao_item_id/purchase_order_item_id |
| `src/operational/repair-parts-cost-service.ts` | Fingerprint: sort antes do hash, remove part.id |
| `src/match/economic-evaluation-service.ts` | Staleness detection, rule_set_id, requireApproval=true fixo |
| `src/db/migrate.ts` | Guard para migration 056 |

## 6. Migrations criadas

| Migration | Propósito |
|-----------|-----------|
| `056_issue_status_awaiting_test.sql` | **Recuperada** — adiciona AWAITING_TEST ao CHECK de issue_reports.status |
| `062_integrity_and_audit_fixes.sql` | Triggers de imutabilidade em part_price_events; rule_set_id em case_economic_evaluations |

## 7. Reparos feitos no banco de teste

- `scripts/repair-fk-violations.ts` executado contra `data/app-beta-audit.sqlite`
- Reinserido user ID 1 como `_historico_001` (desativado, pin=DISABLED_NO_LOGIN)
- Migration 062 aplicada (triggers + coluna rule_set_id)

## 8. Resultado FK check

| Momento | Violações |
|---------|-----------|
| Antes do reparo | 208 (18 tabelas → users) |
| Após reparo + migration 062 | **0** |
| integrity_check | **ok** |

## 9. Resultado dos testes

```
Test Files  51 passed (51)
     Tests  729 passed (729)  [18 novos]
  Duration  110.48s
```

18 novos testes em `tests/integrity-fixes.test.ts`:
- 3 user soft-delete + FK integrity
- 3 part_price_events immutability (INSERT ok, UPDATE bloqueado, DELETE bloqueado)
- 5 override restore (GOODS_RECEIPT, sem fonte, APPROVED_COTACAO, BACKFILL, compatibilidade)
- 2 backfill per-record idempotency
- 2 deterministic cost resolution
- 2 deterministic fingerprint
- 1 economic evaluation staleness

## 10. Resultado do typecheck

```
tsc --noEmit: 0 erros
```

## 11. Resultado do build

```
build:server — 0 erros
build:client — ✓ built in 2.50s
```

## 12. Resultado da validação de custos

| Métrica | Valor |
|---------|-------|
| Casos abertos | 707 |
| Cobertura total (100%) | 167 |
| Cobertura parcial | 59 |
| Sem preço | 477 |
| Margens alteradas (se ativado) | 225 |
| Modo sombra = legado | **Sim** (fila idêntica) |
| Status mudariam (se ativado) | 2 |
| Posições mudariam (se ativado) | 625 |
| Eventos históricos | 426 |
| Backfill 2ª execução | 0 novos, 426 skipped |
| Overrides ativos | 0 |
| Avaliações econômicas: viáveis | 166 |
| Avaliações econômicas: custo incompleto | 536 |
| Avaliações econômicas: não avaliados | 5 |

## 13. Confirmação: modo sombra ativo

**Sim.** `include_parts_cost` e `shadow_mode` não foram alterados em nenhuma regra de match. A fila oficial permanece idêntica ao legado.

## 14. Confirmação: nenhum workflow alterado automaticamente

**Sim.** Nenhum caso foi movido para VENDA_ESTADO. A aprovação humana continua obrigatória e agora exige permissão `APPROVE_AS_IS` (não mais qualquer OPERATOR).

## 15. Commits criados

```
461fce5 test: add cost layer regression and integrity coverage
94bffd4 fix: recover missing migration 056 and add guard
4c27361 fix: detect stale economic evaluations and enforce approval
5ce7aab fix: make cost fingerprints deterministic
350ac43 fix: make historical price backfill resumable and idempotent
b4f7f00 fix: protect part price events as append-only
3c279b5 fix: register and enforce parts cost permissions
e65b2a1 fix: restore canonical part cost after override removal
89d08e4 fix: prevent physical user deletion and add FK repair script
```

## 16. Riscos restantes

1. **Cobertura de custo baixa (67% sem preço):** 477 de 707 casos não têm preço de peça. Isso é esperado — depende de recebimentos futuros. A cobertura vai crescer naturalmente.

2. **User ID 1 no banco beta real:** O reparo foi feito na cópia de auditoria. O banco beta real (`data/app.sqlite`) ainda tem as 208 violações FK. O script `repair-fk-violations.ts` deve ser executado contra ele antes do deploy, ou a migration 062 deve incluir o INSERT condicional.

3. **Fingerprint quebra cache anterior:** A mudança no cálculo do fingerprint (remoção do `part.id`, adição do `sort`) altera todos os fingerprints existentes. Avaliações econômicas anteriores serão detectadas como "stale" na primeira consulta após o deploy. Isso é correto e esperado.

4. **Permissão APPROVE_AS_IS não concedida:** A permissão existe no catálogo mas nenhum usuário a possui ainda. Após o deploy, um ADMIN precisa concedê-la aos operadores autorizados.

## 17. Pendências que exigem decisão humana

1. **Executar reparo FK no banco beta real** — rodar `scripts/repair-fk-violations.ts` contra `data/app.sqlite` antes do deploy.

2. **Conceder permissão APPROVE_AS_IS** — decidir quais operadores podem aprovar Venda no Estado.

3. **Ativar custo de peças no score real** — requer aprovação explícita após auditoria dos números (225 margens mudariam, 2 status + 625 posições afetadas).

4. **Dashboard de qualidade de custos (§22 da spec)** — não implementado nesta fase.

5. **Merge e deploy** — aguardando aprovação.
