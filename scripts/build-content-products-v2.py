from pathlib import Path
import json, hashlib, zipfile, shutil, re, unicodedata

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'products' / 'releases' / 'v2.0'
OUT.mkdir(parents=True, exist_ok=True)

COMMON_QUALITY = '''## Padrão de execução
- Trabalhe com dados reais do próprio negócio, sem inventar números.
- Defina baseline, meta, responsável, prazo e evidência antes de mudar o processo.
- Faça mudanças pequenas e reversíveis; preserve histórico e registre decisões.
- Revise semanalmente resultado, custo, tempo, risco e próxima decisão.
- Não automatize decisão financeira, jurídica, fiscal ou publicação sensível sem revisão humana apropriada.

## Critério de domínio
Você concluiu este módulo quando consegue explicar o método, preencher o exercício com dados reais, justificar a decisão tomada e apontar qual evidência faria você mudar de opinião.
'''

PRODUCTS = {
    'ZEV-IA-011': {
        'name': 'ZEVANORY IA na Prática', 'zip': 'ZEVANORY_IA_na_Pratica_v2.0.zip',
        'price_table': 197, 'price_pilot': 147,
        'promise': 'Implantar IA no trabalho real com critérios, segurança, medição e revisão humana.',
        'modules': []
    },
    'ZEV-VEN-011': {
        'name': 'ZEVANORY Vendas na Prática', 'zip': 'ZEVANORY_Vendas_na_Pratica_v2.0.zip',
        'price_table': 197, 'price_pilot': 147,
        'promise': 'Estruturar um processo comercial mensurável, do ICP ao follow-up, sem promessas irreais.',
        'modules': []
    },
    'ZEV-LCX-011': {
        'name': 'ZEVANORY Lucro & Caixa', 'zip': 'ZEVANORY_Lucro_e_Caixa_v2.0.zip',
        'price_table': 247, 'price_pilot': 197,
        'promise': 'Dar clareza sobre caixa, margem, preço, capital de giro e cenários de decisão.',
        'modules': []
    },
}
PRODUCTS['ZEV-IA-011']['modules'] = [
('Diagnóstico, casos de uso e priorização', '''## Objetivo
Escolher onde IA realmente merece entrar no processo, evitando automatizar desperdício.

## Método
1. Liste tarefas recorrentes com frequência, duração, impacto e risco.
2. Separe geração, análise, classificação, atendimento e execução.
3. Pontue cada caso de uso de 1 a 5 em impacto, repetição, disponibilidade de dados e reversibilidade.
4. Subtraia risco de erro, sensibilidade dos dados e custo de revisão.
5. Comece pelos casos de alto valor e baixo risco.

## Exemplo
Uma empresa recebe 80 contatos por semana. Resumir conversas e sugerir prioridade pode ser um bom piloto; aprovar reembolso automaticamente não é, porque envolve dinheiro e exceções.

## Exercício
Mapeie 10 tarefas, escolha 3 candidatas e documente por que 7 foram rejeitadas ou adiadas.'''),
('Prompts, contexto e critérios de aceitação', '''## Objetivo
Transformar pedidos vagos em instruções reproduzíveis e auditáveis.

## Estrutura CTCV
- **Contexto:** situação, público, restrições e dados disponíveis.
- **Tarefa:** ação concreta esperada.
- **Critérios:** o que precisa estar presente para a resposta ser útil.
- **Validação:** como conferir fatos, formato e limites antes de usar.

## Técnica
Peça saída estruturada, declare o que a IA não deve inferir e inclua exemplos apenas quando representarem o caso real. Separe fatos fornecidos de hipóteses. Para tarefas recorrentes, versione o prompt e registre alteração, motivo e resultado.

## Exercício
Reescreva três prompts usados no negócio. Para cada um, defina cinco critérios objetivos e uma condição de rejeição.'''),
('Fluxos seguros de automação com IA', '''## Objetivo
Desenhar automações que falham de forma controlada e preservam rastreabilidade.

## Arquitetura mínima
Entrada validada → classificação → geração/análise → verificação → ação permitida → log → revisão.

## Controles
- Idempotência para impedir ação duplicada.
- Timeout e fallback quando o provedor falha.
- Limite de escopo e lista de ações proibidas.
- Aprovação humana para financeiro, publicação sensível, exclusão ou alteração irreversível.
- Log contendo entrada resumida, decisão, modelo/provedor, resultado e exceção.

## Exercício
Desenhe um fluxo real do seu negócio, identifique três pontos de falha e defina o comportamento seguro para cada um.'''),
('Governança, privacidade e revisão humana', '''## Objetivo
Usar IA sem perder controle sobre dados, responsabilidade e qualidade.

## Classificação prática de dados
- Público: pode circular sem restrição relevante.
- Interno: informações operacionais que não devem ser publicadas.
- Confidencial: dados pessoais, financeiros, comerciais sensíveis ou estratégicos.

## Regras
Minimize dados enviados, remova identificadores quando possível, restrinja acesso, registre finalidade e retenção e nunca trate saída de modelo como prova factual sem verificação. Defina quem aprova cada categoria de ação e o que deve ser escalado.

## Checklist de revisão
Fato confirmado? Fonte adequada? Dado sensível necessário? Ação reversível? Existe impacto em pessoa, dinheiro, contrato ou reputação? Há log suficiente para auditoria?

## Exercício
Classifique cinco fluxos reais e determine o nível de revisão humana de cada um.'''),
('Implantação, medição e melhoria em 30 dias', '''## Objetivo
Sair do experimento solto para uma implantação controlada com evidência.

## Plano
**Dias 1–5:** baseline, riscos, caso de uso e critério de sucesso.
**Dias 6–10:** protótipo manual e conjunto de exemplos reais.
**Dias 11–15:** piloto com amostra pequena e revisão de 100% das saídas.
**Dias 16–20:** medir qualidade, tempo poupado, retrabalho e incidentes.
**Dias 21–25:** ajustar prompt, fluxo, limites e documentação.
**Dias 26–30:** decidir escalar, manter assistido ou encerrar.

## Métricas
Taxa de aceitação sem edição, taxa de erro, tempo por caso, custo por caso, retrabalho, incidentes e satisfação do operador.

## Exercício
Monte seu plano de 30 dias e declare antecipadamente qual resultado levará a escalar e qual levará a interromper.'''),
]

