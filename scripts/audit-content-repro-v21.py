from pathlib import Path
import json, subprocess, sys
root=Path(__file__).resolve().parents[1]
manifest=root/'products/releases/v2.1/build-manifest.json'
before=json.loads(manifest.read_text(encoding='utf-8'))['products']
before={k:(v['sha256'],v['bytes'],v['file_count']) for k,v in before.items()}
run=subprocess.run([sys.executable,str(root/'scripts/build-content-products-v21.py')],cwd=root,capture_output=True,text=True)
if run.returncode:
    print(run.stdout); print(run.stderr,file=sys.stderr); raise SystemExit(run.returncode)
after=json.loads(manifest.read_text(encoding='utf-8'))['products']
after={k:(v['sha256'],v['bytes'],v['file_count']) for k,v in after.items()}
if before!=after:
    print(json.dumps({'status':'FAIL','before':before,'after':after},indent=2)); raise SystemExit(1)
print(json.dumps({'status':'PASS','reproducible_products':len(after),'artifacts':after},indent=2))
