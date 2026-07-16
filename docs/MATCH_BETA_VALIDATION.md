# Validação do motor único de match — cópia do banco beta

> Gerado em 2026-07-16T17:17:37.037Z sobre `data/app-beta-copy.sqlite` (o beta real não foi tocado).

## 1. Estado atual (antes do novo motor)

- Regra ativa: **Regra v1** (id 1, versão 1) — R$ 150/pt, 30 dias/pt, teto 15, pesos 1/1, margem negativa pune
- Cards por workflow_status:
  - PEDIR_PECA: 582
  - EM_ANALISE: 493
  - CONCLUIDO: 238
  - DIRECIONADO_TECNICO: 206
  - MATCH_PARCIAL: 24
  - VERIFICAR: 23
  - MATCH: 10
  - EM_SEPARACAO: 2
  - VENDA_ESTADO: 1
- Cards elegíveis p/ motor (analysis COMPLETED, fora de estados travados): 713
- Desses, sem custo: 8, sem venda: 13, sem idade: 1
- Sem depósito: 37, depósito fora do fluxo: 35

## 2. Novo motor executado na cópia (regra ativa Regra v1)

- Run #179 em 291 ms
- Cards avaliados: 713
- MATCH: 11 · MATCH_PARCIAL: 24 · VERIFICAR: 106
- Resultado canônico por card:
  - PEDIR_PECA: 572
  - VERIFICAR: 106
  - MATCH_PARCIAL: 24
  - MATCH: 11
