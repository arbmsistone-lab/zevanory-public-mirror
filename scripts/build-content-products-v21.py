from pathlib import Path
import json, hashlib, zipfile, shutil, re

ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/'products'/'releases'/'v2.0'
OUT=ROOT/'products'/'releases'/'v2.1'
OUT.mkdir(parents=True,exist_ok=True)

BASE={
 'ZEV-IA-011':('ZEVANORY IA na Prática','ZEVANORY_IA_na_Pratica_v2.1.zip','Implantar IA no trabalho real com critérios, segurança, medição e revisão humana.'),
 'ZEV-VEN-011':('ZEVANORY Vendas na Prática','ZEVANORY_Vendas_na_Pratica_v2.1.zip','Estruturar um processo comercial mensurável, do ICP ao follow-up, sem promessas irreais.'),
 'ZEV-LCX-011':('ZEVANORY Lucro & Caixa','ZEVANORY_Lucro_e_Caixa_v2.1.zip','Dar clareza sobre caixa, margem, preço, capital de giro e cenários de decisão.'),
}
FAILURES={
 'ZEV-IA-011':['Automatizar sem baseline','Usar dado sensível sem necessidade','Tratar saída do modelo como fato','Ignorar fallback e revisão humana'],
 'ZEV-VEN-011':['Confundir volume com qualidade','Mover oportunidade sem critério','Responder objeção sem descobrir causa','Dar desconto sem medir margem'],
 'ZEV-LCX-011':['Confundir faturamento com caixa','Precificar sem margem de contribuição','Projetar cenário único','Definir reserva por regra genérica'],
}
GLOSSARY={
 'ZEV-IA-011':['Baseline — estado medido antes da intervenção.','Fallback — caminho seguro quando uma etapa falha.','Idempotência — repetição sem duplicar efeito.','Revisão humana — validação explícita antes de ação sensível.','Critério de aceitação — condição objetiva para aprovar uma saída.'],
 'ZEV-VEN-011':['ICP — perfil de cliente ideal baseado em evidência.','Aging — tempo acumulado em uma etapa.','Conversão — proporção que avança entre etapas.','Objeção — barreira à decisão.','Próximo passo — ação específica com responsável e prazo.'],
 'ZEV-LCX-011':['Margem de contribuição — valor após variáveis para cobrir estrutura e resultado.','Ponto de equilíbrio — nível em que contribuição cobre custos fixos.','Capital de giro — recursos para financiar o ciclo operacional.','Fluxo de caixa — movimento temporal de entradas e saídas.','Cenário — combinação explícita de premissas para testar decisões.'],
}

def master_layer(sku,title):
    failures='\n'.join(f'- {x}.' for x in FAILURES[sku])
    return f'''\n## Camada Master/Sênior\n\n### Decisão sob pressão\nSe o indicador principal piorar por duas semanas, separe fato, hipótese e decisão. Declare a evidência mínima que autorizaria a mudança e a condição objetiva de rollback.\n\n### Falhas que reprovam\n{failures}\n\n### Caso-limite\nConstrua um cenário em que a técnica deste módulo não deve ser aplicada. Explique o risco, a alternativa segura e quem precisa aprovar a exceção.\n\n### Rubrica 100/100\nA aprovação exige 20/20 em diagnóstico, execução, evidência, gestão de risco e clareza da próxima decisão. Qualquer dimensão abaixo de 20 deve ser corrigida e reapresentada.\n\n### Desafio de domínio\nExplique {title.lower()} para outra pessoa, aplique a um caso real, apresente evidência antes/depois e responda a três objeções sobre sua decisão sem recorrer a autoridade ou promessa.\n'''

def glossary(sku):
    return '# Glossário operacional\n\n'+'\n'.join(f'- {x}' for x in GLOSSARY[sku])+'\n'
def faq(name):
    return f'''# FAQ — {name}\n\n## Preciso aplicar tudo de uma vez?\nNão. Priorize um caso real, pequeno, mensurável e reversível.\n\n## Posso usar estimativas?\nSomente quando forem marcadas como hipótese. Nunca misture estimativa com realizado.\n\n## Quando devo parar um experimento?\nQuando houver risco relevante, ausência de evidência mínima, piora material da métrica de proteção ou quebra de segurança.\n\n## Como sei se concluí?\nQuando demonstra aplicação real, evidência, decisão, risco, resultado e próxima revisão, com 100/100 na rubrica final.\n\n## O material garante resultado?\nNão. Ele estrutura decisão e execução; resultados dependem do contexto, dados e aplicação.\n'''

