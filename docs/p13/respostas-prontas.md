# P13 Pós-venda: respostas prontas para Reclame Aqui, consumidor.gov.br e Hotmart

Fonte: roteiro v4.9.1, seção 5 (P13), 7.1 (H-6) e 7.3. **Avaliação jurídica: informação, não aconselhamento
formal.** O executor não é advogado nem contador; textos com efeito jurídico passam pelo proprietário e, se for o
caso, por advogado.

## Regras de uso (valem para todos os textos)

1. **Nenhum dado pessoal em resposta pública.** Nome, e-mail, CPF, telefone, endereço, número da transação e valor
   pago do consumidor nunca entram no texto. Os únicos campos permitidos são `{PROTOCOLO}` (protocolo interno da
   ZEVANORY), `{DATA_SOLICITACAO}`, `{PRAZO}` e `{PRODUTO}`. O verificador `scripts/p13/respostas-check.mjs`
   recusa qualquer outro campo, e-mail que não seja o canal oficial, CPF, telefone e preço.
2. **Protocolo registrado antes da resposta.** Cada reclamação recebe um protocolo interno, anotado com a data da
   solicitação, a plataforma, a decisão (`scripts/p13/decisao-reembolso-7d.mjs`) e o resultado. Motivos alimentam
   P24 e P25.
3. **Revisão humana.** Toda resposta marcada `Revisão humana: OBRIGATÓRIA` só é publicada depois de o proprietário
   ler e aprovar o texto final. É obrigatória em toda resposta pública e em toda decisão sensível: reembolso fora
   da regra (exceção), assunto jurídico, dado pessoal e contestação.
4. **Política única.** O prazo é sempre o da política publicada: "7 dias corridos contados da assinatura do
   contrato ou do recebimento do produto ou serviço (a data mais recente, se diferentes)". Nenhum texto promete
   prazo, valor ou exceção diferente. Exceção só com autorização registrada do proprietário.
5. **Prazos de resposta.** Resposta conclusiva em até 5 dias (política publicada). Na Hotmart, pedido de
   reembolso respondido dentro do prazo da plataforma: 5 dias corridos (item H-6, Política de Pagamentos item
   3.6, segundo a auditoria suprema; **[NÃO VERIFICADO na conta]**). No consumidor.gov.br, o prazo é o da
   plataforma para a empresa aderente **[NÃO VERIFICADO: adesão da ZEVANORY e prazo vigente]**. O Reclame Aqui
   não tem prazo legal; a meta interna é responder dentro dos mesmos 5 dias.
6. **Canal privado para o resto.** Tudo que exigir dado do pedido segue por suporte@zevanory.api.br ou pela
   mensagem privada da plataforma, nunca na resposta pública.

## Reclame Aqui (resposta pública)

### RA-01 · Dificuldade de acesso ou arquivo que não abre
- Categoria: acesso
- Decisão de origem: n/a
- Revisão humana: OBRIGATÓRIA (resposta pública)
```text
Olá. Sentimos pelo transtorno. Registramos o seu caso com o protocolo {PROTOCOLO}. O conteúdo completo fica disponível para download na área Minhas compras logo após a aprovação do pagamento. Se algum arquivo não abriu ou não aparece, o suporte resolve sem custo: escreva para suporte@zevanory.api.br informando o protocolo. Para proteger seus dados, seguimos o atendimento por mensagem privada.
```

### RA-02 · Pedido de reembolso dentro do prazo de 7 dias
- Categoria: reembolso_no_prazo
- Decisão de origem: aprovar_arrependimento
- Revisão humana: OBRIGATÓRIA (resposta pública)
```text
Olá. Seu pedido de arrependimento foi recebido em {DATA_SOLICITACAO}, dentro do prazo de 7 dias corridos, e foi aceito sem necessidade de justificativa, com devolução integral do valor pago. Protocolo: {PROTOCOLO}. O estorno é feito pela plataforma responsável pela cobrança; a visualização do crédito no cartão segue o prazo do emissor. Seguimos à disposição por mensagem privada.
```

### RA-03 · Pedido de reembolso fora do prazo, sem alegação de defeito
- Categoria: reembolso_fora_do_prazo
- Decisão de origem: fora_do_prazo
- Revisão humana: OBRIGATÓRIA (resposta pública)
```text
Olá. Recebemos sua mensagem e registramos o protocolo {PROTOCOLO}. O direito de arrependimento vale por 7 dias corridos contados da assinatura do contrato ou do recebimento do produto ou serviço (a data mais recente, se diferentes), e esse prazo terminou em {PRAZO}. Se houver defeito, arquivo corrompido ou falha de entrega, nosso suporte analisa o caso sem custo: escreva para suporte@zevanory.api.br com o protocolo. Seguimos o atendimento por mensagem privada.
```

### RA-04 · Alegação de defeito ou de conteúdo diferente do anunciado
- Categoria: vicio
- Decisão de origem: fora_do_prazo_vicio
- Revisão humana: OBRIGATÓRIA (resposta pública)
```text
Olá. Obrigado por relatar. Registramos o protocolo {PROTOCOLO} e vamos analisar o material de {PRODUTO} contra o que a página de venda descreve. Se houver falha nossa, corrigimos, substituímos o arquivo ou devolvemos o valor, conforme o caso. Pedimos que nos envie os detalhes por suporte@zevanory.api.br; a resposta conclusiva sai em até 5 dias.
```

