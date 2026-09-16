from pathlib import Path
import json, hashlib, zipfile, sys

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'products'/'releases'/'v2.0'
EXPECTED={'ZEV-IA-011':5,'ZEV-VEN-011':5,'ZEV-LCX-011':5}
errors=[]; report={}

for sku, expected_modules in EXPECTED.items():
    work=OUT/sku
    manifest=json.loads((work/'manifest.json').read_text(encoding='utf-8'))
    modules=sorted((work/'modulos').glob('*.md'))
    if manifest.get('version')!='2.0' or manifest.get('sku')!=sku: errors.append(f'{sku}:manifest')
    if len(modules)!=expected_modules: errors.append(f'{sku}:module_count')
    sizes=[len(p.read_text(encoding='utf-8')) for p in modules]
    if min(sizes)<1200: errors.append(f'{sku}:module_too_small:{min(sizes)}')
    for module in modules:
        try: module.name.encode('ascii')
        except UnicodeEncodeError: errors.append(f'{sku}:non_ascii_filename:{module.name}')
    texts=[p.read_text(encoding='utf-8') for p in modules]
    normalized=['\n'.join(line for line in t.splitlines() if not line.startswith('#')) for t in texts]
    for i in range(len(normalized)):
        for j in range(i+1,len(normalized)):
            a=set(normalized[i].split()); b=set(normalized[j].split()); sim=len(a&b)/max(1,len(a|b))
            if sim>0.78: errors.append(f'{sku}:modules_too_similar:{i+1}:{j+1}:{sim:.2f}')
    required=['INICIAR-AQUI.html','CHECKLIST-IMPLEMENTACAO.md','REFERENCIAS.md','ferramentas/plano-acao.csv','ferramentas/registro-experimentos.csv','ferramentas/controle-decisoes.csv','ferramentas/scorecard-semanal.csv']
    for rel in required:
        if not (work/rel).is_file(): errors.append(f'{sku}:missing:{rel}')
    domain_terms={
      'ZEV-IA-011':['idempotência','fallback','dados','revisão humana','prompt','métrica'],
      'ZEV-VEN-011':['icp','proposta de valor','prospecção','objeções','pipeline','conversão'],
      'ZEV-LCX-011':['fluxo de caixa','margem de contribuição','ponto de equilíbrio','precificação','capital de giro','cenários'],
    }[sku]
    corpus=' '.join(texts).lower()
    for term in domain_terms:
        if term not in corpus: errors.append(f'{sku}:missing_domain_term:{term}')
    reader=(work/'INICIAR-AQUI.html').read_text(encoding='utf-8')
    if '<meta name="viewport"' not in reader: errors.append(f'{sku}:reader_not_responsive')
    if '<script' in reader.lower() or 'https://' in reader.lower() or 'http://' in reader.lower(): errors.append(f'{sku}:reader_external_or_scripted')
    if spec_name := manifest.get('product'):
        if spec_name not in reader: errors.append(f'{sku}:reader_product_name')
    report[sku]={'modules':len(modules),'min_module_chars':min(sizes),'max_module_chars':max(sizes),'domain_terms':len(domain_terms),'offline_reader':True}
build=json.loads((OUT/'build-manifest.json').read_text(encoding='utf-8'))['products']
for sku,meta in build.items():
    z=Path(meta['path'])
    actual=hashlib.sha256(z.read_bytes()).hexdigest()
    if actual!=meta['sha256']: errors.append(f'{sku}:hash_mismatch')
    with zipfile.ZipFile(z) as archive:
        names=archive.namelist()
        if len(names)!=meta['file_count']: errors.append(f'{sku}:zip_count')
        if any(n.startswith('/') or '..' in Path(n).parts for n in names): errors.append(f'{sku}:unsafe_zip_path')
    report.setdefault(sku,{})['sha256']=actual
    report[sku]['bytes']=z.stat().st_size

for sku,expected_parts in {'ZEV-CMB-011':['ZEV-IA-011','ZEV-VEN-011'],'ZEV-NGC-011':['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011']}.items():
    manifest=json.loads((OUT/sku/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('includes')!=expected_parts: errors.append(f'{sku}:bundle_manifest')
    for part in expected_parts:
        if not (OUT/sku/'conteudos'/part/'manifest.json').is_file(): errors.append(f'{sku}:missing_part:{part}')
    if not (OUT/sku/'PLANO-INTEGRADO.md').is_file(): errors.append(f'{sku}:missing_integrated_plan')
    reader=OUT/sku/'INICIAR-AQUI.html'
    if not reader.is_file(): errors.append(f'{sku}:missing_offline_reader')
    elif '<script' in reader.read_text(encoding='utf-8').lower(): errors.append(f'{sku}:scripted_reader')

status='PASS' if not errors else 'FAIL'
print(json.dumps({'status':status,'errors':errors,'report':report},ensure_ascii=False,indent=2))
sys.exit(0 if not errors else 1)
