#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

from google import genai

PRODUCTS = [
    ("IA na Prática", "sales-public/ia-na-pratica.html", "ia-na-pratica"),
    ("Vendas na Prática", "sales-public/vendas-na-pratica.html", "vendas-na-pratica"),
    ("Lucro & Caixa", "sales-public/lucro-e-caixa.html", "lucro-e-caixa"),
    ("Combo IA + Vendas", "sales-public/combo-ia-vendas.html", "combo-ia-vendas"),
    ("Negócio Completo", "sales-public/negocio-completo.html", "negocio-completo"),
]
TEXT_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash"]
IMAGE_MODELS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"]
FORBIDDEN = [
    "renda garantida", "lucro garantido", "resultado garantido", "ganho garantido",
    "sem risco", "100% de sucesso", "fique rico", "enriqueça rápido", "dinheiro fácil",
]
BRAND = (
    "Visual editorial premium da ZEVANORY: sóbrio, moderno, profissional, brasileiro, "
    "sem rostos de pessoas identificáveis, sem logos de terceiros, sem números de resultado, "
    "sem promessa financeira, sem texto pequeno ilegível na imagem."
)

class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0
    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "nav", "footer"}:
            self.skip += 1
    def handle_endtag(self, tag):
        if tag in {"script", "style", "nav", "footer"} and self.skip:
            self.skip -= 1
    def handle_data(self, data):
        if not self.skip:
            text = re.sub(r"\s+", " ", data).strip()
            if text:
                self.parts.append(text)

def source_text(path: Path) -> str:
    parser = TextExtractor()
    parser.feed(path.read_text(encoding="utf-8"))
    text = " ".join(parser.parts)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) < 200:
        raise RuntimeError(f"canonical_source_too_short:{path}")
    return text[:14000]

def interaction_text(client, model, prompt):
    last = None
    for name in model if isinstance(model, list) else [model]:
        try:
            out = client.interactions.create(model=name, input=prompt)
            text = str(getattr(out, "output_text", "") or "").strip()
            if not text:
                raise RuntimeError("empty_text_output")
            return name, text
        except Exception as exc:
            last = exc
    raise RuntimeError(f"text_generation_failed:{last}")