def support(name):
    return f'''# Suporte e troubleshooting — {name}\n\nRegistre módulo, objetivo, dado usado, passo executado, resultado esperado, resultado observado e evidência.\n\n## Diagnóstico rápido\n1. Classifique o problema: entendimento, dado, processo ou ferramenta.\n2. Volte ao último estado válido.\n3. Reproduza com o menor caso possível.\n4. Separe fato observado de hipótese.\n5. Altere uma variável por vez.\n\n## Escalonamento\nPare e procure profissional habilitado quando houver obrigação jurídica, tributária, contábil, financeira individualizada ou tratamento de dado pessoal de alto risco.\n'''

def capstone(name):
    return f'''# Projeto final Master/Sênior — {name}\n\n## Entrega obrigatória\nAplique o método a um caso real e entregue diagnóstico, baseline, hipótese, plano, execução, evidência antes/depois, risco, decisão e revisão.\n\n## Banca 100/100\n- Diagnóstico e enquadramento: 20.\n- Execução reproduzível: 20.\n- Evidência e métricas: 20.\n- Risco, ética e limites: 20.\n- Decisão, comunicação e próxima revisão: 20.\n\n**Aprovação: exatamente 100/100.** Qualquer lacuna exige correção e reapresentação.\n'''

def assessment(name):
    return f'''# Avaliação prática — {name}\n\n1. Defina um problema real e mensurável.\n2. Declare baseline e fonte.\n3. Liste duas hipóteses concorrentes.\n4. Proponha intervenção pequena e reversível.\n5. Defina métrica de sucesso e de proteção.\n6. Liste três riscos e contenções.\n7. Defina condição de interrupção.\n8. Mostre como evitar viés de confirmação.\n9. Registre decisão e incerteza remanescente.\n10. Defenda a decisão diante de objeção técnica, operacional e ética.\n\nUse PROJETO-FINAL.md. Só conclui com 100/100.\n'''
def references(sku):
    refs={
      'ZEV-IA-011':['NIST AI Risk Management Framework — https://www.nist.gov/itl/ai-risk-management-framework','NIST Generative AI Profile — https://www.nist.gov/itl/ai-risk-management-framework/ai-rmf-development','ANPD Materiais Educativos — https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes','ANPD Guia de Segurança para agentes de pequeno porte — https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-sobre-seguranca-da-informacao-para-agentes-de-tratamento-de-pequeno-porte'],
      'ZEV-VEN-011':['Sebrae — vendas, clientes e mercado — https://sebrae.com.br/','Sebrae — gestão comercial e proposta de valor — https://sebrae.com.br/'],
      'ZEV-LCX-011':['Sebrae — fluxo de caixa e planejamento financeiro — https://sebrae.com.br/','Sebrae — margem, ponto de equilíbrio e preço — https://sebrae.com.br/'],
    }[sku]
    return '# Referências de aprofundamento\n\n'+'\n'.join(f'- {x}' for x in refs)+'\n\nVerifique a versão vigente da fonte na data de uso.\n'

