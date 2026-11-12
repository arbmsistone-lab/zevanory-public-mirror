"""Measure decoded MP4 pixels at each word midpoint in one decoding pass."""
import json,subprocess,sys,statistics
video,rowsfile=sys.argv[1:];rows=json.load(open(rowsfile));ratios=[]
def sec(s):
 a=s.split(':');return float(a[0])*3600+float(a[1])*60+float(a[2])
def lum(rgb):
 c=[v/255 for v in rgb];c=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in c]
 return .2126*c[0]+.7152*c[1]+.0722*c[2]
indices=[round((sec(r['start'])+sec(r['end']))/2*30) for r in rows];unique=sorted(set(indices));measured={}
select="select='"+'+'.join('eq(n,%d)'%i for i in unique)+"',crop=920:210:60:1410"
p=subprocess.Popen(['ffmpeg','-v','error','-i',video,'-vf',select,'-fps_mode','vfr','-frames:v',str(len(unique)),'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],stdout=subprocess.PIPE)
size=920*210*3
for frame in unique:
 raw=b''
 while len(raw)<size:
  chunk=p.stdout.read(size-len(raw))
  if not chunk:raise ValueError('caption_frame_missing')
  raw+=chunk
 pixels=[tuple(raw[i:i+3]) for i in range(0,len(raw),3)]
 bg=statistics.median(lum(v) for v in pixels[:920*15])
 ink=[lum(v) for v in pixels if v[0]>180 and v[1]>150 and v[2]<100]
 fg=statistics.median(ink) if ink else None
 measured[frame]=0 if fg is None else (max(fg,bg)+.05)/(min(fg,bg)+.05)
if p.wait()!=0:raise ValueError('caption_decode_failed')
ratios=[measured[i] for i in indices]
print(json.dumps({'minimum':min(ratios),'samples':len(ratios),'ratios':ratios}))
