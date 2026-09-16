# Contrato de Evolucao dos Produtos de Conteudo

## Regra de ouro
Uma release certificada nunca e editada, reconstruida por cima ou substituida. Toda evolucao nasce em nova versao e workspace isolado.

## Gate obrigatorio
- Excelencia: 100%.
- Confianca: minimo 99%.
- Nivel: MASTER SENIOR.
- Hash exato de cada artefato.
- Reprodutibilidade e regressao completa.
- Compatibilidade retroativa avaliada.
- Plano de migracao e rollback obrigatorios.
- Deprecacao explicita quando houver quebra.
- Vendas permanecem fail-closed ate certificacao comercial independente.

## Fluxo de evolucao
1. Rodar `npm run audit:content:evolution`.
2. Rodar `npm run content:evolution:dry-run`.
3. Criar nova workspace com `scripts/scaffold-content-evolution.py`.
4. Evoluir somente a nova workspace.
5. Certificar conteudo, compatibilidade, migracao, rollback, seguranca e regressao.
6. Materializar nova release em novo diretorio.
7. Atualizar catalogo apenas apos hash e gates aprovados.
8. Preservar a release anterior como rollback verificavel.

## Protecoes implementadas
- Fingerprint SHA-256 da arvore de cada release certificada.
- Recusa automatica de sobrescrita de release ou workspace existente.
- Versao de destino deve ser estritamente superior a origem.
- SKU e hashes atuais devem coincidir com o catalogo.
- Qualidade comercial continua separada da qualidade de conteudo.