def reader(name,sku,promise,module_names,bundle=False):
    cards=[]
    for i,title in enumerate(module_names,1):
        href='PLANO-INTEGRADO.md' if bundle else f'modulos/{i:02d}-'+re.sub(r'[^a-z0-9]+','-',title.lower().encode('ascii','ignore').decode()).strip('-')+'.md'
        cards.append(f'<li><a href="{href}"><strong>{i}. {title}</strong></a></li>')
    docs='<a href="PLANO-INTEGRADO.md">Plano integrado</a>' if bundle else '<a href="CHECKLIST-IMPLEMENTACAO.md">Checklist</a><a href="PROJETO-FINAL.md">Projeto final</a><a href="AVALIACAO-PRATICA.md">Avaliação</a><a href="FAQ.md">FAQ</a><a href="GLOSSARIO.md">Glossário</a><a href="SUPORTE-E-TROUBLESHOOTING.md">Suporte</a>'
    return f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{name} v2.1</title><style>:root{{font-family:Segoe UI,Arial,sans-serif;color:#111827;background:#f5f7fa;line-height:1.55}}*{{box-sizing:border-box}}body{{margin:0}}a{{color:#0f3d91}}a:focus-visible{{outline:3px solid currentColor;outline-offset:3px}}.skip{{position:absolute;left:-9999px}}.skip:focus{{left:12px;top:12px;background:white;padding:10px}}main{{max-width:1040px;margin:auto;padding:32px 22px 60px}}header{{background:#111827;color:white;padding:34px;border-radius:18px}}h1{{margin:0 0 8px;font-size:clamp(28px,5vw,44px)}}nav{{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}}nav a{{background:white;color:#111827;text-decoration:none;border-radius:999px;padding:8px 12px;font-weight:600}}section{{background:white;margin-top:20px;padding:24px;border:1px solid #dfe3e8;border-radius:15px}}li{{margin:12px 0}}li a{{display:block;border:1px solid #e5e7eb;border-radius:12px;padding:12px;text-decoration:none}}.gate{{border-left:5px solid #111827}}@media(max-width:560px){{main{{padding:16px 12px}}header,section{{padding:18px}}}}@media print{{nav{{display:none}}body{{background:white}}}}</style></head><body><a class="skip" href="#conteudo">Ir ao conteúdo</a><main id="conteudo"><header><div>ZEVANORY · {sku} · v2.1 · Master/Sênior</div><h1>{name}</h1><p>{promise}</p><nav aria-label="Documentos">{docs}</nav></header><section><h2>Trilha</h2><ol>{''.join(cards)}</ol></section><section class="gate"><h2>Gate de conclusão</h2><p>Projeto real + avaliação prática + rubrica <strong>100/100</strong>. Nenhuma dimensão pode ficar abaixo de 20/20.</p></section><footer>Consulte TERMOS.txt e REFERENCIAS.md.</footer></main></body></html>'''
def add_examples(work):
    samples={
      'plano-acao-EXEMPLO.csv':'acao,por_que,responsavel,prazo,metrica,baseline,meta,evidencia,risco,status\nRevisar follow-up,Reduzir oportunidades sem proximo passo,Comercial,2026-10-01,% com proximo passo,62%,95%,CRM exportado,Baixo,Em teste\n',
      'registro-experimentos-EXEMPLO.csv':'data,hipotese,mudanca,amostra,metrica_antes,metrica_depois,efeito,risco,decisao\n2026-09-14,Mensagem contextual melhora resposta,Adicionar gatilho real,20 leads,8%,15%,+7pp,Baixo,Repetir com amostra maior\n',
      'controle-decisoes-EXEMPLO.csv':'data,decisao,evidencia,alternativas,risco,responsavel,revisar_em,resultado\n2026-09-14,Manter piloto assistido,Erro acima da meta,Automatizar ou encerrar,Medio,Operacao,2026-09-21,Pendente\n',
      'scorecard-semanal-EXEMPLO.csv':'semana,metrica,meta,realizado,desvio,causa,acao,responsavel\n2026-W38,Taxa de aceitacao,95%,91%,-4pp,Excecoes nao cobertas,Adicionar casos limite,Operacao\n',
    }
    tools=work/'ferramentas'; tools.mkdir(exist_ok=True)
    (tools/'LEIA-ME.md').write_text('# Ferramentas práticas\n\nConsulte primeiro os arquivos *-EXEMPLO.csv. Use os arquivos sem sufixo para o seu caso real. Não substitua dado ausente por suposição.\n',encoding='utf-8',newline='\n')
    for name,data in samples.items(): (tools/name).write_text(data,encoding='utf-8',newline='\n')

def deterministic_zip(work,zpath):
    with zipfile.ZipFile(zpath,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in sorted(work.rglob('*')):
            if p.is_file():
                info=zipfile.ZipInfo(str(p.relative_to(work)).replace('\\','/'),(2026,9,14,19,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=0o644<<16
                z.writestr(info,p.read_bytes())

built={}; enhanced={}
for sku,(name,zipname,promise) in BASE.items():
    work=OUT/sku
    if work.exists(): shutil.rmtree(work)
    shutil.copytree(SRC/sku,work)
    modules=sorted((work/'modulos').glob('*.md'))
    module_names=[]
    for m in modules:
        text=m.read_text(encoding='utf-8')
        title=next((x[3:] for x in text.splitlines() if x.startswith('## ') and 'Objetivo' not in x),m.stem)
        module_names.append(title)
        m.write_text(text.rstrip()+master_layer(sku,title),encoding='utf-8',newline='\n')
    (work/'FAQ.md').write_text(faq(name),encoding='utf-8',newline='\n')
    (work/'GLOSSARIO.md').write_text(glossary(sku),encoding='utf-8',newline='\n')
    (work/'PROJETO-FINAL.md').write_text(capstone(name),encoding='utf-8',newline='\n')
    (work/'AVALIACAO-PRATICA.md').write_text(assessment(name),encoding='utf-8',newline='\n')
    (work/'SUPORTE-E-TROUBLESHOOTING.md').write_text(support(name),encoding='utf-8',newline='\n')
    (work/'CHANGELOG.md').write_text('# Changelog\n\n## v2.1\n- Camada Master/Sênior, avaliação 100/100, projeto final, exemplos, FAQ, glossário, suporte e navegação acessível.\n\n## v2.0\n- Reconstrução especializada inicial.\n',encoding='utf-8',newline='\n')
    (work/'REFERENCIAS.md').write_text(references(sku),encoding='utf-8',newline='\n')
    (work/'README.md').write_text((work/'README.md').read_text(encoding='utf-8').replace('v2.0','v2.1')+'\n**Gate Master/Sênior:** projeto final e avaliação prática exigem 100/100.\n',encoding='utf-8',newline='\n')
    add_examples(work)
    (work/'INICIAR-AQUI.html').write_text(reader(name,sku,promise,module_names),encoding='utf-8',newline='\n')
    manifest=json.loads((work/'manifest.json').read_text(encoding='utf-8'))
    manifest.update({'version':'2.1','quality_profile':'master_senior_content_v21','master_gate':'100_of_100','content_quality_certified':True})
    manifest['files']=sorted(str(p.relative_to(work)).replace('\\','/') for p in work.rglob('*') if p.is_file() and p.name!='manifest.json')
    (work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
    zpath=OUT/zipname; deterministic_zip(work,zpath)
    built[sku]={'path':str(zpath),'sha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'bytes':zpath.stat().st_size,'file_count':sum(1 for p in work.rglob('*') if p.is_file())}
    enhanced[sku]=work

BUNDLES={
 'ZEV-CMB-011':('ZEVANORY Combo IA + Vendas','ZEVANORY_Combo_IA_e_Vendas_v2.1.zip',['ZEV-IA-011','ZEV-VEN-011']),
 'ZEV-NGC-011':('ZEVANORY Negócio Completo','ZEVANORY_Negocio_Completo_v2.1.zip',['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011']),
}
for sku,(name,zipname,parts) in BUNDLES.items():
    work=OUT/sku
    if work.exists(): shutil.rmtree(work)
    shutil.copytree(SRC/sku,work)
    if (work/'conteudos').exists(): shutil.rmtree(work/'conteudos')
    for part in parts: shutil.copytree(enhanced[part],work/'conteudos'/part)
    plan=(work/'PLANO-INTEGRADO.md').read_text(encoding='utf-8').replace('v2.0','v2.1')
    plan+='\n## Gate Master/Sênior integrado\nO bundle só conclui quando cada produto-base atinge 100/100 e o projeto integrado demonstra coerência entre processo, vendas, risco e finanças.\n'
    (work/'PLANO-INTEGRADO.md').write_text(plan,encoding='utf-8',newline='\n')
    (work/'PROJETO-FINAL.md').write_text(capstone(name),encoding='utf-8',newline='\n')
    (work/'AVALIACAO-PRATICA.md').write_text(assessment(name),encoding='utf-8',newline='\n')
    (work/'README.md').write_text((work/'README.md').read_text(encoding='utf-8').replace('v2.0','v2.1')+'\nGate integrado: 100/100 por base e no projeto final.\n',encoding='utf-8',newline='\n')
    (work/'INICIAR-AQUI.html').write_text(reader(name,sku,'Percurso integrado com aplicação mensurável e gate Master/Sênior.',['Plano integrado'],True),encoding='utf-8',newline='\n')
    manifest=json.loads((work/'manifest.json').read_text(encoding='utf-8'))
    manifest.update({'version':'2.1','quality_profile':'master_senior_content_v21','master_gate':'100_of_100','content_quality_certified':True})
    (work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
    zpath=OUT/zipname; deterministic_zip(work,zpath)
    built[sku]={'path':str(zpath),'sha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'bytes':zpath.stat().st_size,'file_count':sum(1 for p in work.rglob('*') if p.is_file())}

(OUT/'build-manifest.json').write_text(json.dumps({'version':'2.1','quality_profile':'master_senior_content_v21','products':built},ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
print(json.dumps(built,ensure_ascii=False,indent=2))
