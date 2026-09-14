from pathlib import Path
import argparse, json, sys

ROOT=Path(__file__).resolve().parents[1]
REL=ROOT/'products'/'releases'
WORK=ROOT/'products'/'workspaces'
POLICY=json.loads((REL/'evolution-policy.json').read_text(encoding='utf-8'))

p=argparse.ArgumentParser()
p.add_argument('--version',required=True)
a=p.parse_args()
workspace=WORK/f'v{a.version}'
errors=[]; checks=[]

def check(name, condition):
    checks.append({'check':name,'pass':bool(condition)})
    if not condition: errors.append(name)

check('workspace_exists',workspace.is_dir())
plan_path=workspace/'EVOLUTION-PLAN.json'
check('plan_exists',plan_path.is_file())
plan=json.loads(plan_path.read_text(encoding='utf-8')) if plan_path.is_file() else {}
check('target_matches',plan.get('to_version')==a.version)
check('source_is_current',plan.get('from_version')==POLICY['current_version'])
check('rollback_is_current',plan.get('rollback_target')==POLICY['current_version'])
check('sales_fail_closed_gate','sales_fail_closed' in plan.get('required_gates',[]))
evidence_dir=workspace/'evidence'
for name in POLICY['promotion_evidence']:
    item=evidence_dir/name
    check(f'evidence_exists:{name}',item.is_file())
    if not item.is_file(): continue
    text=item.read_text(encoding='utf-8').strip()
    if name.endswith('.json'):
        try: data=json.loads(text)
        except Exception: data={}
        if name=='artifact-manifest.json':
            products=data.get('products',{})
            valid=set(products)==set(POLICY['product_skus']) and all(
                isinstance(v,dict) and len(v.get('sha256',''))==64 for v in products.values())
            check(f'evidence_valid:{name}',valid)
        else:
            check(f'evidence_valid:{name}',data.get('status')=='PASS')
    else:
        check(f'evidence_valid:{name}',len(text)>=120 and 'pending evidence' not in text.lower())

status='PASS' if not errors else 'BLOCKED'
print(json.dumps({'status':status,'version':a.version,'checks':checks,'errors':errors},indent=2))
sys.exit(0 if not errors else 1)
