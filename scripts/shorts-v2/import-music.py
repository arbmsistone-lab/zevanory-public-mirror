"""Reproduce licensed excerpts. Explicit maintenance command; never used by CI.
Requires FFmpeg 7.1.5 for identical encoded-file SHA-256. Source checksum is checked
before decoding. This imports recordings; it does not generate music.
"""
import hashlib,json,pathlib,subprocess,tempfile,urllib.request
root=pathlib.Path(__file__).resolve().parents[2]
manifest=json.loads((root/'data/musica-licencas.json').read_text())
with tempfile.TemporaryDirectory() as tmp:
 for row in manifest['faixas']:
  if not row.get('pagina_licenca') or not row.get('evidencia_licenca'):raise ValueError('license evidence missing')
  original=pathlib.Path(tmp)/'source.mp3'
  with urllib.request.urlopen(row['fonte'],timeout=90) as src:original.write_bytes(src.read())
  if hashlib.sha256(original.read_bytes()).hexdigest()!=row['sha256_original']:raise ValueError('source hash mismatch')
  out=pathlib.Path(tmp)/'excerpt.ogg'
  subprocess.run(['ffmpeg','-v','error','-y','-ss',str(row['trecho_inicio']),'-i',str(original),'-t',str(row['trecho_segundos']),'-af','loudnorm=I=-28:TP=-4:LRA=7','-ar','44100','-ac','2','-c:a','libvorbis','-q:a','4',str(out)],check=True)
  # Ogg muxers can randomize serial numbers; compare decoded audio before replacing
  # a registered file. Never silently rewrite its approved checksum.
  print(row['titulo'],hashlib.sha256(out.read_bytes()).hexdigest(),'(registered:',row['sha256']+')')
