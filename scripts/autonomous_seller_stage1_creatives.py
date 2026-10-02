#!/usr/bin/env python3
import argparse, base64, hashlib, json, os, re, urllib.request, urllib.error
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ACCOUNT_ID=(os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
TOKEN=(os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
TEXT_MODEL="@cf/zai-org/glm-4.7-flash"
IMAGE_MODEL="@cf/black-forest-labs/flux-1-schnell"
PRODUCTS=[
 ("IA na Prática","sales-public/ia-na-pratica.html","ia-na-pratica"),
 ("Vendas na Prática","sales-public/vendas-na-pratica.html","vendas-na-pratica"),
 ("Lucro & Caixa","sales-public/lucro-e-caixa.html","lucro-e-caixa"),
 ("Combo IA + Vendas","sales-public/combo-ia-vendas.html","combo-ia-vendas"),
 ("Negócio Completo","sales-public/negocio-completo.html","negocio-completo"),
]
FORBIDDEN=["renda garantida","lucro garantido","resultado garantido","ganho garantido","sem risco","100% de sucesso","fique rico","enriqueça rápido","dinheiro fácil"]

class Extractor(HTMLParser):
 def __init__(self): super().__init__(); self.parts=[]; self.skip=0
 def handle_starttag(self,tag,attrs):
  if tag in {"script","style","nav","footer"}: self.skip+=1
 def handle_endtag(self,tag):
  if tag in {"script","style","nav","footer"} and self.skip: self.skip-=1
 def handle_data(self,data):
  if not self.skip:
   s=re.sub(r"\s+"," ",data).strip()
   if s:self.parts.append(s)

def canonical(path):
 p=Extractor(); p.feed(Path(path).read_text(encoding="utf-8"))
 text=re.sub(r"\s+"," "," ".join(p.parts)).strip()
 if len(text)<200: raise RuntimeError("canonical_source_too_short:"+path)
 return text[:14000]

def cf_run(model,payload,timeout=90):
 if not ACCOUNT_ID or not TOKEN: raise RuntimeError("cloudflare_authority_missing")
 url=f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}"
 req=urllib.request.Request(url,data=json.dumps(payload,ensure_ascii=False).encode(),method="POST",
  headers={"Authorization":"Bearer "+TOKEN,"Content-Type":"application/json","Accept":"application/json"})
 try:
  with urllib.request.urlopen(req,timeout=timeout) as r:
   raw=r.read()
 except urllib.error.HTTPError as e:
  body=e.read().decode("utf-8","replace")[:1200]
  raise RuntimeError(f"workers_ai_http_{e.code}:{body}")
 data=json.loads(raw)
 if isinstance(data,dict) and data.get("success") is False:
  raise RuntimeError("workers_ai_error:"+json.dumps(data.get("errors"),ensure_ascii=False))
 return data

def text_output(data):
 result=data.get("result",data) if isinstance(data,dict) else data
 if isinstance(result,dict):
  for key in ("response","text","output_text"):
   if isinstance(result.get(key),str) and result[key].strip(): return result[key].strip()
  choices=result.get("choices")
  if isinstance(choices,list) and choices:
   msg=choices[0].get("message",{}) if isinstance(choices[0],dict) else {}
   if isinstance(msg.get("content"),str): return msg["content"].strip()
 if isinstance(result,str): return result.strip()
 raise RuntimeError("workers_ai_text_shape_unknown")

def ask(prompt,system):
 data=cf_run(TEXT_MODEL,{"messages":[{"role":"system","content":system},{"role":"user","content":prompt}],"max_tokens":1600,"temperature":0.25})
 return text_output(data)

def parse_obj(text):
 text=re.sub(r"^\s*```(?:json)?\s*","",text,flags=re.I)
 text=re.sub(r"\s*```\s*$","",text)
 a,b=text.find("{"),text.rfind("}")
 if a<0 or b<=a: raise RuntimeError("json_object_missing")
 return json.loads(text[a:b+1])

def generation_prompt(name,source):
 return f"""Crie UM post orgânico da ZEVANORY para {name}. Use SOMENTE fatos da fonte canônica abaixo.
Não invente preço, estatística, depoimento, urgência, prova social, promessa financeira ou garantia de resultado.
Retorne APENAS JSON com:
{{"caption":"legenda PT-BR entre 300 e 700 caracteres, incluindo o nome do produto e CTA leve","hashtags":["#tag"],"image_prompt":"descrição visual profissional 1:1 coerente com o produto, sem logos de terceiros e sem promessas","claims":["afirmações factuais curtas usadas na legenda"]}}
Use 4 a 8 hashtags.
FONTE CANÔNICA:
{source}"""

def verify_prompt(name,source,creative):
 return f"""Você é um verificador adversarial de publicidade. Compare a peça de {name} com a fonte.
faithful=true SOMENTE se TODA afirmação factual estiver explicitamente suportada e não houver promessa enganosa,
garantia de renda/lucro/resultado, urgência falsa ou prova social inventada.
Retorne APENAS JSON:
{{"faithful":true,"unsupported_claims":[],"misleading_promises":[],"reason":"curto"}}
FONTE:
{source}
PEÇA:
{json.dumps(creative,ensure_ascii=False)}"""

def validate(name,c,v):
 caption=str(c.get("caption") or "").strip()
 tags=c.get("hashtags"); prompt=str(c.get("image_prompt") or "").strip()
 if name.lower() not in caption.lower(): raise RuntimeError("caption_missing_product_name")
 if not 250<=len(caption)<=900: raise RuntimeError("caption_length_invalid")
 if not isinstance(tags,list) or not 4<=len(tags)<=8: raise RuntimeError("hashtags_count_invalid")
 if any(not re.fullmatch(r"#[A-Za-zÀ-ÿ0-9_]{2,40}",str(x)) for x in tags): raise RuntimeError("hashtag_format_invalid")
 low=(caption+" "+prompt).lower()
 bad=[x for x in FORBIDDEN if x in low]
 if bad: raise RuntimeError("forbidden_claim:"+",".join(bad))
 if v.get("faithful") is not True or v.get("unsupported_claims") or v.get("misleading_promises"):
  raise RuntimeError("creative_verification_failed:"+json.dumps(v,ensure_ascii=False))

def image_bytes(prompt,seed):
 data=cf_run(IMAGE_MODEL,{"prompt":"Visual editorial premium ZEVANORY, sóbrio, moderno, profissional, sem rostos identificáveis, sem logos de terceiros, sem números de resultado, sem promessa financeira, composição quadrada 1:1. "+prompt,"seed":seed,"steps":4},timeout=120)
 result=data.get("result",data) if isinstance(data,dict) else data
 img=result.get("image") if isinstance(result,dict) else None
 if not isinstance(img,str) or not img: raise RuntimeError("workers_ai_image_shape_unknown")
 raw=base64.b64decode(img)
 if len(raw)<10000: raise RuntimeError("image_payload_too_small")
 return raw

def main():
 ap=argparse.ArgumentParser(); ap.add_argument("--out",required=True); args=ap.parse_args()
 if not ACCOUNT_ID or not TOKEN: raise SystemExit("CLOUDFLARE_AI_AUTHORITY_missing")
 out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
 manifest={"schema":"zevanory.autonomous-seller.creatives.v1","generated_at":datetime.now(timezone.utc).isoformat(),"text_model":TEXT_MODEL,"image_model":IMAGE_MODEL,"products":[]}
 for idx,(name,path,slug) in enumerate(PRODUCTS,1):
  source=canonical(path); source_sha=hashlib.sha256(source.encode()).hexdigest()
  creative=parse_obj(ask(generation_prompt(name,source),"Você é redator publicitário factual, conservador e fiel à fonte."))
  verdict=parse_obj(ask(verify_prompt(name,source,creative),"Você é auditor de claims e deve reprovar qualquer afirmação não sustentada."))
  validate(name,creative,verdict)
  raw=image_bytes(str(creative.get("image_prompt") or ""),1000+idx)
  d=out/slug; d.mkdir(parents=True,exist_ok=True); (d/"post.jpg").write_bytes(raw)
  rec={"product":name,"slug":slug,"source_path":path,"source_sha256":source_sha,"text_model":TEXT_MODEL,"verifier_model":TEXT_MODEL,"image_model":IMAGE_MODEL,
       "caption":creative["caption"],"hashtags":creative["hashtags"],"image_prompt":creative["image_prompt"],"claims":creative.get("claims",[]),
       "verification":verdict,"image_sha256":hashlib.sha256(raw).hexdigest(),"image_bytes":len(raw)}
  (d/"post.json").write_text(json.dumps(rec,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
  manifest["products"].append({"product":name,"slug":slug,"faithful":True,"source_sha256":source_sha,"image_sha256":rec["image_sha256"]})
  print(f"CREATIVE={slug}=PASS image_bytes={len(raw)}")
 (out/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
 assert len(manifest["products"])==5
 print("STAGE1_PRODUCTS=5/5"); print("STAGE1_FAITHFUL=5/5"); print("STAGE1_IMAGE_CAPTION_HASHTAGS=5/5"); print("STAGE1=PASS")

if __name__=="__main__": main()
