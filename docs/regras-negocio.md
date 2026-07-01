# Regras de negócio

## Status de pedido

Tokens canônicos (normalizados) e rótulos amigáveis:

| Token         | Rótulo        | Permanente |
| ------------- | ------------- | :--------: |
| MATCH         | MATCH         |            |
| MATCH PARCIAL | MATCH PARCIAL |            |
| PEDIR PECA    | PEDIR PEÇA    |            |
| SEM SALDO     | SEM SALDO     |            |
| VERIFICAR     | VERIFICAR     |            |
| CONCLUIDO     | CONCLUÍDO     |     ✓      |
| SEPARADO      | SEPARADO      |     ✓      |
| CANCELADO     | CANCELADO     |     ✓      |

Status são normalizados (acento/caixa/espaço) para comparação, mas o rótulo amigável é
preservado para exibição. Status **permanentes** não podem ser apagados por recálculo futuro.

## Status e prioridade do kit

| Status kit      | Prioridade |
| --------------- | :--------: |
| KIT POSSÍVEL    | 1          |
| MATCH PARCIAL   | 2          |
| KIT INCOMPLETO  | 9          |
| VERIFICAR       | 9          |

## Score de prioridade (configurável)

A política atual (padrão) está em `decision_rules` e pode ser alterada sem mexer no código:

- **Nota de idade** = `floor(IDADE / 30)`, mínimo 0, máximo 15.
- **Nota de margem** = `INT(MARGEM / 150)` — `INT` do Excel (arredonda para −∞), então **margem
  negativa pune** (puxa o aparelho para baixo na fila).
- **MARGEM** = `VENDA − CUSTO`. Faltando custo ou venda: margem `null`, nota de margem `0` e um
  `WARNING` não fatal.
- **SCORE** = `NOTA_IDADE + NOTA_MARGEM`.

Parâmetros configuráveis (`decision_rules`): `age_days_per_point` (30), `age_max_points` (15),
`margin_per_point` (150), `margin_allows_negative` (sim). O módulo `src/domain/scoring.ts`
implementa e testa essas regras; a coluna `active` marca a política vigente.

## Ordem de prioridade dos aparelhos

1. **menor** quantidade total de peças necessárias;
2. **maior** score;
3. **maior** margem;
4. **ID estável** como desempate determinístico.

A idade bruta não é reutilizada depois do score (já está embutida na nota de idade).

## Motor de distribuição (próxima fase — ainda não executado)

**1ª passagem** — atender apenas aparelhos que recebem o **kit completo**: reservar todas as
peças ou nenhuma; linhas atendidas viram `MATCH`.

**2ª passagem** — usar o saldo restante nos aparelhos incompletos:
- peça disponível → `MATCH PARCIAL`;
- peça que **nunca** teve estoque → `PEDIR PEÇA`;
- peça cujo estoque **existia** mas foi consumido por prioridade → `SEM SALDO`;
- chave inválida → `VERIFICAR`.

A ordem de consumo é calculada por `CHAVEPECA` e **reinicia em 1** para cada peça diferente.
Quando um aparelho tem só parte das peças, a peça disponível **não é reservada** antes de
verificar se os próximos da fila podem ser atendidos — só fica com ele se ninguém mais precisar.

Os resultados serão gravados em `match_runs`/`match_results`, e as transições de status
permanente em `operational_events`, sempre respeitando os status permanentes já existentes.

## Ocorrências fatais vs. não fatais (importação)

A confirmação (`POST /api/importar/confirmar`) só é permitida quando não há **ocorrência
estrutural fatal**. A prévia (`POST /api/importar/preview`) sempre é exibida — mesmo com
fatais — mas retorna `canConfirm: false` e `fatalIssuesCount > 0`; o backend recalcula essas
condições de novo na própria confirmação (não confia só no frontend).

**Fatais (bloqueiam, HTTP 422):** `MISSING_ORDERS_TABLE`, `MISSING_INVENTORY_TABLE`,
`MISSING_REQUIRED_COLUMNS`, `NO_VALID_ORDERS` (zero pedidos válidos — mesmo que existam
linhas não-vazias, todas rejeitadas), `NO_VALID_INVENTORY` (zero unidades válidas),
`REFERENCE_KEY_CONFLICT`, `FILE_UNREADABLE` (arquivo ilegível/ausente/formato inválido).

