"""Measure the serialized ASS with the same bundled font used by libass."""
import json,re,sys
from PIL import ImageFont
ass=open(sys.argv[1],encoding='utf8').read()
fontpath=sys.argv[2]
style=re.search(r'^Style: Word,Inter ExtraBold,(\d+),',ass,re.M)
if not style: raise ValueError('caption_font_unknown')
style_fields=re.search(r'^Style: (.+)$',ass,re.M)[1].split(',')
size=int(style[1]);alignment=int(style_fields[18]);rows=[]
for line in ass.splitlines():
 if not line.startswith('Dialogue:'):continue
 fields=line.split(',',9);text=fields[9]
 pos=re.search(r'\\pos\(([\d.]+),([\d.]+)\)',text)
 if not pos:raise ValueError('caption_position_missing')
 fs=re.search(r'\\fs(\d+)',text);fs=int(fs[1]) if fs else size
 font=ImageFont.truetype(fontpath,fs)
 word=re.sub(r'\{[^}]*\}','',text)
 x,y=map(float,pos.groups());bbox=font.getbbox(word);w=font.getlength(word)*float(style_fields[11])/100;h=(bbox[3]-bbox[1])*float(style_fields[12])/100
 an=re.search(r'\\an([1-9])',text);anchor=int(an[1]) if an else alignment
 if anchor!=5:raise ValueError('caption_alignment_unsupported')
 # Alignment=5: centered. Outline/shadow extend six pixels each side.
 rows.append({'word':word,'start':fields[1],'end':fields[2],'left':x-w/2-6,'right':x+w/2+6,'bottom':y+h/2+6,'font':fs})
if not rows:raise ValueError('caption_empty')
print(json.dumps(rows))
