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
Qualquer divergencia bloqueia a acao e exige nova evidencia/aprovacao.
Nunca encerre uma etapa com erro ou pendencia tecnica.
Antes de declarar conclusao, execute 3 auditorias finais independentes: testes/sintaxe, auditoria 3X estrutural e prova operacional em producao.
Falha em qualquer auditoria mantem a etapa BLOQUEADA.
## Coordenacao concorrente
Antes de editar identidade publica, dominio, landing ou seus testes, leia WORKSTREAMS.md.
Os arquivos reservados dessa frente nao podem ser sobrescritos por outro chat/agente durante trabalho concorrente.
Sempre execute `node scripts/identity-guard.mjs` antes de testes finais e deploy.
Falha do identity guard e blocker absoluto de publicacao.
