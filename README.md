# Sistema de Peças — Outlet do Celular

Sistema web interno para controlar **pedidos de peças, estoque (bipagem), priorização e
distribuição de peças** para reparo de celulares. Substitui gradualmente as planilhas Excel
atuais, usando-as apenas como fonte de importação inicial.

A importação Excel (`PEDIDOS.xlsx` e `ANALISE MI.xlsx`) é executada **apenas para inicializar o
sistema**: depois da primeira importação confirmada, o SQLite passa a ser a fonte operacional
oficial e novas importações ficam bloqueadas. O sistema já entrega: inicialização única,
**bipagem operacional** com snapshot oficial (tela `/bipagem`), **solicitações de compra
aprovadas → pedidos de compra → recebimento** (tela `/compras`) e **estoque operacional**
(base oficial + movimentações posteriores, tela `/estoque`). O **motor de match/distribuição**
ainda não existe — só o modelo de dados (`match_runs`/`match_results`) está preparado para ele.

## Requisitos

- **Node.js 22.5+** (usa o módulo nativo `node:sqlite`). Testado no Node 24 LTS.
- Não há dependências nativas para compilar.

## Comandos

```bash
# instalar
npm install

# testar
npm test

# compilar (servidor + frontend)
npm run build

# executar (desenvolvimento: API + Vite com hot reload)
npm run dev

# executar (produção: usa o build de dist/)
npm run build
npm start

# auditoria reproduzível com os dois arquivos reais (banco temporário, não toca data/app.sqlite)
npm run audit:real -- --orders "<caminho/PEDIDOS.xlsx>" --analysis "<caminho/ANALISE MI.xlsx>"
```

