# F1 rodada 2 — pós-venda transacional Hotmart

Base: `3cd47670b2c86a71696984ea9a40df349f1da585`. Implementação para auditoria em DRAFT.

## Fonte dos kits e separação do teste

Decisão explícita do proprietário nesta sessão: usar o mapeamento existente de data/p18-commercial-allowlist.json cruzado com os cinco SKUs/slugs de data/products.json, pois products.json não contém IDs Hotmart. Ambos os arquivos foram somente lidos. São aceitos apenas os cinco kits; Conteúdo Pronto e qualquer produto fictício ficam de fora. O mapeamento não foi novamente validado no painel da Hotmart.

O gancho roda apenas após o evento financeiro ter sido gravado pelo handler autenticado, e exige novamente POST /api/webhooks/hotmart e hottok válido. A rota /api/webhooks/hotmart/teste nunca agenda, mesmo com um ID real. Apenas PURCHASE_APPROVED agenda; estorno/chargeback registram supressão persistente inclusive antes de uma aprovação atrasada. Nenhuma tentativa de distinguir teste de venda pelo corpo do payload. IMPORTANTE: o botão oficial continua reservado à segunda configuração na rota dedicada, nunca à configuração de produção. Um teste enviado à produção com um dos IDs reais seria indistinguível de uma aprovação real autenticada.

## Sequência e segurança

D+0 orienta acesso via https://consumer.hotmart.com/; D+1 dá primeiro passo do kit; D+5 oferece suporte@zevanory.api.br. Sem anexo ou nova entrega do produto, sem preço, oferta, depoimento, promessa de ganho, WhatsApp ou Telegram. O filtro forbidden existente é reutilizado por containsForbiddenCreativeText; a regra original não foi relaxada. Há bloqueio adicional de preço/oferta e canais banidos.

Somente o tick controller.cron = 0 * * * * chama o consumidor, antes das tarefas concorrentes de alerta e do pós-venda legado/nutrição. Antes de qualquer GET ao Resend, ele lista os pedidos e exige ao menos uma etapa vencida e não confirmada. Fila vazia, nenhuma etapa vencida ou todas confirmadas: zero chamadas ao provedor. As etapas são prioridade 1. A leitura completa e paginada do Resend conta os aceitos no dia UTC; com 100, nenhum novo envio é tentado. API sem permissão de leitura, resposta incompleta ou inválida bloqueia. O limite gratuito continua sendo também imposto pelo provedor; outros consumidores do sistema não foram reescritos por este PR. Com leitura do monitor KV indicando 60% ou mais, ou leitura desatualizada, o consumidor adia o envio. A gravação de uma venda legítima não depende desse adiamento.

Cada etapa usa zpc:posvenda:hotmart:<transaction>:<etapa>, corpo estável, hash, registro de tentativa anterior ao POST e Idempotency-Key derivada da transação/etapa. Uma confirmação é armazenada separadamente, evitando que um resultado desconhecido posterior apague prova de aceite. Não há mais de três etapas por pedido. Limite de duas tentativas registradas; somente rejeição HTTP 429 permite a segunda, após uma hora e dentro de 23 horas da primeira, com o mesmo corpo e chave. Timeout, 409, 5xx ou 200 sem ID válido permanecem desconhecidos e não geram novo POST. Reconciliação exige GET list + GET por ID, destinatário, assunto, texto integral e janela correspondentes. Aceite Resend não é prova de entrega na caixa postal.

## Recuperação e privacidade

Leitura KV indisponível bloqueia até a próxima leitura bem-sucedida. Um pedido corrompido pode ser reconstruído pelo replay autenticado de aprovação, sem apagar recibos de etapas. Etapa/confirmação corrompida nunca vira ausência: fica desconhecida e só recupera confirmação com evidência do provedor. Supressão corrompida só é reparada por novo estorno autenticado ou link de descadastro válido; nunca é apagada para liberar envio. Sem evidência para resolver um resultado desconhecido, a etapa permanece retida com segurança.

Campos pessoais guardados: somente e-mail e primeiro nome; os demais campos são referências técnicas, base legal e datas. Expiração fixa 35 dias após aprovação (D+5 + 30 dias), inclusive nos recibos; replay não renova retenção. Marcadores de supressão são pseudônimos sem e-mail/nome. Sem dados pessoais em logs, URL ou resultado público do consumidor. GET no link assinado somente mostra uma página com botão de confirmação e não lê/grava supressão. Somente POST, incluindo List-Unsubscribe-Post do cliente de e-mail, grava o opt-out. Isso evita descadastro por prefetch/antivírus.

