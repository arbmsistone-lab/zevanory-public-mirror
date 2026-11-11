"""Original procedural beds, no samples or third-party melodies. CC0-1.0."""
import hashlib,json,subprocess,wave
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
RATE=24000
styles=[('ia','eletronica_leve',108),('vendas','animada_motivacional',116),('financas','corporativa_calma',84),('dicas','lofi_leve',88)]
rows=[]
for style,mood,bpm in styles:
 for variant in range(2):
  t=np.arange(RATE*36)/RATE
  beat=60/bpm
  # Synthesized harmonic pads + original deterministic rhythmic accents.
  freqs=[130.8128,164.8138,195.9977] if variant==0 else [146.8324,174.6141,220.0]
  pad=sum(np.sin(2*np.pi*f*t+0.13*variant)*(.06/(i+1)) for i,f in enumerate(freqs))
  phase=np.mod(t,beat)
  kick=.09*np.sin(2*np.pi*(52*phase+16*(1-np.exp(-phase*20))))*np.exp(-phase*18)
  tick=.015*np.sin(2*np.pi*2400*t)*np.exp(-np.mod(t,beat/2)*90)
  signal=np.clip((pad+kick+tick)*.65,-.9,.9)
  name=f'{style}-{variant+1}'
  temp=ROOT/'assets/musica'/f'{name}.wav'
  with wave.open(str(temp),'wb') as f:
   f.setparams((1,2,RATE,0,'NONE','not compressed'));f.writeframes((signal*32767).astype('<i2').tobytes())
  target=temp.with_suffix('.flac')
  subprocess.run(['ffmpeg','-y','-loglevel','error','-i',str(temp),'-c:a','flac',str(target)],check=True)
  temp.unlink()
  rows.append({'arquivo':f'assets/musica/{name}.flac','sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'titulo':f'ZEVANORY {mood} {variant+1}','autor':'ZEVANORY — sintese procedural original','fonte':'https://github.com/arbmsistone-lab/zevanory-public-mirror/blob/feat/shorts-padrao-v2/scripts/shorts-v2/generate-music.py','licenca':'CC0-1.0','verificado_em':'2026-11-11','bpm':bpm,'clima':mood,'temas_permitidos':[style]})
(ROOT/'data/musica-licencas.json').write_text(json.dumps({'schema':'musica-licencas/v1','faixas':rows},ensure_ascii=False,indent=2)+'\n')
