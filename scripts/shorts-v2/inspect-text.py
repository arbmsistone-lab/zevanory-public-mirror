import json,re,sys
from PIL import ImageFont
rows=[]
for line in open(sys.argv[1],encoding='utf8'):
 if 'drawtext=' not in line:continue
 font=re.search(r'fontfile=([^:]+)',line);path=re.search(r'textfile=([^:]+)',line);size=re.search(r'fontsize=(\d+)',line);x=re.search(r':x=(\d+)',line)
 if not all([font,path,size,x]):raise ValueError('text_geometry_missing')
 text=open(path[1],encoding='utf8').read();f=ImageFont.truetype(font[1],int(size[1]));rows.append(float(x[1])+max(f.getlength(s) for s in text.splitlines()))
print(json.dumps({'right':max(rows)}))
