import sys,json
from urllib.parse import urlsplit
buf=''
for line in sys.stdin:
    if not buf and not line.lstrip().startswith('{'): continue
    buf+=line
    try: d=json.loads(buf)
    except json.JSONDecodeError: continue
    buf=''
    path=urlsplit(d.get('event',{}).get('request',{}).get('url','')).path
    if path not in ['/api/webhooks/meta','/api/voice/probe']: continue
    logs=[]
    for log in d.get('logs',[]):
        message=log.get('message',[])
        first=str(message[0]) if message else ''
        if first.startswith('whatsapp_'):
            logs.append([first]+[v for v in message[1:] if isinstance(v,(int,float))])
        elif any(s in first.lower() for s in ['waituntil','cpu time','resource limit']):
            logs.append(first[:240])
    print(json.dumps({'at':d.get('eventTimestamp'),'path':path,'outcome':d.get('outcome'),'cpu_ms':d.get('cpuTime'),'wall_ms':d.get('wallTime'),'exceptions':[{'name':e.get('name'),'resource_limit':any(s in str(e.get('message','')).lower() for s in ['cpu','resource','memory','cancel'])} for e in d.get('exceptions',[])],'logs':logs}),flush=True)