**Não fatais (permitem importar):** erro de linha individual (`MISSING_ID_PEDIDO`,
`DUPLICATE_ID_PEDIDO`, `DUPLICATE_ID_PECA_ESTOQUE` — a linha problemática é rejeitada, mas o
resto importa), `CHAVEPECA_VAZIA`, `INVENTORY_CHAVEPECA_EMPTY`, `MISSING_ID_PECA_ESTOQUE`,
`INVENTORY_ID_COLUMN_MISSING`, `FORMULA_ERROR`, `STATUS_CONFLICT` (conflito de status entre
`PEDIDOS.xlsx` e `ANALISE MI.xlsx`).

Contadores independentes em `import_batches`: `warnings_count`, `errors_count`,
`conflicts_count`. Qualquer warning, erro não fatal ou conflito resulta em
`COMPLETED_WITH_WARNINGS`; nenhuma ocorrência resulta em `COMPLETED`; falha de transação
resulta em `FAILED`. Erros fatais nunca chegam a gravar — a confirmação é rejeitada antes de
abrir a transação.

## Bipagem operacional e snapshot oficial de estoque

Contagem física diária via leitor de código de barras. **1 beep = 1 unidade**; 10 beeps da
mesma referência = 10 unidades. Beeps repetidos são **intencionais** e nunca deduplicados.

### Sessões

- Para criar: precisa de um lote de importação `COMPLETED`/`COMPLETED_WITH_WARNINGS` (vira o
  catálogo da sessão) e `responsibleName` não vazio.
- **No máximo uma sessão `OPEN`** no sistema — garantido por índice único parcial no banco, não
  só na aplicação. Tentar criar uma 2ª retorna **HTTP 409** com o `sessionId` da existente.
- Cancelar uma sessão `OPEN` exige responsável + motivo; mantém todos os scans para auditoria;
  **não cria snapshot** e não altera o estoque oficial anterior.

### Classificação da referência bipada (`src/domain/reference-catalog.ts`)

Ordem de resolução — nunca silenciosa:

1. mapeamento manual **ativo** (`reference_mappings`) → `RECOGNIZED`;
2. referência ausente do catálogo do lote → `UNKNOWN_REFERENCE`;
3. referência no catálogo, mas nenhuma linha tem `CHAVEPECA` → `MISSING_KEY`;
4. referência no catálogo com **exatamente uma** `CHAVEPECA` distinta → `RECOGNIZED`;
5. referência no catálogo com **duas ou mais** `CHAVEPECA` distintas → `CONFLICT` (nunca
   resolvido por `MAX`/`MIN`/primeira linha — fica pendente até resolução manual).

O `mapping_status` gravado no `count_scans` é o que foi detectado **no momento do beep**; um
mapeamento manual posterior não o reescreve — a resolução efetiva é recalculada **ao vivo**
(pendências, resumo, finalização) cruzando sempre com `reference_mappings` primeiro.

### Pendências

Scans ativos cujo status efetivo não é `RECOGNIZED`. Duas ações por referência pendente:
**vincular CHAVEPECA** (cria/atualiza `reference_mappings`, resolve todos os scans ativos
daquela referência de uma vez) ou **cancelar todos os beeps** (exige responsável + motivo;
marca cada scan como cancelado, nunca exclui).

### Bloqueadores de finalização

**Absolutos (nunca bypassáveis, nem com força):**
- zero beeps ativos na sessão (`EMPTY_SESSION`);
- qualquer beep ativo `UNKNOWN_REFERENCE`, `MISSING_KEY` ou `CONFLICT` (efetivo, recalculado);
- sessão não está `OPEN`;
- sessão sem lote de importação vinculado.

**Proteção contra contagem incompleta (bypassável com força):** se `beeps ativos / unidades do
estoque legado do lote` for menor que `COUNT_MIN_COMPLETENESS_RATIO` (padrão `0.80`), gera
warning `COUNT_BELOW_BASELINE_THRESHOLD` e bloqueia a finalização normal. Só finaliza com
`forceIncomplete=true` + responsável + justificativa de **pelo menos 10 caracteres**. Uma
contagem **vazia nunca pode ser forçada** (cai no bloqueador absoluto `EMPTY_SESSION` primeiro).
Uma contagem **acima** do legado finaliza normalmente — a diferença só fica registrada no
resumo/snapshot, não bloqueia.

