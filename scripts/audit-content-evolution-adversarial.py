from pathlib import Path
import hashlib, json, os, shutil, subprocess, sys, tempfile

ROOT=Path(__file__).resolve().parents[1]
AUDIT=ROOT/'scripts'/'audit-content-evolution-readiness.py'
TEXT_EXT={'.md','.txt','.json','.py','.mjs','.js','.ts','.html','.css','.yml','.yaml','.csv','.xml'}

def run(root):
    env=os.environ.copy(); env['ZEVANORY_ROOT_OVERRIDE']=str(root)
    return subprocess.run([sys.executable,str(AUDIT)],env=env,capture_output=True,text=True)

def run_real():
    env=os.environ.copy(); env.pop('ZEVANORY_ROOT_OVERRIDE',None)
    return subprocess.run([sys.executable,str(AUDIT)],env=env,capture_output=True,text=True)

def canonical_bytes(p):
    data=p.read_bytes()
    if p.suffix.lower() in TEXT_EXT:
        data=data.replace(b'\r\n',b'\n').replace(b'\r',b'\n')
    return data

def fingerprint(path):
    h=hashlib.sha256(); count=0
    for p in sorted(x for x in path.rglob('*') if x.is_file()):
        rel=p.relative_to(path).as_posix()
        h.update(rel.encode()); h.update(b'\0'); h.update(canonical_bytes(p)); count+=1
    return h.hexdigest(),count

def fixture():
    tmp=Path(tempfile.mkdtemp(prefix='zev-evolution-audit-'))
    shutil.copytree(ROOT/'products'/'releases',tmp/'products'/'releases')
    (tmp/'src').mkdir(parents=True)
    shutil.copy2(ROOT/'src'/'offerCatalog.mjs',tmp/'src'/'offerCatalog.mjs')
    (tmp/'scripts').mkdir(parents=True)
    shutil.copy2(ROOT/'scripts'/'audit-content-promotion-readiness.py',tmp/'scripts'/'audit-content-promotion-readiness.py')
    lock_path=tmp/'products'/'releases'/'release-lock.json'
    lock=json.loads(lock_path.read_text(encoding='utf-8'))
    for version,meta in lock['releases'].items():
        digest,count=fingerprint(tmp/'products'/'releases'/f'v{version}')
        meta['portable_sha256']=digest; meta['file_count']=count
    lock_path.write_text(json.dumps(lock,indent=2)+'\n',encoding='utf-8')
    return tmp

def expect_block(name, mutate):
    tmp=fixture()
    try:
        mutate(tmp)
        result=run(tmp)
        if result.returncode==0:
            raise SystemExit(f'{name}: expected BLOCKED but audit passed')
        print(f'{name}=PASS')
    finally:
        shutil.rmtree(tmp,ignore_errors=True)

def mutate_release(tmp):
    p=tmp/'products'/'releases'/'v2.1'/'ZEV-IA-011'/'README.md'
    p.write_text(p.read_text(encoding='utf-8')+'\nTAMPER\n',encoding='utf-8')

def mutate_catalog(tmp):
    p=tmp/'src'/'offerCatalog.mjs'
    text=p.read_text(encoding='utf-8').replace('sellable:false','sellable:true',1)
    p.write_text(text,encoding='utf-8')

def mutate_policy(tmp):
    p=tmp/'products'/'releases'/'evolution-policy.json'
    text=p.read_text(encoding='utf-8').replace('"rollback_target_required": true','"rollback_target_required": false')
    p.write_text(text,encoding='utf-8')

def mutate_promotion_gate(tmp):
    (tmp/'scripts'/'audit-content-promotion-readiness.py').unlink()

baseline=run_real()
if baseline.returncode!=0:
    print(baseline.stdout); print(baseline.stderr,file=sys.stderr); raise SystemExit('baseline audit failed')
print('BASELINE=PASS')
expect_block('TAMPER_RELEASE',mutate_release)
expect_block('TAMPER_CATALOG',mutate_catalog)
expect_block('TAMPER_POLICY',mutate_policy)
expect_block('MISSING_PROMOTION_GATE',mutate_promotion_gate)
print('EVOLUTION_ADVERSARIAL=4/4 PASS')
