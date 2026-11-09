# Avaliação de Legítimo Interesse (LIA): lembrete de compra não concluída na Hotmart

- **Status:** RASCUNHO — aguarda assinatura do proprietário (P2a)
- **Caminho reservado:** `ops/owner-reserved-paths.json`, classe `fiscal_juridico`. Qualquer alteração exige `owner-approved:<12 hex do head>`.
- **Estrutura:** Guia Orientativo de Legítimo Interesse da ANPD (2024).
- **Tratamento avaliado:** 1 e-mail de lembrete para quem informou o e-mail no checkout da Hotmart de um dos 5 kits e não concluiu a compra.
- **Decisão do proprietário que origina o tratamento (literal):** "Aprovo 1 e-mail de abandono por legítimo interesse, com avaliação LGPD, aviso na privacidade, descadastro e descarte em 30 dias."
- **Escopo:** os 5 kits Hotmart: IA na Prática 8704733, Vendas na Prática 8704826, Lucro & Caixa 8704851, Combo 8704861 e Negócio Completo 8704871. Conteúdo Pronto (8704905) e Gestão (8709787) ficam fora. O filtro dos 5 IDs fica no código.
- **Aviso publicado:** política de privacidade (`privacidade/index.html` §1 "Lembrete de compra não concluída", §2 operadores e §4 retenção), publicada **antes** de o evento ser assinado na Hotmart (P3) e antes do aquecimento (PR-4a).

## Identificação

- **Controlador:** A. RENAN ALVES MOREIRA BITU LTDA (ZEVANORY), CNPJ 69.077.233/0001-99.
- **Encarregado:** suporte@zevanory.api.br.
- **Operadores:** Hotmart (origem do dado e checkout), Cloudflare (Worker, KV e banco D1), Resend (envio).
- **Data do rascunho:** 08/11/2026. Revisão em 6 meses ou a qualquer mudança no fluxo.

## 1. Finalidade

Recuperar uma compra que o próprio titular começou e não concluiu, e oferecer ajuda em caso de falha de pagamento ou dúvida. É interesse lícito e ligado a uma situação concreta (art. 10, I), e também beneficia o titular (art. 10, II).

Não é perfilamento, venda de lista, reuso em outras campanhas, nem envio a quem não iniciou a compra.

## 2. Necessidade (art. 6º, III; art. 10, §1º)

- **Dados:** só o e-mail e o produto. Nome, telefone, IP e país não são guardados.
- **Comprador:** de quem compra ou gera o boleto (o Pix, só se a P5 confirmar), guardamos por 30 dias só o código derivado do e-mail com chave secreta, para não enviar lembrete a quem já comprou. Isso só ocorre com o fluxo ligado (estágios `aquecimento` e `ativo`).
- **Período:** e-mail em claro até o envio (1–2 h) ou no máximo 72 h; pseudônimo HMAC por 30 dias.
- **Quantidade:** 1 e-mail por pessoa a cada 30 dias, no total, com teto técnico de 20 por dia.
- **Alternativa menos invasiva:** não enviar nada. Foi considerada e é pior para quem teve falha de pagamento. WhatsApp e SMS foram descartados.

## 3. Balanceamento

- **Expectativa legítima:** o titular digitou o e-mail no checkout de um produto da ZEVANORY. Um único lembrete sobre **esse** pedido, logo em seguida, é razoavelmente esperado; uma sequência ou outras ofertas não seriam.
- **Impactos possíveis:**
  - incômodo (baixo);
  - exposição do e-mail (baixa: e-mail só no KV privado com TTL curto; estado no D1 só com pseudônimos; sem logs);
  - sensação de vigilância (mitigada pelo motivo explicado no e-mail).
- **Vulneráveis:** a Hotmart exige maioridade para comprar. Não há dados sensíveis.
- **Decisão automatizada:** não há decisão com efeito jurídico.
- **Conclusão:** o interesse prevalece **desde que** valham as salvaguardas abaixo.

## 4. Salvaguardas

- **Transparência prévia:** a política é publicada **antes** do P3 e do PR-4a, e o motivo do contato vai no próprio e-mail (art. 10, §2º).
- **Oposição em 1 clique** (art. 18, §2º), com supressão por pseudônimo **sem prazo**. É exceção ao descarte de 30 dias, necessária para honrar a oposição, e depende do **aceite expresso do proprietário no P6**.
- **Limites técnicos:**
  - 1 e-mail por pessoa em 30 dias;
  - teto de 20 por dia;
  - cancelamento automático em compra aprovada ou completa e em boleto gerado;
  - envio só com as vendas do kit abertas.
- **Descarte:** e-mail em claro em no máximo 72 h; pseudônimos de envio e de comprador em 30 dias. O histórico técnico de recuperação do D1 (Time Travel) guarda até 7 dias, também só com pseudônimos.
- **Envio no máximo uma vez:** reserva atômica no D1 (uma instrução que confere compra, supressão, dedupe de 30 dias e teto diário) e confirmação só com resposta válida do Resend. Um 409 nunca é tratado como entregue sem verificação e nunca leva a reenvio.
- **Falha do D1:** qualquer falha do banco (sem binding, sem tabela, erro de rede, resultado sem `meta`) impede o envio (fail-closed). No descadastro, a oposição é gravada também numa supressão de reserva no KV, fundida ao D1 quando ele voltar.
- **Aquecimento:** o marcador de compra começa a ser gravado **no mínimo 30 dias** antes do primeiro envio (padrão). Com 30 dias não há risco residual dentro da regra de 30 dias. Se o proprietário escolher 7 dias no P6, aceita expressamente o R13: quem comprou entre 7 e 30 dias antes da ativação pode receber 1 lembrete, inclusive **do mesmo kit** que já comprou.
- **Restrição de país, salvaguarda condicional (NC-6):** o código recusa quando `checkout_country.iso` existe e é diferente de "BR". Enquanto a sonda P5 não confirmar que o campo vem preenchido, esta LIA **não** declara restrição territorial do envio. Se a P5 não confirmar o campo, essa declaração fica de fora de vez e a regra de código continua só como defesa adicional.
- **Logs e segredos:** nenhum segredo e nenhum dado pessoal em logs (testado); hottok e token de descadastro comparados em tempo constante; recusa fail-closed.
- **Operadores e transferência:** operadores listados na política; transferência internacional pelo art. 33 (política §3).
- **Registro de operações (art. 37):** contadores agregados no batimento horário. Esta LIA fica disponível à ANPD (art. 10, §3º).

## 5. Assinaturas

- **Assinatura do proprietário (P2a, antes do P3):** __________ (data: __________).
- **Reconfirmação com o resultado da P5 (P6):** __________ (data: __________). Inclui o aceite expresso da supressão permanente por pseudônimo e, conforme a P5, a manutenção ou a retirada da salvaguarda de país.

Sem a assinatura do P2a, o evento de abandono não é assinado no painel da Hotmart (P3): o primeiro dado pessoal de abandono só pode chegar com esta avaliação já assinada.