**Movimentações durante a contagem (bypassável com força):** a sessão congela a base
operacional (`baseline_*`) no momento da criação. Se um recebimento (ou outra movimentação)
ocorrer depois, com `id` de `stock_movements` maior que o corte congelado, gera warning
`STOCK_MOVEMENTS_DURING_COUNT` e bloqueia a finalização normal — a mesma exigência de
`forceIncomplete=true` + responsável + justificativa ≥10 caracteres se aplica. O novo snapshot,
ao finalizar, absorve essas movimentações (`baseline_movement_id_max` do snapshot = maior id de
movimentação no momento do commit), evitando que sejam contadas de novo depois.

### Finalização (transacional)

Dentro de uma única transação: relê a sessão, confirma `OPEN`, recalcula todos os bloqueadores
no backend (nunca confia no resumo calculado antes), consolida os scans ativos agrupando por
`reference_norm` — a chave efetiva é recalculada **uma vez por referência** e todos os beeps
ativos daquela referência são somados num único item (corrige a fragmentação que perdia
unidades quando havia beeps antes e depois de uma resolução manual) —, valida
`SUM(stock_snapshot_items.counted_quantity) == stock_snapshots.total_units == beeps ativos
reconhecidos` antes do commit (diverge → rollback), cria `stock_snapshots` +
`stock_snapshot_items`, marca a sessão `FINALIZED`. Qualquer falha faz **rollback completo** —
sessão continua `OPEN`, nenhum snapshot é criado, o snapshot oficial anterior (de outra sessão)
permanece intacto. Finalizar uma sessão já `FINALIZED` é **idempotente**: devolve o snapshot
existente, não cria outro. A resposta reflete o resumo calculado **antes do commit** (nunca um
falso `SESSION_NOT_OPEN`/`canFinalize=false` pós-commit). A bipagem **nunca cria
`match_runs`/`match_results`** — isso é da próxima fase.

### Imutabilidade pós-finalização/cancelamento

Sessão `FINALIZED` ou `CANCELLED`: qualquer scan, cancelamento, resolução manual ou
cancelamento em massa retorna **HTTP 409**. Só sessões `OPEN` aceitam mutação.

### Estoque oficial e estoque operacional

`stock_snapshot` = **estoque oficial** da última contagem finalizada (entre todas as sessões).
`/api/estoque` (e a tela `/estoque`) mostram, além disso, o **estoque operacional atual** =
estoque oficial (ou legado importado, antes da 1ª contagem) + movimentações posteriores (ex.:
recebimentos confirmados) — ver `getCurrentOperationalStock()` em
[modelo-dados.md](modelo-dados.md). O comparativo da bipagem usa sempre a base (lote/snapshot)
que originou a sessão, nunca uma importação/base mais recente.

## Importação como inicialização única

A importação Excel só é usada para **inicializar** o sistema (ver
[importacao-legado.md](importacao-legado.md)). A primeira importação confirmada cria as
`purchase_requests` aprovadas a partir de `source_quotations` cujo status normalizado é
`APROVADO`/`APROVADA` (normalização centralizada em `src/domain/procurement.ts` — nenhuma
inferência por substring genérica). Depois disso, novas importações são bloqueadas (HTTP 409),
salvo `ALLOW_LEGACY_REIMPORT=true` (só dev/teste).

## Pedidos de compra e recebimento

- Pedido de compra (`purchase_orders`) recebe número `PC-AAAAMMDD-NNNN`, gerado
  transacionalmente (sem duplicidade). Itens vêm de solicitações aprovadas; quantidade deve ser
  inteira e positiva.
- Cancelar um pedido preserva histórico (nunca exclui); um pedido `RECEIVED` não pode ser
  cancelado; um pedido `CANCELLED` não pode receber.
- Recebimento (`goods_receipts`/`goods_receipt_items`) permite quantidade **parcial**; múltiplos
  recebimentos no mesmo pedido somam ao `quantity_received` de cada item. Quando todos os itens
  atingem a quantidade pedida, o pedido vira `RECEIVED`.
- Recebimento **acima** do saldo pedido é bloqueado por padrão; só é aceito com
  `allowOverReceipt=true` + responsável + justificativa ≥10 caracteres.
- A CHAVEPECA de cada item recebido é validada contra o catálogo operacional; chave fora do
  catálogo bloqueia a confirmação (HTTP 422).
- Cada item recebido cria **exatamente uma** movimentação positiva em `stock_movements`
  (`UNIQUE(source_type, source_id)` — confirmar a mesma requisição de novo nunca duplica).
  Tudo roda em uma única transação; falha em qualquer etapa faz rollback completo (nenhuma
  peça entra no estoque, pedido permanece como estava).
Grupos sem `CHAVEPECA` nunca aparecem como mapeados, nos dois casos.
