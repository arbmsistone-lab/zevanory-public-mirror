# EVIDENCE GATE

ID da implementacao: EG-0007 / Validacao Operacional 3x
Decisao proposta: exigir no minimo 3 operacoes de validacao aprovadas para cada unidade funcional de codigo e cada definicao operacional usada pelo projeto.
Problema que resolve: impedir que uma unica verificacao, teste feliz ou revisao superficial libere codigo/definicao para uso.

## Evidencia 1
Fonte: NIST SSDF / SP 800-218 - https://csrc.nist.gov/pubs/sp/800/218/final
Classe: A
Constatacao: o SSDF recomenda revisao/analise de codigo e testes executaveis, com escopo, desenho, execucao e registro dos resultados; tambem recomenda incorporar regressao de falhas ja descobertas.
Limites: framework geral de desenvolvimento seguro, nao prescreve exatamente tres verificacoes por unidade.

## Evidencia 2
Fonte: OpenAI - Building with GPT-5 / Agent evals - https://cdn.openai.com/pdf/47c0215b-8976-4f60-8e13-d69c2ddbc15e/a-practical-guide-to-building-with-gpt-5.pdf
Classe: B
Constatacao: a orientacao recomenda foco em confiabilidade, avaliacao e otimizacao depois do fluxo ponta a ponta, usando evals e trace grading para detectar comportamento inesperado.
Limites: orientacao de sistemas de IA; nao substitui testes tradicionais de software.

## Evidencia 3
Fonte: Microsoft Experimentation Platform - https://www.microsoft.com/en-us/research/group/experimentation-platform-exp/articles/patterns-of-trustworthy-experimentation-during-experiment-stage/
Classe: B
Constatacao: a Microsoft recomenda metricas holisticas, qualidade de dados, diagnostico e guardrails para detectar regressao e impedir decisao baseada em um unico sinal.
Limites: metodologia de experimentacao online; aplicada aqui como principio de verificacao multipla e independente.

## Convergencia e contradicoes
O que as fontes concordam: software confiavel exige verificacoes complementares, testes automatizados, qualidade de dados, guardrails e registro de resultados; uma unica verificacao nao e suficiente para liberar comportamento critico.
O que diverge: nenhuma fonte define o numero tres como universal; tres e a politica minima interna escolhida para garantir diversidade de verificacao.
O que permanece nao comprovado: tres operacoes nao garantem ausencia absoluta de defeitos; unidades de maior risco podem exigir mais verificacoes.

## Veredito
Veredito: APROVADO
Criterio de teste apos implementacao: todo item no manifesto de validacao deve possuir >=3 operacoes distintas e todos os testes devem passar no mesmo commit.
Kill-switch / rollback: qualquer unidade abaixo de 3 operacoes, teste falho ou divergencia entre definicao e runtime bloqueia commit de liberacao e deploy.
