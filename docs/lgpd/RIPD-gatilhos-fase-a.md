# RIPD · P01 Fase A: por que não há RIPD completo agora e gatilhos que o exigem (LGPD, art. 38)

Minuta (AVAL 101, lacuna 12). Não é parecer jurídico.

| Campo | Valor |
|---|---|
| Versão: 1 | 23/10/2026 |
| Estado | **PENDENTE DE REVISÃO JURÍDICA** pelo proprietário. |
| LIA / ROPA | `docs/lgpd/LIA-fase-a.md` / `docs/lgpd/ROPA-fase-a.md` |

## 1. Avaliação atual (a confirmar pelo proprietário)

O RIPD completo não é elaborado neste momento porque, enquanto valerem os controles da LIA v2: a finalidade é
estatística e limitada a uma janela curta; não há dado sensível nem direcionamento a crianças/adolescentes; os dados
de medição são pseudônimos, minimizados (sem derivado persistido de IP+UA) e apagados automaticamente; o aviso
antecede a coleta; a não participação impede toda gravação; não há perfilamento, decisão automatizada sobre o
titular, cruzamento de bases nem contato. A ANPD pode requerer o RIPD a qualquer tempo (art. 38), e ele será
elaborado se solicitado.

## 2. Gatilhos que tornam o RIPD necessário (qualquer um suspende a coleta até o RIPD)

1. Conhecimento de tratamento de dados de criança ou adolescente além de caso isolado excluído.
2. Escala: monitoramento sistemático em escala (por exemplo, janela prolongada, mais nichos ou volume muito acima do
   pré-registrado).
3. Dados sensíveis ou inferidos (art. 5º, II) por qualquer via.
4. Fingerprinting ou qualquer persistência de derivado de IP+UA/dispositivo.
5. Cruzamento da medição com a lista de espera ou com outras bases.
6. Perfilamento, decisão com efeito sobre o titular ou contato individual baseado na medição.
7. Tráfego pago (`meta_*` ou outro) ou pixel/SDK de terceiro.
8. Novo operador ou novo país/região de armazenamento.
9. Nova finalidade.
10. Incidente de segurança relevante envolvendo os dados da Fase A.

## 3. Conteúdo mínimo do RIPD quando acionado

Descrição dos tipos de dados, metodologia de coleta e de garantia da segurança, análise de riscos (probabilidade e
gravidade antes/depois das salvaguardas), medidas e mecanismos de mitigação, e responsável pela aprovação.

| Revisor | Data | Versão | Decisão | Observações |
|---|---|---|---|---|
| _pendente_ | _pendente_ | _pendente_ | _pendente_ | Proprietário: confirmar a avaliação do §1. |
