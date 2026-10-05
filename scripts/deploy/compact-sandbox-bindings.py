"""Preserve all bindings by inheritance; compact two non-secret voice settings."""
import json
from pathlib import Path

def compact(settings):
    bindings=settings['bindings']
    by_name={b['name']:b for b in bindings}
    runtime=by_name['ZEVANORY_RUNTIME_CONFIG']
    assert runtime['type']=='json'
    values=dict(runtime['json'])
    compacted={'VOICE_TTS_PROVIDER','VOICE_TTS_PROVIDER_CHAIN'}
    for name in compacted:
        if name in by_name:
            assert by_name[name]['type']=='plain_text'
            values[name]=by_name[name]['text']
    result={'bindings':[{'name':b['name'],'type':'inherit'} for b in bindings
                        if b['name'] not in compacted|{'ZEVANORY_RUNTIME_CONFIG'}]
                        +[{'name':'ZEVANORY_RUNTIME_CONFIG','type':'json','json':values}]}
    if settings.get('annotations'):
        result['annotations']={k:v for k,v in settings['annotations'].items() if k!='workers/triggered_by'}
    return result

if __name__=='__main__':
    source=json.loads(Path('/tmp/settings.json').read_text())
    assert source.get('success') is True
    result=compact(source['result'])
    Path('/tmp/compact-settings.json').write_text(json.dumps(result))
    print('VOICE_BINDING_COMPACTION=2_SETTINGS_VALUES_PRESERVED')