PRODUCTS['ZEV-VEN-011']['modules'] = [
('ICP e segmentação com evidência', '''## Objetivo
Definir quem merece esforço comercial e quem deve ser despriorizado.

## ICP operacional
Descreva segmento, porte, situação, dor observável, urgência, capacidade de compra, decisor, canal de acesso e sinais de não aderência. Não use persona decorativa: o ICP precisa mudar a prioridade da equipe.

## Segmentação
Crie no máximo quatro grupos com tratamento diferente. Uma regra simples pode combinar aderência, urgência e potencial de valor. Registre o motivo da classificação para revisar vieses.

## Exercício
Analise 20 leads ou clientes reais, classifique-os e compare conversão ou avanço por segmento.'''),
('Oferta e proposta de valor', '''## Objetivo
Traduzir produto em resultado relevante sem promessa enganosa.

## Estrutura
Para [segmento] que enfrenta [problema], oferecemos [mecanismo] para alcançar [resultado controlável], com [prova/processo] e limites claros.

## Teste de qualidade
A oferta precisa responder: por que isso importa agora, o que muda, como funciona, o que está incluído, o que não está, quanto esforço o cliente terá e qual próximo passo.

## Exercício
Escreva três versões da oferta e teste compreensão com cinco pessoas sem explicar verbalmente o texto.'''),
('Prospecção e abordagem', '''## Objetivo
Criar contato relevante, respeitoso e mensurável em vez de volume sem critério.

## Sequência
1. Pesquise um gatilho real do prospect.
2. Conecte o gatilho a uma dor compatível com sua oferta.
3. Escreva mensagem curta com contexto específico e uma pergunta simples.
4. Registre canal, data, hipótese e resposta.
5. Limite tentativas; silêncio não justifica perseguição.

## Métricas
Taxa de resposta, resposta qualificada, reunião por contato, descadastro/rejeição e tempo gasto por oportunidade.

## Exercício
Crie 10 abordagens personalizadas e compare com 10 mensagens genéricas usando o mesmo critério de resposta.'''),
('Descoberta, objeções e fechamento', '''## Objetivo
Entender o problema antes de prescrever e fechar apenas quando houver aderência.

## Descoberta
Explore situação atual, impacto, prioridade, processo de decisão, orçamento, alternativas e risco de não agir. Pergunte por exemplos concretos. Resuma o entendimento e peça confirmação.

## Objeções
Classifique como dúvida, risco, falta de valor, timing, autoridade ou recurso. Responda ao motivo real; não combata objeção com pressão.

## Fechamento
Defina próximo passo específico, responsável, prazo e condição. Se não houver aderência, encerre com clareza.

## Exercício
Revise cinco conversas comerciais e identifique onde houve pergunta insuficiente, afirmação sem prova ou próximo passo vago.'''),
('Follow-up, pipeline e métricas', '''## Objetivo
Transformar continuidade comercial em sistema previsível.

## Pipeline mínimo
Novo → Qualificado → Descoberta → Proposta → Decisão → Ganha/Perdida. Cada etapa deve ter critério de entrada e saída; “em negociação” sem critério vira estoque de esperança.

## Follow-up
Cada contato deve acrescentar contexto: resposta a dúvida, material relevante, síntese de decisão ou confirmação de prazo. Registre próxima ação e data.

## Métricas
Conversão por etapa, ciclo médio, ticket, taxa de ganho, motivo de perda, cobertura de pipeline e aging por etapa.

## Exercício
Limpe o pipeline atual, remova oportunidades sem próximo passo e calcule conversão e aging por etapa.'''),
]

