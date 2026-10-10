#!/usr/bin/env python3
"""Deterministic brand exports from the EXACT ZEVANORY storefront logo.
Requires CairoSVG 2.8.2 and Pillow 12.3.0. Never modifies the original logo.
"""
from __future__ import annotations
import hashlib, json, shutil
from pathlib import Path
import cairosvg
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/"assets"/"brand"
OUT=SRC/"export"
LIVE=ROOT/"sales-public"/"brand"/"export"
HOST="vendas.zevanory.api.br"
PALETTE={"#05070b","#0b0f16","#101722","#202a38","#f5f7fb","#8fb8ff","#a8f0d0","#1578ff","#00b8ff","#21e6f3"}
FILES={
 "avatar-400.png":("avatar.svg",400,400),
 "avatar-800.png":("avatar.svg",800,800),
 "banner-bluesky.png":("banner-bluesky.svg",1500,500),
 "banner-youtube.png":("banner-youtube.svg",2560,1440),
 "banner-facebook.png":("banner-facebook.svg",1640,624),
}
POSTS=[
 ("post-01.png",1080,1080,"Menos improviso.","Mais execução.","Transforme uma rotina em passos claros."),
 ("post-02.png",1080,1080,"Atendimento claro.","Menos retrabalho.","Revise cada informação antes de enviar."),
 ("post-03.png",1080,1080,"Seu caixa merece","dados confiáveis.","Registre entradas e saídas sem adivinhar."),
 ("pin.png",1000,1500,"Organize sua rotina.","Execute com controle.","Passos simples. Informações verificadas."),
 ("short.png",1080,1920,"A execução começa","com clareza.","Revise o processo antes de automatizar."),
 ("link-card.png",1200,630,"Menos improviso.","Mais execução.","Conheça a ZEVANORY."),
 ("blog-card.png",1200,630,"Ideias práticas.","Resultados verificáveis.","Aprenda e revise cada etapa."),
 ("email-card.png",1200,630,"Material útil.","Sem promessas vazias.","Conheça o guia digital."),
]
def nested_mark(x,y,sz):
    m=(SRC/"mark-original.svg").read_text(encoding="utf8")
    return m.replace(m.split(">",1)[0]+">",f'<svg x="{x}" y="{y}" width="{sz}" height="{sz}" viewBox="0 0 512 512">',1)
def safe(value):
    return (value.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")
            .replace('"',"&quot;").replace("'","&apos;"))
def post_svg(w,h,a,b,c):
    compact=h<=700
    pad=round(w*0.057)
    logo=round(min(w,h)*0.085)
    title_size=round(min(w,h)*(0.09 if compact else 0.075))
    if compact: title_size=54
    y1=round(h*(0.45 if not compact else 0.48))
    gap=round(title_size*1.24)
    desc_y=min(round(h*.76), y1+2*gap)
    footer_y=h-round(h*.065)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="Peça oficial ZEVANORY">
<rect width="{w}" height="{h}" fill="#05070b"/>
<rect x="{pad//2}" y="{pad//2}" width="{w-pad}" height="{h-pad}" rx="30" fill="#0b0f16" stroke="#202a38" stroke-width="3"/>
{nested_mark(pad,pad,logo)}
<text x="{pad+logo+22}" y="{pad+round(logo*.7)}" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="{round(logo*.48)}" fill="#f5f7fb">ZEVANORY</text>
<path d="M{pad} {y1-round(title_size*1.6)} H{round(w*.65)}" stroke="#00b8ff" stroke-width="5"/>
<text x="{pad}" y="{y1}" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="{title_size}" fill="#f5f7fb">{safe(a)}</text>
<text x="{pad}" y="{y1+gap}" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="{title_size}" fill="#8fb8ff">{safe(b)}</text>
<text x="{pad}" y="{desc_y}" font-family="Arial,Helvetica,sans-serif" font-size="{max(23,round(title_size*.37))}" fill="#a8f0d0">{safe(c)}</text>
<path d="M{pad} {footer_y-38} H{w-pad}" stroke="#202a38" stroke-width="3"/>
<text x="{pad}" y="{footer_y}" font-family="Arial,Helvetica,sans-serif" font-size="{max(25,round(min(w,h)*.032))}" fill="#f5f7fb">{HOST}</text>
</svg>'''
def render(xml:bytes,w:int,h:int,dest:Path):
    png=cairosvg.svg2png(bytestring=xml,output_width=w,output_height=h)
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_bytes(png)
    # Normalize to deterministic, compact RGB PNG.
    with Image.open(dest) as im:
        if im.size!=(w,h): raise SystemExit("WRONG_SIZE "+dest.name)
        im.convert("RGB").save(dest,format="PNG",optimize=True,compress_level=9)
    raw=dest.read_bytes()
    if len(raw)>1_000_000:raise SystemExit("IMAGE_OVER_1MB "+dest.name)
    return hashlib.sha256(raw).hexdigest()
def main():
    storefront=ROOT/"sales-public"/"brand"
    if (SRC/"logo-original.svg").read_bytes()!=(storefront/"zevanory-logo-dark.svg").read_bytes():
        raise SystemExit("UNAPPROVED_LOGO_VARIANT")
    if (SRC/"mark-original.svg").read_bytes()!=(storefront/"zevanory-mark.svg").read_bytes():
        raise SystemExit("UNAPPROVED_MARK_VARIANT")
    for name in ("avatar.svg","banner-bluesky.svg","banner-youtube.svg","banner-facebook.svg"):
        xml=(SRC/name).read_text(encoding="utf8")
        if 'M82 72h274' not in xml or "#05070b" not in xml:
            raise SystemExit("BRAND_SOURCE_MISSING "+name)
    for name in ("banner-bluesky.svg","banner-youtube.svg","banner-facebook.svg"):
        xml=(SRC/name).read_text(encoding="utf8")
        if "Menos improviso. Mais execução." not in xml or HOST not in xml:
            raise SystemExit("BRAND_BANNER_INCOMPLETE "+name)
    # YouTube visible content is centered within the 1546x423 recommended area.
    # Safe: x 507..2053, y 508.5..931.5. Official logo/text are inside it.
    exports={}
    for name,(source,w,h) in FILES.items():
        exports[name]=render((SRC/source).read_bytes(),w,h,OUT/name)
    for name,w,h,a,b,c in POSTS:
        exports[name]=render(post_svg(w,h,a,b,c).encode(),w,h,OUT/name)
    for name in exports:
        LIVE.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(OUT/name,LIVE/name)
    manifest={name:{"sha256":digest,"size":(OUT/name).stat().st_size} for name,digest in exports.items()}
    (OUT/"manifest.json").write_text(json.dumps(manifest,indent=2,sort_keys=True)+"\n",encoding="utf8")
    js="/* generated by scripts/build-brand-assets.py; DO NOT EDIT */\nexport const BRAND_APPROVED_MEDIA = Object.freeze("+json.dumps(exports,sort_keys=True)+");\n"
    (ROOT/"worker"/"brand-approved.mjs").write_text(js,encoding="utf8")
    print("BRAND_EXPORT_PASS "+json.dumps({"count":len(exports),"files":sorted(exports)},sort_keys=True))
if __name__=="__main__":main()