Compra sem os campos necessários ao pós-venda continua registrada como venda, com aviso privado pendente sem dados pessoais; não dispara e-mail. O efeito secundário do pós-venda só é chamado após emitActivity e diarioSombra. Qualquer falha conserva a resposta original 200 e os registros de venda/atividade/entrega. Registra somente console.error("hotmart_post_sale_enqueue_failed") e tenta gravar zpc:posvenda:hotmart:falha:<sha(transaction)> = {failed:true}, TTL 7 dias, sem e-mail. Falha desse marcador fica só no log. Replay autenticado com fila recuperada resolve a projeção de falha sem apagar recibos. readHotmartPostSaleFailures exporta contagem estrita com rótulo pós-venda não enfileirado (n); leitura inválida é inconclusiva, nunca zero. A exibição no relatório fica para depois do merge do #1021, que não foi alterado.

## Limites para revisão independente

O KV não fornece compare-and-set. Há serialização dentro do isolate e chave idempotente estável no Resend, mas esta rodada não prova um limite global de duas chamadas HTTP entre isolates concorrentes: dois processos podem observar a mesma tentativa. O limite de duas tentativas registradas e a deduplicação do provedor não devem ser apresentados como exclusão mútua distribuída. A antiga afirmação de excesso limitado a uma chamada não é garantida e foi retirada. A cota restrita desta rodada é atômica no PostgreSQL; isso não transforma os recibos KV das etapas em exclusão mútua distribuída. Essa limitação continua documentada; não se declara um teto distribuído de chamadas. Nenhum binding ou migração foi alterado. Também é preciso confirmar que a chave Resend existente permite os GETs necessários; não foram consultados segredos nem a conta real.

## Testes e mutantes

30 testes novos incluindo dez mutantes (desconhecido reenviado, pós-estorno, oferta/preço, e-mail em log, quarta etapa, produto estranho, rota de teste, limite de tentativas, cota e trava). Provas de recuperação, descadastro, retenção, concorrência no isolate e venda preservada em falha parcial. Suíte completa, manifesto e gates registrados na entrega do SHA. Nenhum mutante morreu por falha de importação: a morte é uma asserção do cenário após controle positivo.

## Texto de privacidade proposto, não publicado

“Após uma compra aprovada na Hotmart, poderemos usar seu e-mail e primeiro nome para enviar até três mensagens de acompanhamento transacional: acesso ao produto, orientação inicial e suporte de uso. Esses dados serão mantidos por até 30 dias após a última etapa prevista. Você poderá interromper esse acompanhamento por um link em cada mensagem. Este acompanhamento não inclui ofertas ou campanhas de marketing.”

Nenhum caminho reservado alterado. Sem merge, rótulo, dispatch, reativação ou deploy. Outros PRs não foram alterados.

## Rodada 2b — NCs corrigidas

NC-CL-1025-01: pós-venda secundário após atividade/diário, nunca substitui a resposta do ingest; falha mínima sem dados pessoais e leitor estrito exportado.
NC-CL-1025-02: somente tick horário e consulta ao Resend apenas com etapa vencida/não confirmada.
NC-CL-1025-03: GET confirma visualmente; apenas POST descadastra.

12 testes adicionais em f2b-hotmart-secondary, incluindo 4 mutantes causais: retorno 503, enqueue antes da atividade, provedor sem etapa vencida e GET gravando. Os dez mutantes anteriores continuam ativos; a âncora do de estorno foi ajustada para também remover a nova pré-checagem, sem reduzir a prova.
Reprodução oficial adv1025.mjs do anexo executada sem alterações: HTTP 200, venda true, atividade true, apenas log de falha do efeito secundário. Suíte e gates finais informados na entrega do SHA; nenhuma conta real ou segredo foi consultado.

## NC-R2-1025-04 — histórico e reconciliação

