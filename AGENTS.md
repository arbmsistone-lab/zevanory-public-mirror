# ZEVANORY — INSTRUCAO DE ENTRADA

Antes de qualquer pesquisa, planejamento, codigo, deploy ou alteracao:
1. Leia ZEVANORY_MASTER.md inteiro.
2. Leia specs/GATES.md e specs/EVIDENCE_POLICY.md.
3. Leia validation/AUDIT-3X-CURRENT.json.
4. Identifique: o que ja foi aprovado, estado atual e proximo gate autorizado.
5. Pesquise as evidencias do proximo gate antes de implementar.

Nao mude o trajeto aprovado por conveniencia.
Nao pule gates.
Nao trate hipotese como fato.
Nao trate clique, lead ou checkout como venda.
Nao habilite autonomia antes dos gates correspondentes.
Nao inicie venda, CTA comercial, checkout, outbound, atendimento comercial ativo, experimento de venda ou midia paga enquanto SALE_GLOBALLY_ENABLED e PRE_SALE_GATES_APPROVED nao estiverem explicitamente true e o gate especifico do canal nao estiver aprovado.
Qualquer divergencia bloqueia a acao e exige nova evidencia/aprovacao.
Nunca encerre uma etapa com erro ou pendencia tecnica.
Antes de declarar conclusao, execute 3 auditorias finais independentes: testes/sintaxe, auditoria 3X estrutural e prova operacional em producao.
Toda montagem ou alteracao de infraestrutura deve registrar 3 auditorias independentes: (1) estrutural/configuracao, (2) funcional/seguranca/integridade e (3) integracao/regressao/prova operacional.
As 3 auditorias devem estar APROVADAS. Falha, divergencia, erro conhecido ou validacao parcial em qualquer uma mantem a infraestrutura e a etapa BLOQUEADAS.
## Coordenacao concorrente
Antes de editar identidade publica, dominio, landing ou seus testes, leia WORKSTREAMS.md.
Os arquivos reservados dessa frente nao podem ser sobrescritos por outro chat/agente durante trabalho concorrente.
Sempre execute `node scripts/identity-guard.mjs` antes de testes finais e deploy.
Falha do identity guard e blocker absoluto de publicacao.
Antes de qualquer deploy, releia WORKSTREAMS.md e trate producao como operacao serializada.
Deploy deve sair da raiz C:\Sistemas\ZEVANORY com pacote completo; deployment parcial e proibido.
A release so fecha se o alias publico continuar apontando para o deployment exato promovido durante a Auditoria 3.
