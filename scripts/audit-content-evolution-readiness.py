from pathlib import Path, PurePosixPath
import hashlib, json, os, subprocess, sys

OVERRIDE=os.environ.get('ZEVANORY_ROOT_OVERRIDE')
ROOT=Path(OVERRIDE or Path(__file__).resolve().parents[1])
REL=ROOT/'products'/'releases'
POLICY=json.loads((REL/'evolution-policy.json').read_text(encoding='utf-8'))
LOCK=json.loads((REL/'release-lock.json').read_text(encoding='utf-8'))
CAT=(ROOT/'src'/'offerCatalog.mjs').read_text(encoding='utf-8')
errors=[]; checks=[]
TEXT_EXT={'.md','.txt','.json','.py','.mjs','.js','.ts','.html','.css','.yml','.yaml','.csv','.xml'}

def ok(name, condition, detail=''):
    checks.append({'check':name,'pass':bool(condition),'detail':detail})
    if not condition: errors.append(name)

def canonical_bytes(p):
    data=p.read_bytes()
    if p.suffix.lower() in TEXT_EXT:
        data=data.replace(b'\r\n',b'\n').replace(b'\r',b'\n')
    return data

def fingerprint(path):
    h=hashlib.sha256(); count=0
    for p in sorted(x for x in path.rglob('*') if x.is_file()):
        rel=p.relative_to(path).as_posix(); data=canonical_bytes(p)
        h.update(rel.encode()); h.update(b'\0'); h.update(data); count+=1
    return h.hexdigest(),count

def git_output(*args):
    return subprocess.run(['git',*args],cwd=ROOT,capture_output=True,text=True,check=False)

def artifact_name(value):
    return PurePosixPath(str(value).replace('\\','/')).name

current=POLICY['current_version']; versions=POLICY['immutable_versions']
ok('policy_schema',POLICY.get('schema_version')==2)
ok('lock_schema',LOCK.get('schema_version')==3)
ok('lock_mode',LOCK.get('fingerprint_mode')=='git_tree_oid_primary_portable_sha256_fallback')
ok('quality_gate',POLICY['quality_gate']=={'excellence_percent':100,'confidence_min_percent':99,'level':'MASTER_SENIOR'})
ok('version_order',versions==sorted(versions,key=lambda v:tuple(map(int,v.split('.')))))
ok('current_is_latest',current==versions[-1])
ok('promotion_gate_script_exists',(ROOT/'scripts'/'audit-content-promotion-readiness.py').is_file())
for version in versions:
    release=REL/f'v{version}'; expected=LOCK['releases'].get(version,{})
    if OVERRIDE:
        digest,count=fingerprint(release)
        passed=release.is_dir() and digest==expected.get('portable_sha256') and count==expected.get('file_count')
        ok(f'immutable_v{version}',passed,digest)
    else:
        tree=git_output('rev-parse',f'HEAD:products/releases/v{version}')
        dirty=git_output('status','--porcelain','--',f'products/releases/v{version}')
        oid=tree.stdout.strip() if tree.returncode==0 else ''
        passed=release.is_dir() and oid==expected.get('git_tree_oid') and not dirty.stdout.strip()
        ok(f'immutable_v{version}',passed,oid)
manifest=json.loads((REL/f'v{current}'/'build-manifest.json').read_text(encoding='utf-8'))
ok('current_manifest_version',manifest.get('version')==current)
ok('sku_set',set(manifest.get('products',{}))==set(POLICY['product_skus']))
for sku,meta in manifest.get('products',{}).items():
    artifact=REL/f'v{current}'/artifact_name(meta['path'])
    digest=hashlib.sha256(artifact.read_bytes()).hexdigest() if artifact.is_file() else ''
    ok(f'artifact_hash_{sku}',digest==meta.get('sha256'),digest)
    segment=next((line for line in CAT.splitlines() if f"sku:'{sku}'" in line),'')
    ok(f'catalog_version_{sku}',f"version:'{current}'" in segment)
    ok(f'catalog_hash_{sku}',meta.get('sha256','') in segment)
    ok(f'fail_closed_{sku}',"sellable:false" in segment and "quality_certified:false" in segment)
rules=POLICY.get('release_rules',{})
required=['never_overwrite_certified_release','new_release_must_use_new_directory','evolution_must_start_from_current_version','workspace_creation_must_be_atomic','catalog_switch_requires_exact_hash_match','rollback_target_required','backward_compatibility_review_required','migration_plan_required','deprecation_plan_required_for_breaking_change','dry_run_required_before_materialization','certified_release_audit_must_be_non_destructive','promotion_requires_evidence_bundle','sales_gate_must_remain_fail_closed']
ok('all_evolution_rules_enforced',all(rules.get(k) is True for k in required))
ok('promotion_evidence_complete',set(POLICY.get('promotion_evidence',[]))=={'compatibility-report.json','migration-plan.md','rollback-plan.md','deprecation-plan.md','regression-report.json','artifact-manifest.json'})
status='PASS' if not errors else 'FAIL'
print(json.dumps({'status':status,'current_version':current,'checks':checks,'errors':errors},indent=2))
sys.exit(0 if not errors else 1)
