from pathlib import Path
import json, hashlib, zipfile, sys

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'products'/'releases'/'v2.1'
BASE=['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011']
errors=[]; report={}

required_docs=['INICIAR-AQUI.html','CHECKLIST-IMPLEMENTACAO.md','PROJETO-FINAL.md','AVALIACAO-PRATICA.md','FAQ.md','GLOSSARIO.md','SUPORTE-E-TROUBLESHOOTING.md','CHANGELOG.md','REFERENCIAS.md','TERMOS.txt']
required_tools=['LEIA-ME.md','plano-acao.csv','plano-acao-EXEMPLO.csv','registro-experimentos.csv','registro-experimentos-EXEMPLO.csv','controle-decisoes.csv','controle-decisoes-EXEMPLO.csv','scorecard-semanal.csv','scorecard-semanal-EXEMPLO.csv']
master_markers=['## Camada Master/Sênior','### Caso-limite','### Rubrica 100/100','### Desafio de domínio']

for sku in BASE:
    work=OUT/sku
    manifest=json.loads((work/'manifest.json').read_text(encoding='utf-8'))
    modules=sorted((work/'modulos').glob('*.md'))
    if manifest.get('version')!='2.1': errors.append(f'{sku}:version')
    if manifest.get('quality_profile')!='master_senior_content_v21': errors.append(f'{sku}:profile')
    if manifest.get('master_gate')!='100_of_100': errors.append(f'{sku}:master_gate')
    if len(modules)!=5: errors.append(f'{sku}:module_count')
    sizes=[len(p.read_text(encoding='utf-8')) for p in modules]
    if not sizes or min(sizes)<2000: errors.append(f'{sku}:module_depth:{min(sizes) if sizes else 0}')
    for module in modules:
        text=module.read_text(encoding='utf-8')
        for marker in master_markers:
            if marker not in text: errors.append(f'{sku}:{module.name}:missing:{marker}')
    for rel in required_docs:
        if not (work/rel).is_file(): errors.append(f'{sku}:missing:{rel}')
    for rel in required_tools:
        if not (work/'ferramentas'/rel).is_file(): errors.append(f'{sku}:missing_tool:{rel}')
    project=(work/'PROJETO-FINAL.md').read_text(encoding='utf-8')
    assessment=(work/'AVALIACAO-PRATICA.md').read_text(encoding='utf-8')
    if '100/100' not in project or '20.' not in project: errors.append(f'{sku}:project_gate')
    if '100/100' not in assessment or '10.' not in assessment: errors.append(f'{sku}:assessment_gate')
    reader=(work/'INICIAR-AQUI.html').read_text(encoding='utf-8')
    for marker in ['lang="pt-BR"','name="viewport"','class="skip"','aria-label="Documentos"','@media print','100/100']:
        if marker not in reader: errors.append(f'{sku}:reader:{marker}')
    if '<script' in reader.lower() or 'http://' in reader.lower() or 'https://' in reader.lower(): errors.append(f'{sku}:reader_external')
    refs=(work/'REFERENCIAS.md').read_text(encoding='utf-8')
    min_refs=4 if sku=='ZEV-IA-011' else 2
    if refs.count('https://')<min_refs: errors.append(f'{sku}:references')
    report[sku]={'modules':len(modules),'min_module_chars':min(sizes),'files':sum(1 for p in work.rglob('*') if p.is_file()),'master_gate':'100/100'}

build=json.loads((OUT/'build-manifest.json').read_text(encoding='utf-8'))
if build.get('version')!='2.1' or build.get('quality_profile')!='master_senior_content_v21': errors.append('build_manifest_profile')
for sku,meta in build['products'].items():
    z=Path(meta['path'])
    actual=hashlib.sha256(z.read_bytes()).hexdigest()
    if actual!=meta['sha256']: errors.append(f'{sku}:hash')
    with zipfile.ZipFile(z) as arc:
        names=arc.namelist()
        if len(names)!=meta['file_count']: errors.append(f'{sku}:zip_count')
        if any(n.startswith('/') or '..' in Path(n).parts for n in names): errors.append(f'{sku}:unsafe_zip')
    report.setdefault(sku,{})['sha256']=actual
for sku,parts in {'ZEV-CMB-011':['ZEV-IA-011','ZEV-VEN-011'],'ZEV-NGC-011':['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011']}.items():
    work=OUT/sku
    manifest=json.loads((work/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('version')!='2.1' or manifest.get('master_gate')!='100_of_100': errors.append(f'{sku}:bundle_profile')
    for part in parts:
        child=work/'conteudos'/part
        if not (child/'PROJETO-FINAL.md').is_file() or not (child/'AVALIACAO-PRATICA.md').is_file(): errors.append(f'{sku}:missing_master_part:{part}')
        cm=json.loads((child/'manifest.json').read_text(encoding='utf-8'))
        if cm.get('version')!='2.1': errors.append(f'{sku}:stale_part:{part}')
    if not (work/'PROJETO-FINAL.md').is_file() or not (work/'AVALIACAO-PRATICA.md').is_file(): errors.append(f'{sku}:bundle_gate_docs')
    reader=(work/'INICIAR-AQUI.html').read_text(encoding='utf-8')
    if '<script' in reader.lower() or '100/100' not in reader: errors.append(f'{sku}:bundle_reader')

status='PASS' if not errors else 'FAIL'
print(json.dumps({'status':status,'errors':errors,'report':report},ensure_ascii=False,indent=2))
sys.exit(0 if not errors else 1)
