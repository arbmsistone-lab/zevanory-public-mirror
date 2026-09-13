# ARBM Central V10 — freeze arquitetural

Registro anterior a qualquer edição de código: 2026-09-06T22:25:21-03:00.

## Proveniência
- Repositório: C:\Sistemas\ARBM-One-CENTRAL-SYNC
- Origin: https://github.com/arbmsistone-lab/ARBM-one.git
- Branch encontrada: opencode/arbm-full-reconcile
- SHA baseline do checkout: 02322ca5df9cfee391ec5639824e48489f1eaa80
- Estado: baseline local identificado; equivalência com a arquitetura aprovada AINDA NÃO demonstrada.
- Screenshot da Central: não fornecido; imagens preexistentes em work são do PDV e não comprovam a Central.

## Inventário antes da V10
Modificados preexistentes, não pertencentes à V10: .gitignore; AGENTS.md; src/components/AppLayout.tsx; src/features/pdv/pdv-premium.css; src/features/pdv/pedidos-central-somente-leitura.tsx; src/lib/auth.tsx; src/routes/pdv.tsx; tests/ui-phase-b-accessibility.test.mjs.
Não rastreados preexistentes: .codex-write-check.tmp; supabase/.temp/; work/.
Não sobrescrever, descartar, adicionar a commits V10 ou publicar essas alterações.

## Mapa da implementação
- Rota: src/routes/atendimento-operador.tsx (estado, fila, ações, conversa e CSS inline).
- Layout compartilhado: src/components/AppLayout.tsx; autenticação: src/lib/auth.tsx (ambos já modificados por terceiros).
- Estilos: src/features/atendimento-operador/central-profissional.css; src/index.css; src/design-system/arbm-tokens.css.
- Componentes: src/features/atendimento-operador/components/{CabecalhoClienteInterno,CadastroAssistidoCliente,Janela24HorasAtendimento,PainelModelosRodape,DialogoCentralProfissional,EstadoExpedienteCentral,TagsAtendimentoCentral,MenuMensagemCentral,GravadorAudioWhatsApp,MensagemAudio,MensagemImagem,MensagemVideo,MensagemDocumento}.tsx.
- PIX/pagamentos: src/components/AtendimentoPixOperacional.tsx; src/components/AtendimentoPagamentosPedido.tsx.
- Dados: services/filaCentralV67.ts; services/mensagensCentralV68.ts; services/centralConversasCacheV69.ts; contextoOperacionalCentral.ts; estadoExpediente.ts; nivelInternoCliente.ts.
- Testes: tests/atendimento-*.test.mjs e testes de cadastro assistido .tsx. Incluem responsividade, janela 24h, envio Enter, expediente, performance V66–V70, mídia e cadastro.
- Comandos existentes: npm run lint; npm run build; node --test. Typecheck a verificar com tsc --noEmit (sem script dedicado). Sem Playwright/Vitest declarado no package.json.

## Invariantes obrigatórios
1. Macro: MENU ARBM | ATENDIMENTOS | CONVERSA | GESTÃO DO CLIENTE; conversa dominante com espaço flexível restante.
2. IA ARBM · Atendimento no menu esquerdo.
3. Central / Pendentes / Encerrados dentro da fila; pesquisa no topo.
4. Gestão exclusivamente na rail direita; Entregas ao vivo abaixo dela e fora da conversa.
5. Notas Internas na toolbar inferior da conversa.
6. Tags ocultas ao operador, sem reintroduzir TagsAtendimentoCentral ou equivalente visual.
7. Cabeçalho CONVERSA / CONTATO / FIDELIDADE / HISTÓRICO.
8. Fila à esquerda; nenhuma função removida ou deslocada sem necessidade objetiva.
9. Zero scroll horizontal e global; scroll interno controlado. Sem tela cheia forçada.
10. Sem redesign estrutural e sem diminuir significativamente a conversa.

## Divergência inicial a resolver
O CSS local define três colunas (menu, fila, conversa). O teste desktop também exige três colunas. Não foram encontrados os textos Gestão do Cliente / Entregas ao vivo na rota. TagsAtendimentoCentral está montado dentro de um wrapper hidden/aria-hidden (não é evidência de tags visíveis). É necessário identificar a revisão aprovada antes de refinar sua arquitetura; não reconstruir a V9 por suposição.

