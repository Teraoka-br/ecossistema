# CLAUDE.md — Sistema de Peças (Outlet do Celular)

## O que é este projeto

Sistema web interno que substitui gradualmente as planilhas Excel (`PEDIDOS.xlsx`,
`ANALISE MI.xlsx`) usadas para controlar pedidos de peças, estoque e priorização de reparo de
celulares na outlet. A função-alvo (fase futura) é encontrar **MATCHs**: conectar peças em
estoque a aparelhos que precisam delas. **Fase atual: importação do legado como inicialização
única, bipagem operacional, solicitações de compra aprovadas, pedidos de compra, recebimento e
estoque operacional (base oficial + movimentações), todos implementados. O motor de match
ainda não existe.**

## Seu papel

Você é o agente responsável por implementar e manter este sistema. Antes de qualquer
alteração não trivial, **leia [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)** — ele tem o
estado real e atual do domínio, arquitetura, decisões definitivas e pendências. Não confie
apenas na memória da conversa.

## Stack real

Node.js 22.5+ (ambiente: Node 24 LTS) · TypeScript estrito · React 18 + Vite 6 · Express 4 ·
`node:sqlite` (via `createRequire`) · Zod · `xlsx` 0.18.5 · Vitest 2. Um único `package.json`.

## Regras de trabalho

- **Não reconstrua o projeto.** Preserve a arquitetura, as migrations já aplicadas, os dados
  e os recursos existentes. Migrations são **incrementais e versionadas**
  (`src/db/migrations/NNN_*.sql`) — nunca edite silenciosamente uma migration já existente;
  crie uma nova.
- **Regras de negócio ficam no backend/domínio** (`src/domain`, `src/import`, `src/db`).
  O frontend (`src/client`) só exibe e nunca decide — nunca implemente validação de negócio
  apenas no cliente.
- **Excel não é banco operacional.** É só fonte de importação/contingência. SQLite
  (`data/app.sqlite`) é a fonte de verdade. Nunca altere os arquivos `.xlsx` enviados pelo
  usuário.
- **Identidade do domínio:** `ID_PEDIDO` identifica a solicitação de uma peça (única por
  linha); `IMEI` agrupa o aparelho/kit. Nunca volte a tratar `ID_PEDIDO` como identidade do
  aparelho ou misture isso com `CHAVEPECA`. Número de linha **nunca** é identidade permanente.
- **Estoque oficial = último `stock_snapshot` com status `OFFICIAL`** (de qualquer sessão de
  contagem finalizada), não o `source_inventory_items` importado. `source_inventory_items`
  nunca é apagado nem modificado pela bipagem — é só a base de comparação ("legado").
- **Estoque operacional = base oficial + movimentações posteriores ao corte** (nunca por
  timestamp — sempre por id de `stock_movements`, para não contar a mesma movimentação duas
  vezes). Veja `src/operational/stock-service.ts::getCurrentOperationalStock`.
- **A importação Excel só inicializa o sistema** (`system_state.initialized`). Depois disso,
  novas importações são bloqueadas por padrão (`ALLOW_LEGACY_REIMPORT=true` só em dev/teste) —
  não reative isso no beta normal nem trate um lote importado mais recente como fonte
  operacional mutável.
- **Scans (`count_scans`) nunca são apagados nem mutados quanto ao `mapping_status` histórico**
  — cancelamento só preenche `cancelled_at/by/reason`. A resolução manual de uma referência
  (`reference_mappings`) é recalculada *ao vivo* em cada leitura (pendências, resumo,
  finalização) — nunca reescreve o `mapping_status` gravado no scan no momento do beep.
- Antes de migrations destrutivas contra `data/app.sqlite`, garanta que o backup automático
  (`src/db/migrate.ts`) rodou — ele já faz `PRAGMA wal_checkpoint(TRUNCATE)` antes de copiar.
- **Após qualquer mudança de código**, rode `npm test`, `npm run typecheck` e
  `npm run build` antes de considerar a tarefa concluída. Não ignore falhas.
- **Atualize [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)** depois de tarefas
  relevantes (não a cada commit pequeno) — mantenha estado atual, não diário completo; no
  máximo as últimas cinco mudanças relevantes na seção de pendências.
- **Não implemente o motor de match** a menos que explicitamente solicitado — é a próxima
  fase, documentada em `docs/PROJECT_CONTEXT.md` §11. A bipagem já está implementada; não a
  reconstrua nem mude suas regras de bloqueio (`canFinalize`/`blockers`) sem pedido explícito.

## Estilo de resposta

- Respostas finais **curtas e objetivas**: o que mudou, resultado de testes/build, próximo
  passo. Sem retrospectiva longa.
- **Não cole logs extensos, prompts do usuário ou arquivos de código inteiros** em
  `docs/PROJECT_CONTEXT.md` ou em outros documentos de contexto — resuma comportamento e
  responsabilidade, não implementação linha a linha.