PRODUCTS['ZEV-LCX-011']['modules'] = [
('Fluxo de caixa e calendário financeiro', '''## Objetivo
Enxergar quando o dinheiro entra e sai, independentemente de lucro contábil ou faturamento.

## Estrutura
Registre saldo inicial, entradas previstas/realizadas, saídas previstas/realizadas, vencimentos e saldo projetado por dia ou semana. Separe recorrente de eventual e operação de investimento.

## Rotina
Atualize realizado, reconcilie diferenças, projete 8 a 13 semanas e sinalize semanas de saldo crítico. Uma previsão útil mostra também o grau de certeza de cada entrada.

## Exercício
Monte 8 semanas de fluxo, marque as três maiores incertezas e simule atraso de 15 dias na maior entrada.'''),
('Margem de contribuição e ponto de equilíbrio', '''## Objetivo
Saber quanto cada venda contribui para pagar estrutura e gerar resultado.

## Fórmulas
Margem de contribuição unitária = preço líquido − custos e despesas variáveis.
Índice de margem = margem de contribuição ÷ preço líquido.
Ponto de equilíbrio aproximado = custos fixos ÷ índice de margem.

## Exemplo
Preço líquido R$100, variável R$60: margem R$40 e índice 40%. Com R$20.000 fixos, o ponto de equilíbrio em receita é cerca de R$50.000.

## Exercício
Calcule margem de três produtos/serviços e identifique qual vende muito mas contribui pouco.'''),
('Precificação e descontos', '''## Objetivo
Definir preço com visão de valor, custo, margem e capacidade operacional.

## Processo
1. Calcule custo variável e margem mínima aceitável.
2. Entenda referência de mercado sem copiar preço cegamente.
3. Estime valor percebido e alternativas do cliente.
4. Defina regra de desconto com limite e autoridade.
5. Meça margem realizada, não apenas preço de tabela.

## Regra de segurança
Desconto não corrige proposta de valor fraca. Toda concessão deve registrar motivo, contrapartida e impacto na margem.

## Exercício
Simule descontos de 5%, 10% e 15% e calcule quanto volume adicional seria necessário para preservar a mesma margem total.'''),
('Capital de giro e reserva', '''## Objetivo
Dimensionar a folga necessária para financiar operação e absorver variação.

## Ciclo financeiro
Observe prazo médio para receber, prazo para pagar, estoque quando houver e despesas fixas. Crescimento pode consumir caixa quando o pagamento ao fornecedor ocorre antes do recebimento do cliente.

## Reserva
Defina reserva com base em volatilidade, concentração de clientes, sazonalidade e tempo de recuperação — não por um número mágico universal.

## Exercício
Liste os cinco maiores riscos de caixa, estime impacto e tempo de recuperação e determine uma meta de liquidez coerente com o negócio.'''),
('Cenários e rotina de gestão', '''## Objetivo
Tomar decisões com faixas e cenários, não com uma única previsão tratada como certeza.

## Cenários
Construa base, conservador e favorável alterando poucos drivers: volume, preço, atraso de recebimento, custo variável e despesa fixa. Documente premissas e não misture cenários com metas.

## Reunião semanal
Revise caixa projetado, margem, contas críticas, desvios versus plano, decisões pendentes e responsáveis. Toda ação precisa ter prazo e condição de reavaliação.

## Exercício
Modele três cenários para os próximos 90 dias e identifique a decisão que muda em cada um.'''),
]