A cota usa o endpoint oficial GET /usage do Resend (https://resend.com/docs/api-reference/usage/retrieve-usage), sem listar o histórico. Valida consumo, limite e data de renovação das janelas diária e mensal. Aplica o menor limite entre a conta e a política de 100/dia e 3.000/mês; limite diário nulo não remove a política. Erro, resposta inválida ou janela vencida bloqueiam novos envios sem gravar tentativa. Uma leitura válida posterior permite recuperação. A chave existente precisa autorizar esse endpoint; nenhuma credencial real foi consultada.

A reconciliação de envio desconhecido usa uma página por etapa a cada execução, cursor e candidatos persistidos em KV com a mesma expiração do pedido. Há orçamento compartilhado de nove leituras de reconciliação por execução, além da leitura de cota. Não se presume ordenação temporal da lista. Evidência exige destinatário, assunto, corpo e janela de tentativa compatíveis. Falha de leitura mantém a etapa desconhecida; cursor corrompido reinicia apenas a busca de evidência por GET, mantendo a etapa desconhecida sem outro POST e sem bloquear pedidos independentes. Esgotar uma busca nunca prova ausência de envio; a próxima busca pode reiniciar para encontrar evidência tardia. Os checkpoints guardam somente hash do corpo e referências do provedor.

Onze testes adicionais cobrem 1.100 registros históricos, cota diária/mensal, falha e recuperação de leitura, retomada além de dez páginas, isolamento de falha de histórico e candidatos pendentes. Quatro mutantes restauram dependência do histórico, convertem uso inválido em zero, descartam cursor e descartam candidatos; todos devem morrer por asserção do cenário.

## NC-CL-1025-04 — estado consultável da execução

O runner persiste `zpc:posvenda:hotmart:status:v1` com exatamente `{em,resultado,codigo,pendentes}` e TTL de sete dias. `em` é o horário UTC da última mudança persistida. Resultado é `ok`, `inconclusivo` ou `reconciliacao_pendente`. Não contém e-mail, nome, pedido nem mensagem de exceção. Não renova TTL quando nada mudou. Uma mudança posterior dentro de uma hora aguarda a próxima execução elegível; as tentativas de status no mesmo isolate são serializadas. O KV não oferece escrita condicional: o limite entre isolates segue a consistência do KV e não constitui exclusão mútua distribuída. Nenhum binding, cron ou infraestrutura foi alterado.

`readHotmartPostSaleStatus(kv,{now})` é exportado para a integração posterior ao merge do #1021. Retorna `ok` com o valor validado, `NAO_EXECUTADO` para chave ausente e `LEITURA_INCONCLUSIVA` para leitura falha, estrutura inválida, campos extras, data futura ou estado vencido. O relatório ainda não foi alterado. Se o próprio KV não permite persistir o aviso, o runner expõe `statusPersisted:false` e log fixo sem dados pessoais; uma execução posterior pode recuperar. Uma projeção de status corrompida pode ser reconstruída sem modificar recibos de envio ou o registro financeiro.

Condição antes de produção: **RESEND_API_KEY precisa de permissão Full access (GET /usage e GET /emails); com Sending access o pós-venda fica inconclusivo e não envia**. A permissão da chave real ainda não foi confirmada. Segredos não foram lidos nem alterados.

Dez testes adicionais, incluindo três mutantes, verificam persistência da falha 403, reconciliação pendente, TTL e ausência de dados pessoais, leitura estrita, recuperação de corrupção/falha de KV, gravação somente na mudança, limite horário e concorrência no isolate. O mutante que deixa de gravar status em falha morre pela asserção de persistência.

## Rodada 3 — NC-G6-1025-01
A cota restrita (GET /usage 401/403) saiu do KV. A tabela literal zevanory_posvenda_cota usa uma linha por mês UTC, com contador mensal e mapa de dias. Um único INSERT ON CONFLICT UPDATE condicional, sob o lock da mesma linha, incrementa conjuntamente os dois limites (40/dia e 1200/mês). Não há incrementos parciais nem reset ao alternar dias. O sqlFactory existente do Worker é injetado no cron; sem banco/configuração ou com resposta incerta da reserva, não faz POST. Uma reserva que pode ter sido consumida não é devolvida. Nenhum banco, binding ou segredo novo. A tabela será criada pela inicialização literal já prevista quando o caminho for implantado/autorizado; nenhum DDL de produção foi executado nesta entrega.

Testes: dez reservadores concorrentes perto de cada teto, validação do livro, falha após commit sem POST, falta de configuração e dias intercalados. Mutantes dos limites diário/mensal e da reserva depois do POST. O laboratório com PostgreSQL real valida a instrução contra conexões independentes; a suíte portátil usa fixture determinística. O limite restrito é desta rotina; outros fluxos da conta Resend continuam sujeitos ao orçamento global já existente. Não se afirma que o excesso entre isolates se limita a um envio.