- Dev: frontend em `http://localhost:5173`, API em `http://localhost:3001` (proxy `/api`).
- Produção: o servidor serve a API **e** o frontend compilado, escutando por padrão em
  `127.0.0.1:3001` — **beta local, somente arquivos confiáveis** (sem autenticação ainda;
  veja [Limitações atuais](#limitações-atuais-fase-1)). Ajuste `SERVER_HOST` se precisar expor
  além do localhost, sob sua responsabilidade.
- O banco SQLite é criado automaticamente em `data/app.sqlite` e as migrations rodam no boot.
- Variáveis de ambiente opcionais: veja [.env.example](.env.example).

## Primeiro uso

1. Suba o sistema (`npm run dev`).
2. Acesse **Importar**, selecione `PEDIDOS.xlsx` e `ANALISE MI.xlsx`. **Esta é a única vez** —
   depois de confirmada, a tela fica somente leitura e a importação é bloqueada.
3. Confira a **pré-visualização** (abas detectadas, contagens, avisos/conflitos).
4. Clique em **Confirmar importação** — isso inicializa o sistema e cria as solicitações de
   compra a partir das cotações aprovadas.
5. Use **Pedidos**, **Compras**, **Estoque**, **Cotações** e **Diagnóstico**.
6. Acesse **Bipagem** para iniciar a contagem física diária do estoque (veja abaixo).

## Compras e recebimento

1. Em **Compras → APROVADOS**, selecione solicitações, defina a quantidade e clique em
   **GERAR PEDIDO**.
2. Em **AGUARDANDO RECEBIMENTO**, clique em **RECEBER** para confirmar as unidades chegadas
   (recebimento parcial é permitido; acima do saldo pedido exige justificativa).
3. Cada recebimento confirmado gera uma movimentação de estoque — o total em **Estoque**
   aumenta imediatamente, sem precisar de nova contagem.

## Bipagem (contagem física)

1. Em **Bipagem**, informe o responsável e clique em **Iniciar contagem** (usa o último lote
   importado como catálogo de referências).
2. Bipe as peças — cada beep é uma unidade; beeps repetidos são somados, nunca deduplicados.
3. Referências desconhecidas, sem `CHAVEPECA` no catálogo ou em conflito aparecem em
   **Pendências**: vincule manualmente a `CHAVEPECA` correta ou cancele os beeps daquela
   referência (sempre com responsável + justificativa).
4. Clique em **Revisar finalização** para ver totais, diferenças contra o legado e
   bloqueadores. Sem pendências e dentro do limite mínimo de cobertura
   (`COUNT_MIN_COMPLETENESS_RATIO`, padrão 80%), finalize normalmente; abaixo do limite, é
   preciso forçar com justificativa de ao menos 10 caracteres.
5. Ao finalizar, um **snapshot oficial** é criado — a tela `/estoque` passa a mostrar
   "CONTAGEM OFICIAL" em vez de "LEGADO IMPORTADO", com comparação contra o legado do lote.

## Estrutura

```
src/
  client/    # React + Vite (telas)
  server/    # Express (rotas, config)
  shared/    # tipos compartilhados client/server
  domain/    # regras puras: normalização, status, score, classificação de referência
  db/        # node:sqlite, migrations, repositório e queries (importação + bipagem)
  import/    # leitura xlsx, detecção por cabeçalho, mapeamento, importação
  counting/  # serviço de bipagem: sessões, scans, pendências, finalização
scripts/    # auditoria reproduzível (npm run audit:real)
tests/      # Vitest
docs/       # documentação
data/       # banco SQLite, backups e temporários (não versionado)
```

## Endpoints da API

| Método | Rota                       | Descrição                                  |
| ------ | -------------------------- | ------------------------------------------ |
| POST   | `/api/importar/preview`    | Etapa 1: valida e pré-visualiza (upload)   |
| POST   | `/api/importar/confirmar`  | Etapa 2: grava o snapshot (transação)      |
| GET    | `/api/diagnostico`         | Último lote: hashes, contagens, ocorrências|
| GET    | `/api/pedidos`             | Pedidos agrupados por aparelho (filtros)   |
| GET    | `/api/estoque`             | Estoque: legado importado e/ou oficial (snapshot) |
| GET    | `/api/cotacoes`            | Cotações existentes                        |
| GET    | `/api/health`              | Verificação de saúde                       |
| GET/POST | `/api/count-sessions*`   | Sessões de contagem (criar, cancelar, listar)  |
| POST   | `/api/count-sessions/:id/scans` | Registrar um beep                     |
| POST   | `/api/count-scans/:scanId/cancel` | Cancelar um beep (nunca exclui)     |
| GET    | `/api/count-sessions/:id/{summary,pending}` | Resumo de finalização e pendências |
| GET    | `/api/reference-catalog/keys` | Busca de CHAVEPECA do lote ativo       |
| POST   | `/api/count-sessions/:id/references/{resolve,cancel-scans}` | Resolver pendência |
| POST   | `/api/count-sessions/:id/finalize` | Finaliza e gera o snapshot oficial    |
| GET    | `/api/stock-snapshots/{latest,:id}` | Consultar snapshot oficial            |
| GET    | `/api/system/state`        | Estado de inicialização do sistema         |
| GET    | `/api/purchase-requests[/:id]` | Solicitações de compra aprovadas       |
| GET/POST | `/api/purchase-orders[/:id]` | Pedidos de compra (criar, listar)        |
| POST   | `/api/purchase-orders/:id/cancel` | Cancelar pedido de compra             |
| POST   | `/api/purchase-orders/:id/receipts/{preview,confirm}` | Recebimento (parcial permitido) |
| GET    | `/api/stock/current`       | Estoque operacional (base + movimentos + atual) |
| GET    | `/api/stock/movements`     | Livro-razão de movimentações (filtrável)   |

## Documentação

- [docs/modelo-dados.md](docs/modelo-dados.md) — tabelas e relacionamentos.
- [docs/importacao-legado.md](docs/importacao-legado.md) — como o legado é lido e mapeado.
- [docs/regras-negocio.md](docs/regras-negocio.md) — status, score e regras de decisão.
- [docs/REAL_DATA_AUDIT.md](docs/REAL_DATA_AUDIT.md) — última auditoria com dados reais
  (gerada por `npm run audit:real`; reexecute para uma fotografia atual).
- [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) — estado completo do projeto para quem
  for continuar o trabalho.

## Limitações atuais

- Sem autenticação e sem integração com Google Drive (propositais nesta fase). Por isso o
  servidor escuta só em `127.0.0.1` por padrão — **beta local, somente arquivos confiáveis**.
- Pedidos/Cotações/Diagnóstico são **somente leitura**; não há ações operacionais sobre pedidos
  (concluir/separar) ainda.
- O **motor de match/distribuição** não roda — apenas o modelo (`match_runs`/`match_results`)
  existe, vazio. A bipagem **nunca** cria registros nessas tabelas.
- A pré-visualização da importação guarda os arquivos em `data/tmp/batch-<id>` até a
  confirmação; se o servidor reiniciar entre as duas etapas, refaça a importação.
- Movimentações de estoque hoje só cobrem recebimento (`PURCHASE_RECEIPT`); os demais tipos
  (consumo por reparo, devolução, ajuste manual, descarte, transferência) estão preparados no
  esquema, sem fluxo de UI/API ainda.

## Sequência de fases

```text
Importação do legado (inicialização única, concluída)
  → solicitações aprovadas → pedidos de compra → recebimento (concluído)
    → bipagem operacional + snapshot oficial (concluído)
      → estoque operacional = base oficial + movimentações (concluído)
        → motor de match/distribuição usando o estoque operacional (próxima fase)
          → ações operacionais (concluir, separar, etc.)
```

## Próximo passo recomendado

**Motor de match usando o estoque operacional atual** (`match_runs`/`match_results`, regras
descritas em [docs/regras-negocio.md](docs/regras-negocio.md)) — consumindo
`getCurrentOperationalStock()` (base oficial + movimentações posteriores), não só o último
snapshot. Ainda não implementado; ver pendências em
[docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) §11.