def slug(text):
    ascii_text=unicodedata.normalize('NFKD', text).encode('ascii','ignore').decode('ascii').lower()
    return re.sub(r'[^a-z0-9]+','-', ascii_text).strip('-')

def workbook_files(sku):
    return {
      'ferramentas/plano-acao.csv': 'acao,por_que,responsavel,prazo,metrica,baseline,meta,evidencia,risco,status\n',
      'ferramentas/registro-experimentos.csv': 'data,hipotese,mudanca,amostra,metrica_antes,metrica_depois,efeito,risco,decisao\n',
      'ferramentas/controle-decisoes.csv': 'data,decisao,evidencia,alternativas,risco,responsavel,revisar_em,resultado\n',
      'ferramentas/scorecard-semanal.csv': 'semana,metrica,meta,realizado,desvio,causa,acao,responsavel\n',
    }
def checklist(name):
    return f'''# Checklist de implementação — {name}

## Preparação
- [ ] Definir objetivo e resultado que pode ser medido.
- [ ] Registrar baseline antes da primeira mudança.
- [ ] Nomear responsável e prazo de revisão.
- [ ] Identificar riscos, dados sensíveis e ações irreversíveis.

## Execução
- [ ] Concluir os cinco módulos com exercício real.
- [ ] Preencher plano de ação, registro de experimentos e scorecard semanal.
- [ ] Executar ao menos uma melhoria pequena e reversível.
- [ ] Registrar evidência antes/depois e efeito colateral observado.

## Validação
- [ ] Explicar o método sem consultar o material.
- [ ] Demonstrar um caso real com dados próprios.
- [ ] Mostrar qual evidência sustentou a decisão.
- [ ] Definir o que será mantido, alterado ou descartado.
- [ ] Documentar a próxima revisão.
'''

def references(sku):
    common = ['NIST AI Risk Management Framework (AI RMF 1.0) — https://www.nist.gov/itl/ai-risk-management-framework'] if sku == 'ZEV-IA-011' else []
    if sku == 'ZEV-IA-011': common.append('ANPD — Guias e orientações sobre proteção de dados — https://www.gov.br/anpd/')
    if sku in {'ZEV-VEN-011','ZEV-LCX-011'}: common.append('Sebrae — conteúdos de gestão empresarial — https://sebrae.com.br/')
    return '# Referências de aprofundamento\n\n' + '\n'.join(f'- {x}' for x in common) + '\n\nAs referências servem para aprofundamento. O material não substitui aconselhamento jurídico, contábil ou financeiro profissional quando aplicável.\n'

