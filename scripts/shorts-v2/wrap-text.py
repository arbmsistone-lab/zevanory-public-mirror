"""Wrap by the bundled font's measured advance, not character count."""
import json,sys
from PIL import ImageFont
font=ImageFont.truetype(sys.argv[1],int(sys.argv[2]));limit=float(sys.argv[3]);rows=['']
for word in sys.argv[4].split():
 if font.getlength(word)>limit:raise ValueError('word_exceeds_text_box')
 candidate=(rows[-1]+' '+word).strip()
 if font.getlength(candidate)>limit:rows.append(word)
 else:rows[-1]=candidate
print(json.dumps(rows,ensure_ascii=False))
