# F1 rodada 2 — pós-venda transacional Hotmart

Base: `3cd47670b2c86a71696984ea9a40df349f1da585`. Implementação para auditoria em DRAFT.

## Fonte dos kits e separação do teste

Decisão explícita do proprietário nesta sessão: usar o mapeamento existente de data/p18-commercial-allowlist.json cruzado com os cinco SKUs/slugs de data/products.json, pois products.json não contém IDs Hotmart. Ambos os arquivos foram somente lidos. São aceitos apenas os cinco kits; Conteúdo Pronto e qualquer produto fictício ficam de fora. O mapeamento não foi novamente validado no painel da Hotmart.

O gancho roda apenas após o evento financeiro ter sido gravado pelo handler autenticado, e exige novamente POST /api/webhooks/hotmart e hottok válido. A rota /api/webhooks/hotmart/teste nunca agenda, mesmo com um ID real. Apenas PURCHASE_APPROVED agenda; estorno/chargeback registram supressão persistente inclusive antes de uma aprovação atrasada. Nenhuma tentativa de distinguir teste de venda pelo corpo do payload. IMPORTANTE: o botão oficial continua reservado à segunda configuração na rota dedicada, nunca à configuração de produção. Um teste enviado à produção com um dos IDs reais seria indistinguível de uma aprovação real autenticada.

## Sequência e segurança

D+0 orienta acesso via https://consumer.hotmart.com/; D+1 dá primeiro passo do kit; D+5 oferece suporte@zevanory.api.br. Sem anexo ou nova entrega do produto, sem preço, oferta, depoimento, promessa de ganho, WhatsApp ou Telegram. O filtro forbidden existente é reutilizado por containsForbiddenCreativeText; a regra original não foi relaxada. Há bloqueio adicional de preço/oferta e canais banidos.

O cron horário chama o consumidor antes das tarefas concorrentes de alerta e do pós-venda legado/nutrição. As etapas são prioridade 1. A leitura completa e paginada do Resend conta os aceitos no dia UTC; com 100, nenhum novo envio é tentado. API sem permissão de leitura, resposta incompleta ou inválida bloqueia. O limite gratuito continua sendo também imposto pelo provedor; outros consumidores do sistema não foram reescritos por este PR. Com leitura do monitor KV indicando 60% ou mais, ou leitura desatualizada, o consumidor adia o envio. A gravação de uma venda legítima não depende desse adiamento.

Cada etapa usa zpc:posvenda:hotmart:<transaction>:<etapa>, corpo estável, hash, registro de tentativa anterior ao POST e Idempotency-Key derivada da transação/etapa. Uma confirmação é armazenada separadamente, evitando que um resultado desconhecido posterior apague prova de aceite. Não há mais de três etapas por pedido. Limite de duas tentativas registradas; somente rejeição HTTP 429 permite a segunda, após uma hora e dentro de 23 horas da primeira, com o mesmo corpo e chave. Timeout, 409, 5xx ou 200 sem ID válido permanecem desconhecidos e não geram novo POST. Reconciliação exige GET list + GET por ID, destinatário, assunto, texto integral e janela correspondentes. Aceite Resend não é prova de entrega na caixa postal.

## Recuperação e privacidade

Leitura KV indisponível bloqueia até a próxima leitura bem-sucedida. Um pedido corrompido pode ser reconstruído pelo replay autenticado de aprovação, sem apagar recibos de etapas. Etapa/confirmação corrompida nunca vira ausência: fica desconhecida e só recupera confirmação com evidência do provedor. Supressão corrompida só é reparada por novo estorno autenticado ou link de descadastro válido; nunca é apagada para liberar envio. Sem evidência para resolver um resultado desconhecido, a etapa permanece retida com segurança.

Campos pessoais guardados: somente e-mail e primeiro nome; os demais campos são referências técnicas, base legal e datas. Expiração fixa 35 dias após aprovação (D+5 + 30 dias), inclusive nos recibos; replay não renova retenção. Marcadores de supressão são pseudônimos sem e-mail/nome. Sem dados pessoais em logs, URL ou resultado público do consumidor. GET/POST no link assinado realiza descadastro em um clique.

Compra sem os campos necessários ao pós-venda continua registrada como venda, com aviso privado pendente sem dados pessoais; não dispara e-mail. Falha na fila depois da gravação financeira retorna 503; a reentrega conserva a venda e conclui a fila sem duplicar o evento financeiro.

## Limites para revisão independente

O KV não fornece compare-and-set. Há serialização dentro do isolate e chave idempotente estável no Resend, mas esta rodada não prova um limite global de duas chamadas HTTP entre isolates concorrentes: dois processos podem observar a mesma tentativa. O limite de duas tentativas registradas e a deduplicação do provedor não devem ser apresentados como exclusão mútua distribuída. A auditoria deve decidir essa NC antes de qualquer autorização de merge; obter exclusão mútua durável poderia exigir um binding/migração reservado, que não foi alterado. Também é preciso confirmar que a chave Resend existente permite os GETs necessários; não foram consultados segredos nem a conta real.

## Testes e mutantes

30 testes novos incluindo dez mutantes (desconhecido reenviado, pós-estorno, oferta/preço, e-mail em log, quarta etapa, produto estranho, rota de teste, limite de tentativas, cota e trava). Provas de recuperação, descadastro, retenção, concorrência no isolate e venda preservada em falha parcial. Suíte completa, manifesto e gates registrados na entrega do SHA. Nenhum mutante morreu por falha de importação: a morte é uma asserção do cenário após controle positivo.

## Texto de privacidade proposto, não publicado

“Após uma compra aprovada na Hotmart, poderemos usar seu e-mail e primeiro nome para enviar até três mensagens de acompanhamento transacional: acesso ao produto, orientação inicial e suporte de uso. Esses dados serão mantidos por até 30 dias após a última etapa prevista. Você poderá interromper esse acompanhamento por um link em cada mensagem. Este acompanhamento não inclui ofertas ou campanhas de marketing.”

Nenhum caminho reservado alterado. Sem merge, rótulo, dispatch, reativação ou deploy. Outros PRs não foram alterados.