### RA-05 · Cobrança não reconhecida ou contestação aberta no cartão
- Categoria: contestacao
- Decisão de origem: contestacao_em_andamento
- Revisão humana: OBRIGATÓRIA (contestação)
```text
Olá. Registramos o protocolo {PROTOCOLO}. Como existe uma contestação em andamento, ela segue pelo procedimento da plataforma de pagamento e do emissor do cartão, e não abrimos um segundo estorno em paralelo, para evitar cobrança ou devolução em duplicidade. Para conferir os dados com segurança, escreva para suporte@zevanory.api.br com o protocolo; não publique dados do cartão ou do pedido aqui.
```

### RA-06 · Assunto jurídico ou pedido sobre dados pessoais
- Categoria: juridico
- Decisão de origem: n/a
- Revisão humana: OBRIGATÓRIA (assunto jurídico ou dado pessoal)
```text
Olá. Registramos o protocolo {PROTOCOLO} e encaminhamos o seu pedido ao responsável. Pedidos sobre dados pessoais são atendidos pelo canal do titular indicado na política de privacidade, suporte@zevanory.api.br. Por segurança, o atendimento continua somente por canal privado.
```

## consumidor.gov.br (resposta à reclamação)

### CG-01 · Reembolso dentro do prazo
- Categoria: reembolso_no_prazo
- Decisão de origem: aprovar_arrependimento
- Revisão humana: OBRIGATÓRIA (resposta em plataforma pública de governo)
```text
Prezado(a) consumidor(a), o pedido de arrependimento registrado em {DATA_SOLICITACAO} está dentro do prazo de 7 dias corridos e foi aceito sem necessidade de justificativa, com devolução integral do valor pago. Protocolo interno: {PROTOCOLO}. O estorno é processado pela plataforma responsável pela cobrança; a visualização do crédito no cartão segue o prazo do emissor. Atenciosamente, ZEVANORY (suporte@zevanory.api.br).
```

### CG-02 · Reembolso fora do prazo, sem alegação de defeito
- Categoria: reembolso_fora_do_prazo
- Decisão de origem: fora_do_prazo
- Revisão humana: OBRIGATÓRIA (resposta em plataforma pública de governo)
```text
Prezado(a) consumidor(a), registramos o protocolo interno {PROTOCOLO}. O direito de arrependimento vale por 7 dias corridos contados da assinatura do contrato ou do recebimento do produto ou serviço (a data mais recente, se diferentes); no seu pedido, o prazo terminou em {PRAZO}. Se houver defeito, arquivo corrompido ou falha de entrega, analisamos o caso sem custo: informe os detalhes nesta reclamação ou por suporte@zevanory.api.br. Atenciosamente, ZEVANORY.
```

### CG-03 · Exceção à regra autorizada pelo proprietário
- Categoria: excecao
- Decisão de origem: excecao_autorizada
- Revisão humana: OBRIGATÓRIA (reembolso fora da regra)
```text
Prezado(a) consumidor(a), após análise do caso (protocolo interno {PROTOCOLO}), a ZEVANORY decidiu, em caráter excepcional, devolver o valor pago, embora o prazo de arrependimento tenha terminado em {PRAZO}. O estorno é processado pela plataforma responsável pela cobrança. Atenciosamente, ZEVANORY (suporte@zevanory.api.br).
```

### CG-04 · Falha de acesso ou de entrega
- Categoria: acesso
- Decisão de origem: n/a
- Revisão humana: OBRIGATÓRIA (resposta em plataforma pública de governo)
```text
Prezado(a) consumidor(a), registramos o protocolo interno {PROTOCOLO}. O conteúdo completo de {PRODUTO} fica disponível para download na área Minhas compras logo após a aprovação do pagamento. Se algum arquivo não abriu ou não aparece, enviamos o material sem custo por canal privado: escreva para suporte@zevanory.api.br com o protocolo. Atenciosamente, ZEVANORY.
```

## Hotmart (resposta ao pedido de reembolso e à disputa)

### HM-01 · Aprovação de reembolso dentro do prazo
- Categoria: reembolso_no_prazo
- Decisão de origem: aprovar_arrependimento
- Revisão humana: dispensada (aplicação da regra, sem decisão sensível)
```text
Pedido de arrependimento recebido em {DATA_SOLICITACAO}, dentro do prazo de 7 dias corridos. Aprovado sem necessidade de justificativa, com devolução integral. Protocolo interno: {PROTOCOLO}.
```

### HM-02 · Pedido fora do prazo com possível defeito
- Categoria: vicio
- Decisão de origem: fora_do_prazo_vicio
- Revisão humana: OBRIGATÓRIA (decisão fora da regra)
```text
Recebemos o pedido (protocolo interno {PROTOCOLO}). O prazo de arrependimento terminou em {PRAZO}, mas analisamos qualquer defeito, arquivo corrompido ou falha de entrega sem custo. Por favor, descreva o problema encontrado em {PRODUTO}; a resposta conclusiva sai em até 5 dias.
```

### HM-03 · Resposta em disputa ou contestação (procedimento 7.3)
- Categoria: contestacao
- Decisão de origem: contestacao_em_andamento
- Revisão humana: OBRIGATÓRIA (contestação)
```text
Disputa registrada com o protocolo interno {PROTOCOLO}. Evidência de entrega anexada conforme o procedimento: registro de liberação do acesso na área Minhas compras e registros de envio, com dados pessoais mascarados. O comprador pode exercer o arrependimento de 7 dias corridos; não houve pedido dentro desse prazo até {PRAZO}. Ficamos à disposição para qualquer verificação adicional.
```
