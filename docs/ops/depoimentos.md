# Depoimentos de clientes: como publicar um depoimento real

Estado atual: **nenhum depoimento publicado**. `data/depoimentos.json` é uma lista vazia (`[]`) e, enquanto
estiver vazia, o site não mostra seção, título, marcador nem "em breve". Nada de depoimento, nota, número de
clientes ou logotipo pode ser inventado.

## Quando um depoimento pode entrar

Só quando as cinco condições abaixo forem verdadeiras e você tiver a prova guardada fora do repositório:

1. **Cliente real com pedido real.** A pessoa comprou (pedido pago e não estornado).
2. **Autorização por escrito.** A pessoa escreveu (e-mail ou formulário de atendimento) que autoriza publicar
   o texto com o primeiro nome e a cidade. Guarde essa mensagem.
3. **Texto da própria pessoa.** Sem reescrever o sentido; correção de digitação é aceitável.
4. **Só primeiro nome e cidade.** Sem sobrenome, foto, telefone, e-mail, @ de rede social ou nota.
5. **Origem conhecida.** E-mail, formulário de atendimento ou pesquisa pós-venda.

## Como adicionar

1. Calcule o SHA-256 da referência real do pedido (o ID do pedido no Mercado Pago ou na Hotmart). A referência
   em si **nunca** vai para o repositório; só o hash:

   ```sh
   printf '%s' 'ID-REAL-DO-PEDIDO' | sha256sum
   ```

2. Acrescente um objeto em `data/depoimentos.json`, com exatamente estes campos:

   ```json
   [
     {
       "pedido_ref_sha256": "<64 caracteres hexadecimais minúsculos do passo 1>",
       "consentimento_escrito": true,
       "consentimento_data": "AAAA-MM-DD",
       "data": "AAAA-MM-DD",
       "primeiro_nome": "Ana",
       "cidade": "Várzea Alegre (CE)",
       "fonte": "email",
       "produto": "lucro-e-caixa",
       "texto": "O texto da pessoa, entre 20 e 400 caracteres, sem link, e-mail ou telefone."
     }
   ]
   ```

   - `fonte`: `email`, `formulario-atendimento` ou `pesquisa-pos-venda`;
   - `produto`: `ia-na-pratica`, `vendas-na-pratica`, `lucro-e-caixa`, `combo-ia-vendas`, `negocio-completo`
     ou `conteudo-pronto`;
   - `data` é a data do depoimento; `consentimento_data`, a da autorização (igual ou posterior).

3. Confira antes de abrir o PR:

   ```sh
   python3 scripts/sales_marketing.py --check-depoimentos data/depoimentos.json
   python3 scripts/build_sales_public.py
   node --test tests/sales-marketing.test.mjs
   ```

   O build **recusa** (e o CI reprova) qualquer entrada sem hash do pedido, sem `consentimento_escrito: true`,
   com data inválida ou futura, com nome completo, cidade sem UF, fonte desconhecida, campo extra (sobrenome,
   foto, nota, contato) ou pedido repetido.

4. O depoimento aparece em `/solucoes` e na página do produto dele, com "primeiro nome, cidade, cliente do
   <produto>, mês de ano" e a frase "Depoimentos reais, publicados com autorização por escrito". Não há marcação
   schema.org `Review` nem nota em estrelas.

## Como retirar

Se a pessoa pedir para retirar, apague o objeto do arquivo, rode o build e publique. O pedido de retirada vale
na hora; guarde a mensagem dele junto com a autorização original.
