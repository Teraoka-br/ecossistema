# Importação do legado

A importação lê os dois arquivos **no servidor** (nunca os altera) e ocorre em duas etapas:
**pré-visualização** (valida e conta, sem gravar) e **confirmação** (grava em transação).

## Detecção por conteúdo (não por posição)

As abas são localizadas pelo **conteúdo dos cabeçalhos**, normalizados (sem acento, caixa alta,
espaços/`_` colapsados). Para cada aba acha-se a linha de cabeçalho que casa mais colunas
conhecidas e classifica-se o papel quando os campos obrigatórios estão presentes:

| Papel        | Origem típica                | Cabeçalhos obrigatórios                          |
| ------------ | ---------------------------- | ------------------------------------------------ |
| `ORDERS`     | `PEDIDOS.xlsx` → `PEDIDOS`   | ID PEDIDO, IMEI, STATUS, CHAVEPEÇA, STATUS KIT   |
| `INVENTORY`  | `PEDIDOS.xlsx` → `BIPAGEM DE PEÇAS` | REFERENCIA, CHAVEPECA                      |
| `QUOTATIONS` | `ANALISE MI.xlsx` → `PEÇAS A PEDIR` | CHAVEPEÇA, VALOR UN, VALOR TOTAL, DATA COTAÇÃO |
| `ANALYSIS`   | `ANALISE MI.xlsx` → `ANALISEMI` | IMEI, MARCA, MODELO, PEÇASOLICITADA, ID PEDIDO |

A seleção é robusta a troca de arquivo/posição: o estoque prefere a aba **por unidade** (sem
coluna `QTDE`) e nome "BIPAG"; os pedidos preferem o mesmo arquivo do estoque (precedência de
`PEDIDOS.xlsx`); abas pesadas como `His Estoque` (centenas de milhares de linhas) **não são
carregadas** (leitura seletiva via opção `sheets` da biblioteca xlsx).

## Precedência entre arquivos

- `PEDIDOS.xlsx` prevalece para status, kit, prioridade, ordem, estoque e match.
- `ANALISE MI.xlsx` prevalece para origem analítica e cotações.
- **Conflitos não são sobrescritos em silêncio**: divergência de status do mesmo `ID_PEDIDO`
  entre os dois arquivos vira uma ocorrência `CONFLICT` (`STATUS_CONFLICT`) exibida no
  Diagnóstico. Conflito de status **não é fatal** — não bloqueia a confirmação.

## Identidade e duplicidade

- **`ID_PEDIDO`** é a identidade única da solicitação de uma peça: **uma linha = um
  `ID_PEDIDO`**, sempre, sem exceção. Repetir o mesmo `ID_PEDIDO` no mesmo snapshot é erro de
  preenchimento → `DUPLICATE_ID_PEDIDO` (a linha repetida não é importada, mas fica listada).
- **`IMEI`** identifica o **aparelho/kit**. Várias linhas com o mesmo IMEI (e `ID_PEDIDO`
  diferentes) são várias peças do mesmo aparelho — isso **não** é duplicidade; é o caso
  normal e esperado de um aparelho que precisa de mais de uma peça. O agrupamento por IMEI é
  feito na camada de consulta (`/pedidos`), nunca na identidade gravada.
- **`OS`** é apenas contexto/validação. Quando o mesmo IMEI aparece com OS diferentes entre
  suas linhas, isso é sinalizado na tela `/pedidos` como inconsistência a verificar — não é
  bloqueante.
- **Estoque**: cada linha é uma unidade. Sem coluna de ID nos arquivos atuais — o que importa é
  a **contagem por referência**, então não exigimos ID único. Se a coluna de ID existir
  (`IDPEÇA`/`ID PEÇA`/`ID_PECA_ESTOQUE`), ela é preservada e IDs repetidos viram
  `DUPLICATE_ID_PECA_ESTOQUE`; uma linha com a coluna presente mas vazia gera
  `MISSING_ID_PECA_ESTOQUE` (warning por linha). Se a coluna inteira estiver ausente, gera um
  único warning `INVENTORY_ID_COLUMN_MISSING` com o total de unidades sem ID físico. Se houver
  coluna `QTDE` (aba de contagem consolidada), a unidade é expandida em N linhas para manter
  "uma linha por unidade".
- **CHAVEPECA vazia no estoque**: a unidade é importada, mas gera `INVENTORY_CHAVEPECA_EMPTY`
  (warning, `entity_key` = referência) — ela não poderá alimentar o futuro motor de match
  enquanto não for corrigida.
- **Conflito referência → chave**: se a mesma `REFERENCIA` normalizada aparecer vinculada a
  duas ou mais `CHAVEPECA` normalizadas diferentes, é `REFERENCE_KEY_CONFLICT` — um erro
  **estrutural fatal** que bloqueia a confirmação (a tela de estoque nunca escolhe uma chave
  arbitrariamente para escondê-lo).

## Erros de fórmula e campos vazios

- Erro de fórmula (`#N/A`, `#N/D`, `#VALUE!`, ...) em **campo opcional** → vira `null` +
  `WARNING` (`FORMULA_ERROR`); a linha é importada.
- Campo **obrigatório** ausente (ex.: pedido sem `ID PEDIDO`) → `ERROR` (`MISSING_ID_PEDIDO`);
  a linha não é importada, mas permanece no relatório.
- `CHAVEPEÇA` vazia → `WARNING` (`CHAVEPECA_VAZIA`); a linha é importada.

## Idempotência e transação

- Os **hashes** dos dois arquivos identificam a importação. Reimportar arquivos idênticos é um
  **no-op**: a confirmação reaproveita o lote concluído e não duplica nada.
- A confirmação roda em **transação**: qualquer falha faz `ROLLBACK` completo do snapshot e o
  lote fica `FAILED`. Eventos operacionais e bipagens **não** são tocados pela importação.

## Estado inicial

Os pedidos entram com o status atual das planilhas. `CONCLUIDO`, `SEPARADO` e `CANCELADO`
(reconhecidos mesmo com acento, ex.: `CONCLUÍDO`) são preservados e marcados como permanentes —
nenhum recálculo futuro pode apagá-los.

## Importação como inicialização única

**A importação Excel é executada apenas para inicializar o sistema.** A primeira importação
confirmada, além do snapshot `source_*` de sempre:

1. fixa `system_state.initial_import_batch_id` e marca `initialized=1`;
2. cria `purchase_requests` **aprovadas** a partir de `source_quotations` cujo status
   normalizado seja `APROVADO`/`APROVADA` (normalização centralizada em
   `src/domain/procurement.ts` — nunca por substring genérica; nos arquivos reais auditados os
   status observados na aba `PEÇAS A PEDIR` são `COTANDO`, `APROVADO` e vazio).

Tudo dentro da mesma transação da confirmação; idempotente (chamar de novo sobre um sistema já
inicializado não faz nada). **Depois disso, o sistema é a fonte operacional oficial**: novas
importações são bloqueadas (HTTP 409) — pedidos de compra, recebimentos, contagens e correções
de referência passam a acontecer dentro do sistema, nunca via nova importação. Reimportar exige
`ALLOW_LEGACY_REIMPORT=true` (só dev/teste); `source_*` seguem intactas como fotografia
imutável da carga inicial.
