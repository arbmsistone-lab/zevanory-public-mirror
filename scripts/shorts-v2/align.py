"""Local forced alignment; never guesses evenly spaced word timestamps."""
import json,sys
from pathlib import Path
import stable_whisper
model=stable_whisper.load_model('base',device='cpu')
text=Path(sys.argv[2]).read_text(encoding='utf-8')
result=model.align(sys.argv[1],text,language='pt')
if result is None:
 raise SystemExit('alignment_failed')
result.save_as_json(sys.argv[3])
