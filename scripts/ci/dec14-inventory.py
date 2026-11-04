#!/usr/bin/env python3
"""DEC-14 independent inventory: static proof only, does not retire tests/mutants."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutants_conteudo_pronto as m

root = Path(__file__).resolve().parents[2]
missing=[]
duplicates=[]
present=[]
for name, (path, old, new, assertion) in m.M.items():
    mid=name.split()[0]
    source=(root/path).read_text(encoding='utf-8').replace('\r\n','\n')
    hits=source.count(old)
    item={'id':mid,'name':name,'file':path,'hits':hits,'assertion':assertion}
    (missing if hits==0 else duplicates if hits>1 else present).append(item)
import json
print(json.dumps({'total':len(m.M),'missing':len(missing),'duplicates':len(duplicates),'present':len(present),
                  'missing_items':missing,'duplicate_items':duplicates}, ensure_ascii=False,indent=2))
if len(m.M)!=178:
    sys.exit('MUTANT_CENSUS_NOT_178')
