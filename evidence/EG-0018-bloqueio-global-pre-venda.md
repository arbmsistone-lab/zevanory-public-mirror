# EVIDENCE GATE

ID: EG-0018 / Bloqueio global pre-venda
Decisao: nenhuma capacidade comercial pode iniciar antes de todos os gates pre-venda obrigatorios estarem aprovados.
Problema: impedir CTA, checkout, outbound, atendimento comercial ativo, experimento de venda ou midia paga por configuracao parcial.

## Evidencia 1
Fonte: Google Cloud App Lifecycle Manager - https://docs.cloud.google.com/app-lifecycle-manager/flags/flags-overview
Classe: A
Constatacao: codigo pode chegar a producao com recurso desativado por padrao e ser ativado somente quando pronto.
Limite: orientacao generica de feature flags, nao especifica vendas.

## Evidencia 2
Fonte: Microsoft Azure App Configuration - https://learn.microsoft.com/en-us/azure/azure-app-configuration/concept-feature-management
Classe: A
Constatacao: feature flags funcionam como kill switch instantaneo sem necessidade de redeploy.
Limite: orientacao de plataforma generica.

## Evidencia 3
Fonte: AWS AppConfig - https://docs.aws.amazon.com/appconfig/latest/userguide/what-is-appconfig.html
Classe: A
Constatacao: feature flags permitem ocultar capacidade ate a liberacao e desativar imediatamente se houver problema.
Limite: orientacao de plataforma generica.

## Convergencia
As tres fontes independentes recomendam desacoplar codigo implantado de capacidade efetivamente habilitada e manter interruptor operacional reversivel.
Ausencia, erro ou divergencia de configuracao deve resultar em capacidade comercial DESATIVADA.

## Veredito
Veredito: APROVADO
Criterio: SALE_GLOBALLY_ENABLED=false por padrao; cada superficie comercial exige flag global + gate especifico aprovado.
Kill-switch: qualquer gate aberto, auditoria falha, configuracao ausente ou divergencia mantem toda venda bloqueada.
