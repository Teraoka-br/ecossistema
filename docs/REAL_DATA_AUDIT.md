# Auditoria com dados reais

> Gerado por `npm run audit:real` em 2026-07-01T15:12:03.604Z. Os números abaixo são uma
> fotografia dos arquivos informados nesta execução — **não são constantes de código** e não
> devem ser copiados para o código-fonte. Reexecute para uma operação viva.

## Arquivos auditados

| | PEDIDOS | ANALISE MI |
| --- | --- | --- |
| Caminho | `G:\Meu Drive\ECOSSISTEMA PEDIDO DE PEÇAS\PEDIDOS.xlsx` | `G:\Meu Drive\ECOSSISTEMA PEDIDO DE PEÇAS\ANALISE MI.xlsx` |
| Tamanho | 59.74 MB (62.640.734 bytes) | 65.75 MB (68.946.634 bytes) |
| Modificado em | 2026-06-30T15:19:03.785Z | 2026-06-30T12:00:18.138Z |
| SHA-256 | `2ad18428439a92cc06d761d401537aae82c43559f4a00c592c2aa9868c8ac6f2` | `d6e3c2b4db8f9c7318b6469c89fa380c616cbe10c16797dd112f0b4f3180cb03` |

## Tabelas escolhidas (detecção por cabeçalho)

**PEDIDOS.xlsx** (abas: His Estoque, PEDIDOS, TABELA DE AVALIAÇÃO  (PEACS), DEMONSTRATIVO DE SALDO, BIPAGEM DE PEÇAS, CONTAGEM DE PEÇAS)

| Papel | Aba | Linha cabeçalho | Campos casados |
| --- | --- | ---: | --- |
| ORDERS | PEDIDOS | 1 | idPedido, imei, os, concatPeca, status, refPeca, qtdePecas, idade, custo, venda, margem, chavePeca, notaIdade, notaMargem, score, ordemConsumo, qtdEstoque, pecasSemEstoque, statusKit, prioridadeKit |
| INVENTORY | BIPAGEM DE PEÇAS | 1 | referencia, descricao, fornecedor, chavePeca, status, arrumar |
| INVENTORY | CONTAGEM DE PEÇAS | 1 | referencia, descricao, fornecedor, chavePeca, status, arrumar, qtde |

**ANALISE MI.xlsx** (abas: His Estoque, TODOS, COM SALDO, ANALISEMI, SH, ANALISE, PEDIDOS FULL, PEÇAS A PEDIR, PEDIDOS)

| Papel | Aba | Linha cabeçalho | Campos casados |
| --- | --- | ---: | --- |
| ANALYSIS | ANALISEMI | 1 | imei, os, marca, modelo, cor, pecaSolicitada, corNaPeca, dataPedido, status, concatPeca, deposito, descricao, ref, idPedido, solicitante |
| ANALYSIS | ANALISE | 1 | imei, os, marca, modelo, cor, pecaSolicitada, corNaPeca, dataPedido, status, concatPeca, deposito, descricao, ref, idPedido, solicitante |
| ORDERS | PEDIDOS FULL | 1 | idPedido, imei, os, concatPeca, status, refPeca, qtdePecas, idade, custo, venda, margem, chavePeca, notaIdade, notaMargem, score, ordemConsumo, qtdEstoque, pecasSemEstoque, statusKit, prioridadeKit |
| QUOTATIONS | PEÇAS A PEDIR | 1 | idPedido, chavePeca, quantidade, valorUnitario, valorTotal, dataCotacao, status |
| ORDERS | PEDIDOS | 1 | idPedido, imei, os, concatPeca, status, refPeca, qtdePecas, idade, custo, venda, margem, chavePeca, notaIdade, notaMargem, score, ordemConsumo, qtdEstoque, pecasSemEstoque, statusKit, prioridadeKit |


## Duração da leitura (prévia)

`22357 ms` (detecção em etapas + mapeamento completo dos dois arquivos).

## Totais

| Métrica | Encontrado | Válido | Persistido |
| --- | ---: | ---: | ---: |
| Pedidos | 1387 | 1387 | 1387 |
| Estoque (unidades) | 791 | 791 | 791 |
| Cotações | 618 | 618 | 618 |
| Análise (linhas) | 1387 | 1387 | 1387 |

Status final do lote: `COMPLETED_WITH_WARNINGS` (lote #1).

## Status por origem (pedidos)

**PEDIDOS.xlsx** (fonte primária — aba `PEDIDOS`):

| Código | Quantidade |
| --- | ---: |
| `PEDIR PECA` | 985 |
| `CONCLUIDO` | 295 |
| `SEM SALDO` | 72 |
| `VERIFICAR` | 25 |
| `MATCH PARCIAL` | 9 |
| `MATCH` | 1 |


**ANALISE MI.xlsx** (fonte secundária — aba `PEDIDOS`):

| Código | Quantidade |
| --- | ---: |
| `PEDIR PECA` | 948 |
| `SEM SALDO` | 113 |


## Concluídos

| Onde | Quantidade |
| --- | ---: |
| CONCLUIDO no PEDIDOS (fonte primária) | 295 |
| CONCLUIDO no ANALISE MI (fonte secundária) | 0 |
| CONCLUIDO persistido (snapshot gravado) | 295 |

Amostra completa em `audit/concluded-sample.csv` (até 200 linhas).

## Warnings por código

| Código | Quantidade |
| --- | ---: |
| `INVENTORY_CHAVEPECA_EMPTY` | 52 |
| `FORMULA_ERROR` | 40 |
| `CHAVEPECA_VAZIA` | 25 |
| `INVENTORY_ID_COLUMN_MISSING` | 1 |


## Erros (não fatais, por linha) por código

_nenhum_


## Conflitos por código

| Código | Quantidade |
| --- | ---: |
| `STATUS_CONFLICT` | 68 |


Lista completa de conflitos de status em `audit/status-conflicts.csv`.

## Idempotência (segunda importação)

| Verificação | Resultado |
| --- | --- |
| `alreadyImported` na 2ª prévia | true |
| `alreadyImported` na 2ª confirmação | true |
| Mesmo `batchId` reaproveitado | true |
| Mesmos totais importados | true |
| **Idempotente** | **true** |

## Erros fatais

Nenhum — a importação foi confirmada normalmente.