def parse_json(text):
    text = text.strip()
    text = re.sub(r"^\s*```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```\s*$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("json_object_missing")
    return json.loads(text[start:end+1])

def generation_prompt(name, source):
    return f"""
Você cria UM post orgânico da ZEVANORY para o produto {name}.
Use SOMENTE fatos presentes no CONTEÚDO CANÔNICO abaixo. Não invente benefício, preço, prova social,
estatística, depoimento, urgência falsa ou garantia de resultado. Não use promessa de renda/lucro.
O objetivo é educação e descoberta, não pressão comercial.

Retorne JSON puro com:
{{
  "caption": "legenda em português brasileiro, 300 a 700 caracteres, clara e específica",
  "hashtags": ["#..."],
  "image_prompt": "prompt visual em português, coerente com o produto, sem promessas e sem marcas de terceiros",
  "claims": ["cada afirmação factual feita na legenda, em frases curtas"]
}}
Regras: 4 a 8 hashtags; incluir o nome do produto na legenda; CTA leve para conhecer o conteúdo.
CONTEÚDO CANÔNICO:
{source}
""".strip()

def verification_prompt(name, source, creative):
    return f"""
Atue como verificador adversarial de publicidade. Compare a peça abaixo com a fonte canônica.
Marque faithful=true SOMENTE se todas as afirmações factuais forem suportadas explicitamente pela fonte
e não houver promessa enganosa, garantia de resultado, renda/lucro garantido, urgência falsa ou prova social inventada.
Retorne JSON puro:
{{
  "faithful": true,
  "unsupported_claims": [],
  "misleading_promises": [],
  "reason": "explicação curta"
}}
PRODUTO: {name}
FONTE:
{source}
PEÇA:
{json.dumps(creative, ensure_ascii=False)}
""".strip()

def validate_copy(name, creative, verdict):
    caption = str(creative.get("caption") or "").strip()
    tags = creative.get("hashtags")
    image_prompt = str(creative.get("image_prompt") or "").strip()
    claims = creative.get("claims")
    if name.lower() not in caption.lower():
        raise RuntimeError("caption_missing_product_name")
    if not 250 <= len(caption) <= 900:
        raise RuntimeError(f"caption_length_invalid:{len(caption)}")
    if not isinstance(tags, list) or not 4 <= len(tags) <= 8:
        raise RuntimeError("hashtags_count_invalid")
    if any(not re.fullmatch(r"#[A-Za-zÀ-ÿ0-9_]{2,40}", str(tag)) for tag in tags):
        raise RuntimeError("hashtag_format_invalid")
    if not image_prompt:
        raise RuntimeError("image_prompt_missing")
    if not isinstance(claims, list):
        raise RuntimeError("claims_missing")
    low = (caption + " " + image_prompt).lower()
    bad = [term for term in FORBIDDEN if term in low]
    if bad:
        raise RuntimeError("forbidden_claim:" + ",".join(bad))
    if verdict.get("faithful") is not True:
        raise RuntimeError("verifier_not_faithful:" + str(verdict.get("reason") or ""))
    if verdict.get("unsupported_claims"):
        raise RuntimeError("unsupported_claims:" + json.dumps(verdict["unsupported_claims"], ensure_ascii=False))
    if verdict.get("misleading_promises"):
        raise RuntimeError("misleading_promises:" + json.dumps(verdict["misleading_promises"], ensure_ascii=False))

def generate_image(client, image_prompt):
    last = None
    for model in IMAGE_MODELS:
        try:
            prompt = BRAND + "\n\nPeça: " + image_prompt + "\nFormato quadrado 1:1, sem texto promocional inventado."
            interaction = client.interactions.create(model=model, input=prompt)
            image = getattr(interaction, "output_image", None)
            data = getattr(image, "data", None) if image else None
            if not data:
                raise RuntimeError("empty_image_output")
            if isinstance(data, bytes):
                raw = data
            else:
                raw = base64.b64decode(str(data))
            if len(raw) < 10_000:
                raise RuntimeError("image_payload_too_small")
            return model, raw
        except Exception as exc:
            last = exc
    raise RuntimeError(f"image_generation_failed:{last}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not key:
        raise SystemExit("GEMINI_API_KEY_missing")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    client = genai.Client(api_key=key)
    manifest = {
        "schema": "zevanory.autonomous-seller.creatives.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "products": [],
    }
    for name, source_path, slug in PRODUCTS:
        source = source_text(Path(source_path))
        source_sha = hashlib.sha256(source.encode()).hexdigest()
        text_model, raw = interaction_text(client, TEXT_MODELS, generation_prompt(name, source))
        creative = parse_json(raw)
        verifier_model, verdict_raw = interaction_text(client, TEXT_MODELS, verification_prompt(name, source, creative))
        verdict = parse_json(verdict_raw)
        validate_copy(name, creative, verdict)
        image_model, image_bytes = generate_image(client, str(creative["image_prompt"]))
        product_dir = out / slug
        product_dir.mkdir(parents=True, exist_ok=True)
        image_path = product_dir / "post.png"
        image_path.write_bytes(image_bytes)
        record = {
            "product": name,
            "slug": slug,
            "source_path": source_path,
            "source_sha256": source_sha,
            "text_model": text_model,
            "verifier_model": verifier_model,
            "image_model": image_model,
            "caption": creative["caption"],
            "hashtags": creative["hashtags"],
            "image_prompt": creative["image_prompt"],
            "claims": creative["claims"],
            "verification": verdict,
            "image_sha256": hashlib.sha256(image_bytes).hexdigest(),
            "image_bytes": len(image_bytes),
        }
        (product_dir / "post.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        manifest["products"].append({
            "product": name,
            "slug": slug,
            "faithful": True,
            "source_sha256": source_sha,
            "image_sha256": record["image_sha256"],
            "text_model": text_model,
            "verifier_model": verifier_model,
            "image_model": image_model,
        })
        print(f"CREATIVE={slug}=PASS image_bytes={len(image_bytes)}")
    if len(manifest["products"]) != 5:
        raise RuntimeError("creative_count_not_5")
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("STAGE1_PRODUCTS=5/5")
    print("STAGE1_FAITHFUL=5/5")
    print("STAGE1_IMAGE_CAPTION_HASHTAGS=5/5")
    print("STAGE1=PASS")

if __name__ == "__main__":
    main()