## Plano V10 em blocos
V10.1–4: tokens 4/8, geometria, bordas redundantes, tipografia e cores semânticas.
V10.5–7: origem do contador, seleção da fila, formatters únicos e espaço útil do histórico.
V10.8–9: janela 24h integrada ao tema, ação de modelo real, fail-closed auditado no backend.
V10.10–12: toolbar contextual, cabeçalho único e gestão preservada.
V10.13–16: entregas adaptativas, conectividade real, acessibilidade e estados sem double-submit.
V10.17–20: medir desempenho, responsividade, comparação visual e matriz funcional.
Após cada bloco: testes relevantes, lint/typecheck/build aplicáveis, inspeção visual e comparação com freeze. Não prosseguir com regressão.

## Matriz visual obrigatória
Cada linha deve ser verificada em zoom 90%, 100%, 110%, 125%, antes e depois, com screenshot e medição de overflow/colisão.
| Viewport | 90% | 100% | 110% | 125% |
|---|---|---|---|---|
|1280x720|Pendente|Pendente|Pendente|Pendente|
|1366x768|Pendente|Pendente|Pendente|Pendente|
|1440x900|Pendente|Pendente|Pendente|Pendente|
|1600x900|Pendente|Pendente|Pendente|Pendente|
|1920x1080|Pendente|Pendente|Pendente|Pendente|

## Matriz funcional obrigatória
Todos pendentes de evidência runtime: novo; em andamento; pendente; encerrado; troca; pesquisa; janela aberta; janela encerrada; envio comum; template; solicitar nome; solicitar endereço; confirmar endereço; editar cadastro; PIX; pedido; transferência; liberar; concluir; notas internas; Cliente 360; endereço; entregas; sem entrega ativa; perda de conexão; reconexão; realtime da fila; erro de API; loading; empty state.
Não enviar mensagens reais a clientes sem autorização explícita. Usar dados/ambiente de teste identificados para efeitos transacionais.

## Critérios de regressão e certificação
Reprovar deslocamentos estruturais, colisões, cortes, overflow, perda funcional, estados enganosos, sucesso fictício, máscara divergente ou double-submit. Contraste: texto normal 4.5:1; grande/controles 3:1. Validar foco, Tab e Escape. Medir abertura, troca, pesquisa, atualização da fila/realtime, histórico e toolbar; metas percebidas pesquisa <200ms, troca <300ms quando possível, sem mascarar rede.
GO exige gates verdes, todos os viewports/zooms/fluxos, contraste, teclado, desempenho e produção no SHA final comprovados. P0/P1 ou regressão estrutural ou gate vermelho ou SHA divergente = NO-GO. Não declarar 10/10 enquanto houver evidência pendente.

## Rollback
Preservar o SHA baseline e as alterações preexistentes. Reverter somente commit/hunk V10 problemático; não usar reset --hard, checkout destrutivo, force push ou reescrita de histórico publicado. Não restaurar layout antigo integralmente. Nenhum deploy antes de verificar repositório e identidade do projeto ARBM One.

## Regra constitucional — tags (adendo do usuário)
visible_customer_classification_tags = 0 na rota /atendimento-operador. Proibidos chips, cards, cabeçalho, Gestão, Cliente 360, tooltip, popover, menu ou substituto equivalente com tags de classificação. Nenhum espaço reservado, gap, padding residual, container invisível com geometria ou perda de largura. Dados internos podem permanecer; não eliminar camada de dados sem análise. Estados operacionais (Esperando, Em atendimento, WhatsApp, Resposta atrasada, Entregue, Lido, Janela encerrada) não são tags de classificação. Qualquer tag visual = FAIL / NO-GO.

## Baseline arquitetural localizado por inspeção Git
A referência local origin/main aponta para 0dfc307c06245ec0c31a12fe604084cd95e10091 (merge PR #184, 2026-09-06 18:30:47 -0300) e contém PainelRailDireitaCentral, PainelGestaoClienteCentral, PainelEntregasAoVivoCentral e IA no menu. A implementação local anterior não representa essa arquitetura. V10 será isolada em work/central-v10, branch codex/central-v10-freeze, a partir desse SHA, sem alterar os arquivos preexistentes do checkout original. Este é o baseline de implementação V10; 02322ca continua registrado como SHA encontrado inicialmente. Referência remota ainda não atualizada nem produção validada.