def html_reader(spec, sku):
    cards=[]
    for i,(title,body) in enumerate(spec['modules'],1):
        summary=next((line.strip() for line in body.splitlines() if line.strip() and not line.startswith('#')), '')
        cards.append(f'<li><strong>Módulo {i}: {title}</strong><span>{summary}</span></li>')
    return f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{spec["name"]} v2.0</title><style>
:root{{font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827;background:#f6f7f9}}*{{box-sizing:border-box}}body{{margin:0}}main{{max-width:980px;margin:auto;padding:40px 24px 64px}}header{{background:#111827;color:white;padding:32px;border-radius:18px}}h1{{margin:0 0 10px;font-size:clamp(28px,5vw,46px)}}.tag{{opacity:.8}}.promise{{font-size:18px;line-height:1.6;max-width:760px}}section{{background:white;margin-top:22px;padding:26px;border:1px solid #e5e7eb;border-radius:16px}}ol{{padding-left:24px}}li{{margin:18px 0}}li span{{display:block;color:#4b5563;margin-top:5px;line-height:1.5}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}}.tool{{border:1px solid #e5e7eb;border-radius:12px;padding:14px}}footer{{margin-top:24px;color:#6b7280;font-size:14px}}@media(max-width:560px){{main{{padding:20px 14px}}header,section{{padding:20px}}}}</style></head><body><main><header><div class="tag">ZEVANORY · SKU {sku} · v2.0</div><h1>{spec["name"]}</h1><p class="promise">{spec["promise"]}</p></header><section><h2>Como usar</h2><ol>{''.join(cards)}</ol><p>Abra os arquivos da pasta <strong>modulos</strong> na ordem. Aplique cada exercício em um caso real antes de avançar.</p></section><section><h2>Ferramentas práticas</h2><div class="grid"><div class="tool">Plano de ação</div><div class="tool">Registro de experimentos</div><div class="tool">Controle de decisões</div><div class="tool">Scorecard semanal</div></div></section><section><h2>Critério de conclusão</h2><p>Concluir não é apenas ler. É demonstrar aplicação real, evidência antes/depois, decisão justificada e próxima revisão definida.</p></section><footer>Conteúdo educacional e operacional. Consulte TERMOS.txt e REFERENCIAS.md para limites e aprofundamento.</footer></main></body></html>'''

def build_base(sku, spec):
    work = OUT / sku
    if work.exists(): shutil.rmtree(work)
    work.mkdir(parents=True)
    files = {}
    files['README.md'] = f'''# {spec['name']} — v2.0\n\n**SKU:** `{sku}`\n\n**Resultado esperado:** {spec['promise']}\n\nPercurso: diagnóstico → aplicação guiada → exercício real → medição → decisão. O produto foi reconstruído para evitar conteúdo genérico e exige evidência do próprio negócio.\n'''
    files['INICIAR-AQUI.html'] = html_reader(spec,sku)
    for i, (title, body) in enumerate(spec['modules'], 1):
        files[f'modulos/{i:02d}-{slug(title)}.md'] = f'# {spec["name"]} — Módulo {i}\n\n## {title}\n\n{body.strip()}\n\n{COMMON_QUALITY}'
    files['CHECKLIST-IMPLEMENTACAO.md'] = checklist(spec['name'])
    files['REFERENCIAS.md'] = references(sku)
    files['TERMOS.txt'] = 'Licença de uso conforme termos comerciais ZEVANORY. Conteúdo educacional e operacional; resultados dependem do contexto e da execução. Não constitui aconselhamento jurídico, contábil, financeiro ou fiscal individualizado.\n'
    files.update(workbook_files(sku))
    for rel, text in files.items():
        p=work/rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text, encoding='utf-8', newline='\n')
    manifest={'brand':'ZEVANORY','sku':sku,'product':spec['name'],'version':'2.0','files':sorted(files),'quality_profile':'elite_content_v2','placeholder':False}
    (work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
    return work, files

def deterministic_zip(work, zpath):
    with zipfile.ZipFile(zpath,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in sorted(work.rglob('*')):
            if p.is_file():
                info=zipfile.ZipInfo(str(p.relative_to(work)).replace('\\','/'),(2026,9,14,18,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=0o644<<16
                z.writestr(info,p.read_bytes())

built={}; base_dirs={}
for sku,spec in PRODUCTS.items():
    work,files=build_base(sku,spec); base_dirs[sku]=work
    zpath=OUT/spec['zip']; deterministic_zip(work,zpath)
    built[sku]={'path':str(zpath),'sha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'bytes':zpath.stat().st_size,'file_count':sum(1 for p in work.rglob('*') if p.is_file())}
COMPOSITES={
 'ZEV-CMB-011':('ZEVANORY Combo IA + Vendas','ZEVANORY_Combo_IA_e_Vendas_v2.0.zip',['ZEV-IA-011','ZEV-VEN-011']),
 'ZEV-NGC-011':('ZEVANORY Negócio Completo','ZEVANORY_Negocio_Completo_v2.0.zip',['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011']),
}

def integrated_plan(name, parts):
    return f'''# {name} — plano integrado

1. Faça o diagnóstico do processo antes de adicionar tecnologia ou volume comercial.
2. Defina ICP, oferta e critérios de qualificação antes de automatizar prospecção.
3. Use IA primeiro como assistência mensurável; automatize somente após estabilidade.
4. Conecte decisão comercial a margem, caixa e capacidade de entrega.
5. Revise semanalmente conversão, margem, caixa, retrabalho, incidentes e satisfação.
6. Mantenha uma decisão reversível sempre que a evidência ainda for insuficiente.

## Critério de conclusão
O pacote só está implementado quando os módulos-base foram aplicados a um caso real e o scorecard integrado contém métricas de processo, vendas e finanças com responsáveis e próxima revisão.
'''

for sku,(name,zipname,parts) in COMPOSITES.items():
    work=OUT/sku
    if work.exists(): shutil.rmtree(work)
    work.mkdir(parents=True)
    (work/'README.md').write_text(f'# {name} — v2.0\n\nSKU `{sku}`. Bundle operacional que reúne os produtos-base v2.0 sem substituir os respectivos exercícios e critérios de domínio.\n',encoding='utf-8',newline='\n')
    bundle_spec={'name':name,'promise':'Percurso integrado de IA, vendas e gestão com aplicação mensurável.','modules':[('Plano integrado',integrated_plan(name,parts))]}
    (work/'INICIAR-AQUI.html').write_text(html_reader(bundle_spec,sku),encoding='utf-8',newline='\n')
    (work/'PLANO-INTEGRADO.md').write_text(integrated_plan(name,parts),encoding='utf-8',newline='\n')
    (work/'ferramentas'/'scorecard-integrado.csv').parent.mkdir(parents=True,exist_ok=True)
    (work/'ferramentas'/'scorecard-integrado.csv').write_text('semana,processo,metrica_vendas,metrica_financeira,risco,acao,responsavel,proxima_revisao\n',encoding='utf-8',newline='\n')
    for part in parts: shutil.copytree(base_dirs[part],work/'conteudos'/part)
    manifest={'brand':'ZEVANORY','sku':sku,'product':name,'version':'2.0','includes':parts,'quality_profile':'elite_content_v2','placeholder':False}
    (work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
    zpath=OUT/zipname; deterministic_zip(work,zpath)
    built[sku]={'path':str(zpath),'sha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'bytes':zpath.stat().st_size,'file_count':sum(1 for p in work.rglob('*') if p.is_file())}

(OUT/'build-manifest.json').write_text(json.dumps({'version':'2.0','products':built},ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
print(json.dumps(built,ensure_ascii=False,indent=2))
