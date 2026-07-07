# Fluxo Operacional do Sistema de Peças

Este documento é a referência funcional principal do sistema.

## Objetivo

Cada card representa um aparelho que precisa ser finalizado.

O sistema deve reunir informações, executar o motor de match e mostrar ao João:

- o que falta para reparar o aparelho;
- o que pode ser feito agora;
- qual é a próxima ação recomendada.

O motor recomenda e recalcula.
O João confirma e executa as ações físicas.

## Fluxo completo

```mermaid
flowchart TD

    %% =========================================================
    %% FONTES DE DADOS
    %% =========================================================

    subgraph FONTES["1. Fontes de dados externas"]
        HIS["His Estoque<br/>Controle de Entrada Trade-In<br/><br/>Busca pelo IMEI<br/>Última ocorrência de baixo para cima<br/><br/>Fornece:<br/>Idade<br/>Custo"]

        SERIAIS["Relatório de Estoque de Seriais<br/><br/>Busca pelo IMEI<br/><br/>Fornece:<br/>Modelo padronizado<br/>Código comercial<br/>Depósito<br/>Filial<br/>Disponibilidade"]

        SH["SH - Ordens de Serviço<br/><br/>Busca por IMEI ou OS<br/><br/>Fornece:<br/>OS<br/>Marca<br/>Modelo<br/>Cor<br/>Defeito<br/>Observação do serviço"]

        PEACS["Tabela PEACS<br/><br/>Cruzamento pelo código comercial<br/><br/>Fornece:<br/>Preço estimado de venda"]

        DEMO["Demonstrativo de Saldos<br/><br/>Fornece:<br/>Referência da peça<br/>Descrição da peça<br/>Código comercial<br/>Fabricante<br/><br/>O saldo não é o estoque oficial"]

        ANALISE_MI["Análise MI<br/>Fonte de transição<br/><br/>Fornece:<br/>Aparelhos já analisados<br/>Peças solicitadas<br/>CHAVEPECA<br/>Situação atual"]

        PEDIDOS["Pedidos<br/>Fonte de transição<br/><br/>Fornece:<br/>Pedidos existentes<br/>Situação legada<br/>Bipagem inicial<br/>Referências vinculadas"]

        BKP["BKP Sistêmico<br/>Fonte histórica<br/><br/>Fornece:<br/>Reparos anteriores<br/>Técnicos<br/>Baixas<br/>Triagens<br/>Histórico do aparelho"]
    end

    %% =========================================================
    %% CENTRAL DE DADOS
    %% =========================================================

    subgraph DADOS["2. Central de Dados"]
        UPLOAD["Usuário envia arquivo bruto<br/><br/>Sem renomear aba<br/>Sem remover colunas<br/>Sem tratamento manual"]

        IDENTIFICAR["Sistema identifica<br/>tipo e estrutura do arquivo"]

        VALIDAR["Validar estrutura<br/>Mostrar prévia<br/>Apontar inconsistências"]

        CONFIRMAR["Confirmar importação"]

        VERSIONAR["Salvar nova versão dos dados"]

        LOGIMPORT["Registrar histórico da importação<br/><br/>Usuário<br/>Data e hora<br/>Nome do arquivo<br/>Hash<br/>Linhas lidas<br/>Inseridos<br/>Atualizados<br/>Ignorados<br/>Erros<br/>Duração"]

        ULTIMA["Atualizar no card:<br/>Última atualização válida<br/>Data interna dos dados<br/>Resultado da importação"]
    end

    HIS --> UPLOAD
    SERIAIS --> UPLOAD
    SH --> UPLOAD
    PEACS --> UPLOAD
    DEMO --> UPLOAD
    ANALISE_MI --> UPLOAD
    PEDIDOS --> UPLOAD
    BKP --> UPLOAD

    UPLOAD --> IDENTIFICAR
    IDENTIFICAR --> VALIDAR
    VALIDAR --> CONFIRMAR
    CONFIRMAR --> VERSIONAR
    VERSIONAR --> LOGIMPORT
    VERSIONAR --> ULTIMA

    %% =========================================================
    %% BASE CONSOLIDADA
    %% =========================================================

    subgraph BASE["3. Base consolidada do sistema"]
        BASE_APARELHOS["Base de aparelhos<br/><br/>IMEI como chave principal"]

        BASE_OS["Base de Ordens de Serviço"]

        BASE_HIS["Base de idade e custo"]

        BASE_PEACS["Base de preço de venda"]

        BASE_DEMO["Base de referências e descrições de peças"]

        BASE_TRANSICAO["Base temporária de migração<br/>Análise MI e Pedidos"]

        BASE_HIST["Base histórica<br/>BKP Sistêmico"]
    end

    VERSIONAR --> BASE_APARELHOS
    VERSIONAR --> BASE_OS
    VERSIONAR --> BASE_HIS
    VERSIONAR --> BASE_PEACS
    VERSIONAR --> BASE_DEMO
    VERSIONAR --> BASE_TRANSICAO
    VERSIONAR --> BASE_HIST

    %% =========================================================
    %% ANÁLISE DO APARELHO
    %% =========================================================

    subgraph ANALISE["4. Analisar aparelho"]
        BUSCA["Operador pesquisa por:<br/>IMEI ou OS"]

        PREFILL["Sistema pré-preenche a análise"]

        SHINFO["Do SH:<br/>OS<br/>Marca<br/>Modelo<br/>Cor<br/>Defeito<br/>Observação"]

        SERIAISINFO["Do Relatório de Seriais:<br/>Modelo padronizado<br/>Código comercial<br/>Depósito<br/>Disponibilidade"]

        HISINFO["Do His Estoque:<br/>Idade<br/>Custo"]

        PEACSINFO["Da PEACS:<br/>Venda estimada"]

        REVISAO["Operador revisa e corrige<br/>qualquer campo necessário"]

        CAMPOS["Dados finais da análise:<br/><br/>IMEI<br/>OS<br/>Marca<br/>Modelo<br/>Cor<br/>Problema<br/>Idade<br/>Custo<br/>Venda estimada"]

        VALIDACAO["Validar análise"]

        BLOQUEIO["Bloquear conclusão quando:<br/><br/>IMEI vazio<br/>Modelo vazio<br/>Custo igual a zero<br/>Venda estimada igual a zero<br/>Nenhuma peça informada<br/>Cor obrigatória ausente"]

        ANALISE_OK["Análise válida"]
    end

    BUSCA --> PREFILL

    BASE_OS --> SHINFO
    BASE_APARELHOS --> SERIAISINFO
    BASE_HIS --> HISINFO
    BASE_PEACS --> PEACSINFO

    SHINFO --> PREFILL
    SERIAISINFO --> PREFILL
    HISINFO --> PREFILL
    PEACSINFO --> PREFILL

    PREFILL --> REVISAO
    REVISAO --> CAMPOS
    CAMPOS --> VALIDACAO

    VALIDACAO -->|Dados incompletos| BLOQUEIO
    BLOQUEIO --> REVISAO

    VALIDACAO -->|Dados válidos| ANALISE_OK

    %% =========================================================
    %% PEÇAS NECESSÁRIAS
    %% =========================================================

    subgraph PECAS["5. Peças necessárias"]
        ADDPECA["Adicionar peça necessária"]

        PESQUISA_PECA["Pesquisar por:<br/><br/>Nome da peça<br/>CHAVEPECA existente<br/>Referência conhecida"]

        SUGESTOES["Sugestões vindas de:<br/><br/>Análise MI<br/>Solicitações anteriores<br/>Vínculos da contagem"]

        LIVRE["Se não existir opção:<br/>Permitir digitação livre"]

        CHECKCOR["Checkbox:<br/>Incluir cor do aparelho?"]

        COMCOR["Marcado:<br/>PEÇA + MODELO + COR"]

        SEMCOR["Desmarcado:<br/>PEÇA + MODELO"]

        CHAVE["Gerar CHAVEPECA"]

        EX1["Exemplo:<br/>TAMPA TRASEIRA GALAXY A22 4G PRETO"]

        EX2["Exemplo:<br/>BATERIA GALAXY A22 4G"]

        PARTREQ["Criar solicitação da peça<br/><br/>Nome da peça<br/>Modelo<br/>Usa cor ou não<br/>Cor utilizada<br/>CHAVEPECA<br/>Quantidade"]
    end

    ANALISE_OK --> ADDPECA
    ADDPECA --> PESQUISA_PECA
    SUGESTOES --> PESQUISA_PECA
    PESQUISA_PECA -->|Encontrou| CHECKCOR
    PESQUISA_PECA -->|Não encontrou| LIVRE
    LIVRE --> CHECKCOR

    CHECKCOR -->|Sim| COMCOR
    CHECKCOR -->|Não| SEMCOR

    COMCOR --> CHAVE
    SEMCOR --> CHAVE

    CHAVE --> EX1
    CHAVE --> EX2
    CHAVE --> PARTREQ

    %% =========================================================
    %% CONTAGEM DE PEÇAS
    %% =========================================================

    subgraph CONTAGEM["6. Contagem física do João"]
        ABRIR_CONTAGEM["Abrir nova contagem"]

        BIPAR["Bipar ou digitar referência"]

        BUSCAR_DEMO["Buscar referência no<br/>Demonstrativo de Saldos"]

        DESC["Retornar descrição da peça"]

        MAP_EXISTE{"Referência já está vinculada<br/>a uma CHAVEPECA?"}

        RECONHECE["Reconhecer automaticamente"]

        DESCONHECIDA["Mostrar referência como desconhecida"]

        VINCULAR["João seleciona ou informa<br/>a CHAVEPECA correta"]

        PERSISTIR["Salvar vínculo permanentemente<br/>Referência ↔ CHAVEPECA"]

        SOMAR["Somar uma unidade na contagem"]

        FECHAR["Fechar contagem"]

        SNAPSHOT["Criar snapshot oficial<br/>do estoque físico"]

        ESTOQUE_OFICIAL["Estoque oficial de peças<br/><br/>Fonte única:<br/>Contagem física do João"]
    end

    BASE_DEMO --> BUSCAR_DEMO

    ABRIR_CONTAGEM --> BIPAR
    BIPAR --> BUSCAR_DEMO
    BUSCAR_DEMO --> DESC
    DESC --> MAP_EXISTE

    MAP_EXISTE -->|Sim| RECONHECE
    RECONHECE --> SOMAR

    MAP_EXISTE -->|Não| DESCONHECIDA
    DESCONHECIDA --> VINCULAR
    VINCULAR --> PERSISTIR
    PERSISTIR --> SOMAR

    SOMAR --> BIPAR
    SOMAR --> FECHAR
    FECHAR --> SNAPSHOT
    SNAPSHOT --> ESTOQUE_OFICIAL

    PERSISTIR --> SUGESTOES

    %% =========================================================
    %% MOTOR DE MATCH
    %% =========================================================

    subgraph MOTOR["7. Motor de Match"]
        GATILHO["Motor é executado após:<br/><br/>Nova análise<br/>Alteração de peça<br/>Fechamento de contagem<br/>Vínculo de referência<br/>Recebimento de peça<br/>Cancelamento de reserva<br/>Alteração de regras<br/>Atualização de fontes"]

        ENTRADAS["Entradas do motor:<br/><br/>Idade<br/>Custo<br/>Venda estimada<br/>Margem<br/>Peças necessárias<br/>Estoque físico contado<br/>Reservas<br/>Compras<br/>Status operacional"]

        REGRAS["Regras configuráveis<br/><br/>Peso da idade<br/>Peso da margem<br/>Faixas de pontuação<br/>Prioridades do laboratório"]

        CALCULO["Calcular prioridade do aparelho"]

        DISPONIBILIDADE["Verificar disponibilidade<br/>de todas as peças necessárias"]

        RESULTADO{"Resultado operacional"}

        MATCH["MATCH<br/>Kit completo disponível"]

        PARCIAL["MATCH PARCIAL<br/>Parte do kit disponível"]

        PEDIR["PEDIR PEÇA<br/>Peça necessária sem saldo"]

        AGUARDANDO["AGUARDANDO RECEBIMENTO<br/>Peça já está comprada"]

        REVISAR["ANALISAR / REVISAR<br/>Dados ou vínculo inconsistentes"]

        APTO["APTO PARA DIRECIONAR<br/>Kit já separado"]

        MOTOR_LOG["Registrar mudança real<br/>no histórico operacional"]
    end

    ANALISE_OK --> GATILHO
    PARTREQ --> GATILHO
    SNAPSHOT --> GATILHO
    PERSISTIR --> GATILHO

    BASE_HIS --> ENTRADAS
    BASE_PEACS --> ENTRADAS
    PARTREQ --> ENTRADAS
    ESTOQUE_OFICIAL --> ENTRADAS

    GATILHO --> ENTRADAS
    REGRAS --> CALCULO
    ENTRADAS --> CALCULO
    CALCULO --> DISPONIBILIDADE
    DISPONIBILIDADE --> RESULTADO

    RESULTADO -->|Kit completo| MATCH
    RESULTADO -->|Parte do kit| PARCIAL
    RESULTADO -->|Sem peça| PEDIR
    RESULTADO -->|Peça comprada| AGUARDANDO
    RESULTADO -->|Informação inconsistente| REVISAR
    RESULTADO -->|Reserva completa| APTO

    MATCH --> MOTOR_LOG
    PARCIAL --> MOTOR_LOG
    PEDIR --> MOTOR_LOG
    AGUARDANDO --> MOTOR_LOG
    REVISAR --> MOTOR_LOG
    APTO --> MOTOR_LOG

    %% =========================================================
    %% FILA DE REPAROS
    %% =========================================================

    subgraph FILA["8. Fila de aparelhos a finalizar"]
        CARD["Cada card representa<br/>um aparelho que precisa ser finalizado"]

        INFO_CARD["O card deve mostrar:<br/><br/>Modelo<br/>IMEI e OS<br/>Cor<br/>Depósito<br/>Idade<br/>Margem<br/>Peças necessárias<br/>Peças disponíveis<br/>Bloqueio atual<br/>Próxima ação"]

        CATEGORIAS["Categorias operacionais:<br/><br/>Separar agora<br/>Comprar peça<br/>Revisar informações<br/>Aguardando recebimento<br/>Direcionar ao técnico<br/>Com técnico<br/>Finalizados"]

        PROXIMA["Sistema informa:<br/>O que pode ser feito agora?"]

        MODAL["Abrir modal central do aparelho"]

        ACOES["Ações disponíveis conforme contexto:<br/><br/>Adicionar observação<br/>Marcar para revisão<br/>Revalidar match<br/>Definir prioridade<br/>Incluir em compra<br/>Separar peças<br/>Cancelar reserva<br/>Direcionar técnico<br/>Iniciar reparo<br/>Concluir reparo"]
    end

    MOTOR_LOG --> CARD
    CARD --> INFO_CARD
    INFO_CARD --> CATEGORIAS
    CATEGORIAS --> PROXIMA
    PROXIMA --> MODAL
    MODAL --> ACOES

    %% =========================================================
    %% FLUXO DE COMPRA
    %% =========================================================

    subgraph COMPRA["9. Compra e recebimento"]
        INCLUIR_COMPRA["João inclui peças faltantes<br/>em compra"]

        SOLICITACAO_COMPRA["Criar solicitação de compra"]

        PEDIDO_COMPRA["Criar pedido de compra"]

        STATUS_AGUARDANDO["Aparelho e peça ficam<br/>Aguardando recebimento"]

        RECEBER["Abrir recebimento do pedido"]

        QUANTIDADE["Informar quantidade recebida"]

        TIPO_RECEBIMENTO{"Tipo de recebimento"}

        COMPLETO["Recebimento completo"]

        PARCIAL_REC["Recebimento parcial"]

        EXCEDENTE["Recebimento excedente<br/>Exige justificativa"]

        MOVIMENTO["Registrar movimento de estoque"]

        NOVO_SALDO["Atualizar estoque disponível"]

        REPROCESSAR["Executar novamente<br/>o Motor de Match"]
    end

    PEDIR --> INCLUIR_COMPRA
    PARCIAL --> INCLUIR_COMPRA

    INCLUIR_COMPRA --> SOLICITACAO_COMPRA
    SOLICITACAO_COMPRA --> PEDIDO_COMPRA
    PEDIDO_COMPRA --> STATUS_AGUARDANDO
    STATUS_AGUARDANDO --> RECEBER
    RECEBER --> QUANTIDADE
    QUANTIDADE --> TIPO_RECEBIMENTO

    TIPO_RECEBIMENTO -->|Quantidade esperada| COMPLETO
    TIPO_RECEBIMENTO -->|Menor| PARCIAL_REC
    TIPO_RECEBIMENTO -->|Maior| EXCEDENTE

    COMPLETO --> MOVIMENTO
    PARCIAL_REC --> MOVIMENTO
    EXCEDENTE --> MOVIMENTO

    MOVIMENTO --> NOVO_SALDO
    NOVO_SALDO --> REPROCESSAR
    REPROCESSAR --> GATILHO

    %% =========================================================
    %% SEPARAÇÃO
    %% =========================================================

    subgraph SEPARACAO["10. Separação das peças"]
        ACAO_SEPARAR["João confirma a separação"]

        VALIDAR_ESTOQUE["Validar estoque atual<br/>e referência indicada"]

        RESERVAR["Criar reserva das peças"]

        KIT_OK{"Kit completo reservado?"}

        SEPARADO_PARCIAL["Separação parcial"]

        APTO_REPARO["Aparelho apto para reparo"]

        DIRECIONAR["João seleciona técnico"]
    end

    MATCH --> ACAO_SEPARAR
    PARCIAL --> ACAO_SEPARAR

    ACAO_SEPARAR --> VALIDAR_ESTOQUE
    VALIDAR_ESTOQUE --> RESERVAR
    RESERVAR --> KIT_OK

    KIT_OK -->|Não| SEPARADO_PARCIAL
    SEPARADO_PARCIAL --> CARD

    KIT_OK -->|Sim| APTO_REPARO
    APTO_REPARO --> DIRECIONAR

    %% =========================================================
    %% TÉCNICO
    %% =========================================================

    subgraph TECNICO["11. Fluxo com técnico"]
        COM_TECNICO["Aparelho direcionado<br/>ao técnico"]

        INICIAR["Iniciar reparo"]

        EM_REPARO["Status: Em reparo"]

        CONCLUIR["Concluir reparo"]

        CONSUMIR["Consumir peças reservadas"]

        BAIXA["Registrar baixa das peças<br/>vinculada à OS"]

        EXECUTADO["Status:<br/>Reparo executado"]

        TRIAGEM["Enviar para triagem final"]

        RESULTADO_TRIAGEM{"Resultado da triagem"}

        APROVADO["Aparelho aprovado"]

        RETORNO["Retorno ao técnico"]

        FINALIZADO["Aparelho finalizado"]
    end

    DIRECIONAR --> COM_TECNICO
    COM_TECNICO --> INICIAR
    INICIAR --> EM_REPARO
    EM_REPARO --> CONCLUIR
    CONCLUIR --> CONSUMIR
    CONSUMIR --> BAIXA
    BAIXA --> EXECUTADO
    EXECUTADO --> TRIAGEM

    TRIAGEM --> RESULTADO_TRIAGEM
    RESULTADO_TRIAGEM -->|Aprovado| APROVADO
    RESULTADO_TRIAGEM -->|Reprovado| RETORNO

    RETORNO --> EM_REPARO
    APROVADO --> FINALIZADO

    %% =========================================================
    %% HISTÓRICO OPERACIONAL
    %% =========================================================

    subgraph HISTORICO["12. Histórico e rastreabilidade"]
        EVENTOS["Registrar eventos operacionais"]

        EVENTOS_LISTA["Exemplos:<br/><br/>Análise concluída<br/>Observação adicionada<br/>Peça solicitada<br/>Compra criada<br/>Peça recebida<br/>Match alterado<br/>Reserva criada<br/>Peça separada<br/>Técnico direcionado<br/>Reparo iniciado<br/>Reparo concluído<br/>Triagem concluída"]

        DADOS_EVENTO["Cada evento guarda:<br/><br/>Quem<br/>Quando<br/>Ação<br/>Status anterior<br/>Novo status<br/>Peça ou referência<br/>Observação"]

        TIMELINE["Exibir linha do tempo<br/>dentro do modal do aparelho"]
    end

    ANALISE_OK --> EVENTOS
    PERSISTIR --> EVENTOS
    SOLICITACAO_COMPRA --> EVENTOS
    PEDIDO_COMPRA --> EVENTOS
    MOVIMENTO --> EVENTOS
    MOTOR_LOG --> EVENTOS
    RESERVAR --> EVENTOS
    DIRECIONAR --> EVENTOS
    INICIAR --> EVENTOS
    CONCLUIR --> EVENTOS
    FINALIZADO --> EVENTOS

    EVENTOS --> EVENTOS_LISTA
    EVENTOS_LISTA --> DADOS_EVENTO
    DADOS_EVENTO --> TIMELINE
    TIMELINE --> MODAL

    %% =========================================================
    %% OBJETIVO DO SISTEMA
    %% =========================================================

    OBJETIVO["OBJETIVO CENTRAL<br/><br/>Encontrar reparos que podem ser atendidos<br/>e mostrar ao João o que pode ser feito<br/>para avançar cada aparelho até a finalização"]

    OBJETIVO --> FILA