- Workflows alterados: 105
- Entraram em MATCH: 1 (#1079)
- Saíram de MATCH: 0
- Motivos de VERIFICAR (um card pode ter vários):
  - PECA_NECESSARIA_AUSENTE: 52
  - DEPOSITO_NAO_IDENTIFICADO: 37
  - DEPOSITO_FORA_DO_FLUXO: 35
  - VENDA_ESTIMADA_AUSENTE: 13
  - CUSTO_AUSENTE: 8
  - IDADE_AUSENTE: 1

- Idempotência: segunda execução alterou 0 workflow(s) (esperado 0) e repetiu MATCH=11, PARCIAL=24, VERIFICAR=106

- Referências mais disputadas (demanda > disponível): 533
  - BATERIA IPHONE 11: 29 pedem / 0 disponível
  - BATERIA IPHONE 12: 29 pedem / 0 disponível
  - BATERIA 11: 18 pedem / 0 disponível
  - FRONTAL IPHONE 11: 18 pedem / 0 disponível
  - FRONTAL IPHONE 12: 15 pedem / 0 disponível
  - FRONTAL GALAXY A14 5G: 10 pedem / 0 disponível
  - FRONTAL IPHONE 13: 9 pedem / 0 disponível
  - TAMPA TRASEIRA GALAXY A14 5G PRETO: 8 pedem / 0 disponível
  - FRONTAL COM ARO GALAXY A53 5G PRETO: 7 pedem / 0 disponível
  - BATERIA GALAXY S22: 7 pedem / 1 disponível

### Top 30 cards por score (regra ativa)

| # | Caso | Resultado | Margem | Pts margem | Pts idade | Score |
|---|------|-----------|--------|-----------|-----------|-------|
| 1 | #984 | PEDIR_PECA | 1599.00 | 10.660 | 15.000 | 25.660 |
| 2 | #212 | PEDIR_PECA | 3033.00 | 20.220 | 4.333 | 24.553 |
| 3 | #670 | PEDIR_PECA | 1386.00 | 9.240 | 13.667 | 22.907 |
| 4 | #692 | PEDIR_PECA | 2978.00 | 19.853 | 1.567 | 21.420 |
| 5 | #17 | PEDIR_PECA | 2246.00 | 14.973 | 4.800 | 19.773 |
| 6 | #529 | PEDIR_PECA | 699.00 | 4.660 | 15.000 | 19.660 |
| 7 | #145 | PEDIR_PECA | 698.00 | 4.653 | 15.000 | 19.653 |
| 8 | #288 | PEDIR_PECA | 1074.97 | 7.166 | 12.333 | 19.500 |
| 9 | #531 | PEDIR_PECA | 1503.00 | 10.020 | 9.367 | 19.387 |
| 10 | #287 | PEDIR_PECA | 654.00 | 4.360 | 15.000 | 19.360 |
| 11 | #477 | PEDIR_PECA | 1850.00 | 12.333 | 6.567 | 18.900 |
| 12 | #1093 | PEDIR_PECA | 735.00 | 4.900 | 13.700 | 18.600 |
| 13 | #173 | PEDIR_PECA | 499.00 | 3.327 | 15.000 | 18.327 |
| 14 | #623 | PEDIR_PECA | 489.00 | 3.260 | 15.000 | 18.260 |
| 15 | #992 | PEDIR_PECA | 469.00 | 3.127 | 15.000 | 18.127 |
| 16 | #214 | PEDIR_PECA | 2219.00 | 14.793 | 3.267 | 18.060 |
| 17 | #639 | PEDIR_PECA | 1979.00 | 13.193 | 4.800 | 17.993 |
| 18 | #664 | PEDIR_PECA | 432.00 | 2.880 | 15.000 | 17.880 |
| 19 | #168 | PEDIR_PECA | 427.00 | 2.847 | 15.000 | 17.847 |
| 20 | #1078 | PEDIR_PECA | 420.00 | 2.800 | 15.000 | 17.800 |
| 21 | #852 | PEDIR_PECA | 419.00 | 2.793 | 15.000 | 17.793 |
| 22 | #668 | PEDIR_PECA | 416.00 | 2.773 | 15.000 | 17.773 |
| 23 | #306 | PEDIR_PECA | 2334.50 | 15.563 | 2.067 | 17.630 |
| 24 | #307 | PEDIR_PECA | 2334.50 | 15.563 | 2.067 | 17.630 |
| 25 | #309 | PEDIR_PECA | 2334.50 | 15.563 | 2.067 | 17.630 |
| 26 | #881 | PEDIR_PECA | 389.00 | 2.593 | 15.000 | 17.593 |
| 27 | #878 | MATCH | 369.00 | 2.460 | 15.000 | 17.460 |
| 28 | #741 | PEDIR_PECA | 369.00 | 2.460 | 15.000 | 17.460 |
| 29 | #686 | PEDIR_PECA | 364.00 | 2.427 | 15.000 | 17.427 |
| 30 | #1054 | PEDIR_PECA | 349.00 | 2.327 | 15.000 | 17.327 |

## 3. Regra 1 da especificação (150/30, pesos 1/1, teto 12) — simulação

- MATCH: 11 · PARCIAL: 24 · PEDIR_PEÇA: 572 · AGUARDANDO: 0 · VERIFICAR: 106
- Cards que mudariam vs. regra ativa: 0 (MATCH completo: 0, parcial: 0, posição: 366)

## 4. Regra com foco em margem (100/pt, 60 dias/pt, pesos 2/0,5, teto 12) — simulação

- MATCH: 11 · PARCIAL: 24 · PEDIR_PEÇA: 572 · AGUARDANDO: 0 · VERIFICAR: 106
- Cards que mudariam vs. regra ativa: 2 (MATCH completo: 2, parcial: 0, posição: 604)
- Ganhariam prioridade (entram em MATCH): #604
- Perderiam (saem de MATCH): #965
- Top mudanças por score:
  - #604: PEDIR_PECA → MATCH (score 8.80 → 24.02)
  - #965: MATCH → PEDIR_PECA (score 10.16 → 20.41)

## 5. Regra com foco em aging (300/pt, 15 dias/pt, pesos 0,5/2, teto 12) — simulação

- MATCH: 11 · PARCIAL: 24 · PEDIR_PEÇA: 572 · AGUARDANDO: 0 · VERIFICAR: 106
- Cards que mudariam vs. regra ativa: 6 (MATCH completo: 2, parcial: 4, posição: 600)
- Ganhariam prioridade (entram em MATCH): #957
- Perderiam (saem de MATCH): #965
- Top mudanças por score:
  - #2: PEDIR_PECA → MATCH_PARCIAL (score 8.09 → 15.65)
  - #228: MATCH_PARCIAL → PEDIR_PECA (score 9.34 → 15.21)
  - #835: PEDIR_PECA → MATCH_PARCIAL (score 7.66 → 18.16)
  - #904: MATCH_PARCIAL → PEDIR_PECA (score 8.85 → 12.09)
  - #957: PEDIR_PECA → MATCH (score 9.67 → 20.54)
  - #965: MATCH → PEDIR_PECA (score 10.16 → 16.29)

## 6. Simulação da regra ativa × motor real

- Simulação (mesma função pura): MATCH=11, PARCIAL=24, VERIFICAR=106
- Motor real (última run): MATCH=11, PARCIAL=24, VERIFICAR=106
- **IDÊNTICOS ✓**

> As regras "Regra 1 (spec)", "Foco em margem" e "Foco em aging" foram criadas apenas como RASCUNHO nesta cópia para simulação — nada foi ativado, e o banco beta real não foi alterado.
