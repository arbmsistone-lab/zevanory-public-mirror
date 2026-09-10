from pathlib import Path
import json, csv, hashlib, zipfile, shutil
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'products'/'releases'/'v1.1'
OUT.mkdir(parents=True,exist_ok=True)
PRODUCTS={
'ZEV-IA-011':('ZEVANORY IA na Prática','ZEVANORY_IA_na_Pratica_v1.1.zip',['Diagnóstico e objetivos de IA','Prompts com contexto, tarefa, critérios e validação','Fluxos seguros de automação','Governança, privacidade e revisão humana','Plano de implantação em 30 dias']),
'ZEV-VEN-011':('ZEVANORY Vendas na Prática','ZEVANORY_Vendas_na_Pratica_v1.1.zip',['ICP e segmentação','Oferta e proposta de valor','Prospecção e abordagem','Descoberta, objeções e fechamento','Follow-up e métricas comerciais']),
'ZEV-LCX-011':('ZEVANORY Lucro & Caixa','ZEVANORY_Lucro_e_Caixa_v1.1.zip',['Fluxo de caixa e calendário financeiro','Margem de contribuição e ponto de equilíbrio','Precificação e descontos','Capital de giro e reserva','Cenários e rotina de gestão']),
}
def module_text(title,topic,i):
    return f'''# {title} — Módulo {i}\n\n## Objetivo\nTransformar **{topic}** em uma rotina prática, mensurável e segura para pequenos negócios.\n\n## Método ZEVANORY\n1. Defina o resultado esperado e a métrica de sucesso.\n2. Registre a situação atual antes de alterar o processo.\n3. Execute uma mudança pequena, reversível e com responsável definido.\n4. Meça resultado, custo, tempo e risco.\n5. Preserve o que funcionou e descarte hipóteses sem evidência.\n\n## Aplicação\nUse este módulo em uma situação real da empresa. Descreva o problema em uma frase, escolha um indicador, estabeleça um limite de risco e execute apenas a menor ação capaz de gerar evidência útil.\n\n## Critérios de qualidade\n- Não inventar dados, resultados ou depoimentos.\n- Não automatizar ação financeira ou publicação sensível sem gate apropriado.\n- Não confundir atividade com resultado.\n- Registrar decisão, execução e aprendizado.\n\n## Exercício\nPreencha: situação atual; objetivo; métrica; ação; responsável; prazo; risco; resultado observado; próxima decisão.\n'''

def common_files(name,sku,topics):
    files={'README.md':f'# {name}\n\nProduto digital ZEVANORY v1.1. SKU: `{sku}`.\n\nConteúdo prático para aplicação em negócios reais. Comece pelo módulo 1 e conclua o checklist final.\n'}
    for i,t in enumerate(topics,1): files[f'modulos/{i:02d}-{t.lower().replace(" ","-").replace(",","")}.md']=module_text(name,t,i)
    files['CHECKLIST-30-DIAS.md']='# Checklist de 30 dias\n\n- [ ] Definir baseline\n- [ ] Escolher uma métrica principal\n- [ ] Executar primeira melhoria controlada\n- [ ] Revisar resultados semanalmente\n- [ ] Documentar aprendizados\n- [ ] Padronizar somente o que foi comprovado\n'
    files['planilhas/plano-acao.csv']='acao,responsavel,prazo,metrica,baseline,meta,resultado,status\n,,,,,,,\n'
    files['planilhas/registro-aprendizado.csv']='data,hipotese,acao,evidencia,resultado,decisao\n,,,,,\n'
    files['TERMOS.txt']='Uso licenciado conforme os termos comerciais ZEVANORY. Conteúdo educacional; resultados dependem da execução e do contexto do usuário.\n'
    return files
built={}
for sku,(name,zipname,topics) in PRODUCTS.items():
    files=common_files(name,sku,topics)
    work=OUT/sku
    if work.exists(): shutil.rmtree(work)
    for rel,text in files.items():
        p=work/rel; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text,encoding='utf-8',newline='\n')
    manifest={'brand':'ZEVANORY','sku':sku,'product':name,'version':'1.1','files':sorted(files),'generated_from':'canonical_product_spec','placeholder':False}
    (work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
    zpath=OUT/zipname
    with zipfile.ZipFile(zpath,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in sorted(work.rglob('*')):
            if p.is_file():
                info=zipfile.ZipInfo(str(p.relative_to(work)).replace('\\','/'),(2026,9,10,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=0o644<<16
                z.writestr(info,p.read_bytes())
    built[sku]={'path':str(zpath),'sha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'bytes':zpath.stat().st_size}

# Composite products contain the actual base-product files plus their own guide.
base_dirs={sku:OUT/sku for sku in PRODUCTS}
COMPOSITES={
'ZEV-CMB-011':('ZEVANORY Combo IA + Vendas','ZEVANORY_Combo_IA_e_Vendas_v1.1.zip',['ZEV-IA-011','ZEV-VEN-011']),
'ZEV-NGC-011':('ZEVANORY Negócio Completo','ZEVANORY_Negocio_Completo_v1.1.zip',['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011']),
}
for sku,(name,zipname,parts) in COMPOSITES.items():
    work=OUT/sku
    if work.exists(): shutil.rmtree(work)
    work.mkdir(parents=True)
    (work/'README.md').write_text(f'# {name}\n\nProduto digital ZEVANORY v1.1. SKU: `{sku}`.\n\nEste pacote reúne integralmente os módulos-base indicados no manifesto e acrescenta um plano integrado de execução.\n',encoding='utf-8',newline='\n')
    (work/'PLANO-INTEGRADO.md').write_text('# Plano integrado\n\n1. Diagnostique processo e números antes de automatizar.\n2. Melhore geração e qualificação de demanda.\n3. Padronize abordagem, proposta e follow-up.\n4. Proteja margem, caixa e capital de giro.\n5. Automatize somente rotinas com regra clara, logs e revisão.\n6. Revise semanalmente conversão, margem, caixa, retenção e riscos.\n',encoding='utf-8',newline='\n')
    for part in parts:
        shutil.copytree(base_dirs[part],work/'conteudos'/part)
    manifest={'brand':'ZEVANORY','sku':sku,'product':name,'version':'1.1','includes':parts,'generated_from':'canonical_product_spec','placeholder':False}
    (work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
    zpath=OUT/zipname
    with zipfile.ZipFile(zpath,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in sorted(work.rglob('*')):
            if p.is_file():
                info=zipfile.ZipInfo(str(p.relative_to(work)).replace('\\','/'),(2026,9,10,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=0o644<<16
                z.writestr(info,p.read_bytes())
    built[sku]={'path':str(zpath),'sha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'bytes':zpath.stat().st_size}

manifest_path=OUT/'build-manifest.json'
manifest_path.write_text(json.dumps({'version':'1.1','products':built},ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
print(json.dumps(built,ensure_ascii=False,indent=2))
