from pathlib import Path
import argparse, json, shutil, sys

ROOT=Path(__file__).resolve().parents[1]
REL=ROOT/'products'/'releases'
WORK=ROOT/'products'/'workspaces'
POLICY=json.loads((REL/'evolution-policy.json').read_text(encoding='utf-8'))

def parse_version(value):
    try: return tuple(int(x) for x in value.split('.'))
    except Exception: raise argparse.ArgumentTypeError('version must be numeric, e.g. 2.2')

p=argparse.ArgumentParser()
p.add_argument('--from-version',required=True)
p.add_argument('--to-version',required=True)
p.add_argument('--dry-run',action='store_true')
a=p.parse_args()
source=REL/f'v{a.from_version}'
target_release=REL/f'v{a.to_version}'
target_work=WORK/f'v{a.to_version}'
errors=[]
if a.from_version!=POLICY['current_version']: errors.append('source_must_be_current_version')
if a.from_version not in POLICY['immutable_versions']: errors.append('source_not_certified')
if not source.is_dir(): errors.append('source_missing')
if parse_version(a.to_version)<=parse_version(a.from_version): errors.append('target_must_be_newer')
if target_release.exists(): errors.append('target_release_exists_refuse_overwrite')
if target_work.exists(): errors.append('target_workspace_exists_refuse_overwrite')
if errors:
    print(json.dumps({'status':'BLOCKED','errors':errors},indent=2)); sys.exit(1)
plan={
    'status':'DRY_RUN_PASS' if a.dry_run else 'WORKSPACE_CREATED',
    'from_version':a.from_version,
    'to_version':a.to_version,
    'rollback_target':a.from_version,
    'source_release':f'products/releases/v{a.from_version}',
    'workspace':f'products/workspaces/v{a.to_version}',
    'required_gates':[
        'content_quality_100','confidence_gte_99','backward_compatibility',
        'migration','rollback','deprecation_if_breaking','exact_hash',
        'reproducibility','full_regression','sales_fail_closed'
    ],
    'required_evidence':POLICY['promotion_evidence']
}
if not a.dry_run:
    WORK.mkdir(parents=True,exist_ok=True)
    try: target_work.mkdir()
    except FileExistsError:
        print(json.dumps({'status':'BLOCKED','errors':['target_workspace_race_detected']},indent=2)); sys.exit(1)
    try:
        for sku in POLICY['product_skus']: shutil.copytree(source/sku,target_work/sku)
        (target_work/'evidence').mkdir()
        (target_work/'EVOLUTION-PLAN.json').write_text(json.dumps(plan,indent=2)+'\n',encoding='utf-8')
        for name in POLICY['promotion_evidence']:
            pth=target_work/'evidence'/name
            pth.write_text('{}\n' if name.endswith('.json') else '# Pending evidence\n',encoding='utf-8')
    except Exception:
        shutil.rmtree(target_work,ignore_errors=True); raise
print(json.dumps(plan,indent=2))
