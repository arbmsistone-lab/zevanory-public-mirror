#!/usr/bin/env python3
import json, math, pathlib, re, sys

ROOT=pathlib.Path(".")
CONTRACT=json.loads((ROOT/"arbm-sist/ped-versal-contract.json").read_text(encoding="utf-8"))
HTML=(ROOT/CONTRACT["ui"]["html"]).read_text(encoding="utf-8")
CSS=(ROOT/CONTRACT["ui"]["css"]).read_text(encoding="utf-8")
FAIL=[]

def fail(code, detail=""):
    FAIL.append((code,detail))

def lum(hexv):
    h=hexv.lstrip("#")
    if len(h)==3: h="".join(c*2 for c in h)
    rgb=[int(h[i:i+2],16)/255 for i in (0,2,4)]
    vals=[v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4 for v in rgb]
    return 0.2126*vals[0]+0.7152*vals[1]+0.0722*vals[2]

def contrast(a,b):
    x,y=sorted((lum(a),lum(b)),reverse=True)
    return (x+0.05)/(y+0.05)

def block_after(selector):
    i=CSS.find(selector)
    if i<0: return ""
    start=CSS.find("{",i)
    if start<0: return ""
    depth=0
    for pos in range(start,len(CSS)):
        if CSS[pos]=="{": depth+=1
        elif CSS[pos]=="}":
            depth-=1
            if depth==0: return CSS[start+1:pos]
    return ""

# Governance invariants.
if CONTRACT.get("profile")!="HYBRID_UI_PROOF": fail("profile")
if CONTRACT["proof"].get("falseGreen")!=0: fail("false_green")
if CONTRACT["proof"].get("regressionBudget")!=0: fail("regression_budget")

# HTML must be isolated from legacy shared stylesheet and support both themes without JS rendering dependency.
if "/zevanory-public-mirror/product.css" in HTML: fail("legacy_css_dependency")
if "/zevanory-public-mirror/arbm-sist/arbm-sist.css" not in HTML: fail("dedicated_css_missing")
if 'name="color-scheme" content="dark light"' not in HTML: fail("color_scheme_contract")
if 'class="theme-toggle"' not in HTML: fail("theme_toggle_missing")
if "localStorage.getItem('zevanory-theme')" not in HTML: fail("theme_persistence_missing")

# Content/function integrity.
required_text=[
"Automatize mais. Dependa menos.",
"Orquestração central",
"Independência operacional",
"Governança reproduzível",
"IA e automações",
"Fail-closed e gates",
"Multi-provedor",
"Observabilidade e rollback",
"Mapear o fluxo",
"Orquestrar com política",
"Validar antes de promover",
"Venda condicionada aos gates oficiais",
"O ARBM SIST substitui toda ferramenta que já uso?",
"Quando o checkout será liberado?",
"Quero avaliar o ARBM SIST",
"Comparar soluções",
]
for text in required_text:
    if text not in HTML: fail("content_integrity",text)
required_links=[
"/zevanory-public-mirror/solucoes",
"/zevanory-public-mirror/termos",
"/zevanory-public-mirror/privacidade",
"/zevanory-public-mirror/reembolso",
"mailto:contato@zevanory.api.br",
]
for link in required_links:
    if link not in HTML: fail("link_integrity",link)

# Semantic/accessibility contract.
for token in ["<main id=\"conteudo\">","<nav class=\"site-nav\" aria-label=\"Navegação principal\">","<footer class=\"site-footer\">","class=\"skip-link\""]:
    if token not in HTML: fail("semantic_structure",token)
if ":focus-visible" not in CSS: fail("focus_visible")
if "prefers-reduced-motion" not in CSS: fail("reduced_motion")
if "overflow-wrap: anywhere" not in CSS: fail("text_overflow_protection")
if "overflow-x: clip" not in CSS: fail("page_overflow_protection")

# Typography scale.
allowed=set(CONTRACT["ui"]["typographyPx"])
for m in re.finditer(r"font-size\s*:\s*([^;}{]+)",CSS,re.I):
    for px in re.finditer(r"(-?\d+(?:\.\d+)?)px\b",m.group(1)):
        v=float(px.group(1))
        if v and v not in allowed: fail("font_scale",px.group(0))

# Geometry: every px value in macro/micro geometry properties must be on 4pt lattice.
geom=re.compile(r"(?:^|[;{\s])(gap|row-gap|column-gap|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|min-height|max-height|height|min-width|max-width|width|border-radius|outline-offset)\s*:\s*([^;}{]+)",re.I)
micro=[]
for m in geom.finditer(CSS):
    prop=m.group(1).lower()
    for px in re.finditer(r"(-?\d+(?:\.\d+)?)px\b",m.group(2)):
        v=abs(float(px.group(1)))
        if v==0: continue
        if abs(v/4-round(v/4))>1e-9: fail("geometry_not_4pt",f"{prop}:{px.group(0)}")
        elif abs(v/8-round(v/8))>1e-9: micro.append((prop,px.group(0)))
# Micro-grid is allowed only for small optical/control geometry.
allowed_micro_props={"padding","padding-top","padding-right","padding-bottom","padding-left","outline-offset","width","height"}
for prop,val in micro:
    if prop not in allowed_micro_props: fail("microgrid_misuse",f"{prop}:{val}")

# All literal CSS colors must live in custom property declarations.
for no,line in enumerate(CSS.splitlines(),1):
    if re.search(r"#[0-9a-fA-F]{3,8}\b",line) and "--" not in line and not line.lstrip().startswith(("/*","*","//")):
        fail("hardcoded_color",f"line {no}")

# Required semantic token values in explicit dark and light blocks.
dark=block_after(":root {")
light=block_after(':root[data-theme="light"]')
for theme,block in [("dark",dark),("light",light)]:
    if not block: fail("theme_block_missing",theme); continue
    for name,value in CONTRACT["ui"]["tokens"][theme].items():
        pattern=rf"--{re.escape(name)}\s*:\s*{re.escape(value)}\s*;"
        if not re.search(pattern,block,re.I): fail("token_mismatch",f"{theme}:{name}:{value}")

# Contrast proofs.
for theme,t in CONTRACT["ui"]["tokens"].items():
    body_pairs=[
      ("text-primary","bg-primary",7.0),
      ("text-secondary","bg-primary",7.0),
      ("text-primary","surface",7.0),
      ("text-secondary","surface",7.0),
      ("action-primary-text","action-primary",7.0),
    ]
    graphic_pairs=[
      ("status-success","bg-secondary",4.5),
      ("status-error","bg-secondary",4.5),
      ("status-warning","bg-secondary",4.5),
      ("status-info","bg-secondary",4.5),
      ("focus-ring","bg-primary",4.5),
    ]
    for a,b,floor in body_pairs+graphic_pairs:
        ratio=contrast(t[a],t[b])
        if ratio+1e-9<floor: fail("contrast",f"{theme}:{a}/{b}={ratio:.2f}<{floor}")

# Viewport contract must be exact.
expected={(1920,1080),(1440,900),(768,1024),(375,812)}
actual={(x["width"],x["height"]) for x in CONTRACT["ui"]["viewports"]}
if actual!=expected: fail("viewport_contract",str(sorted(actual)))

print("ARBM_SIST_PED_STATIC_AUDIT")
print("geometry_micro_entries",len(micro))
if FAIL:
    print("RESULT=FAIL")
    for code,detail in FAIL:
        print("FAIL",code,detail)
    sys.exit(1)
print("RESULT=PASS")
print("FALSE_GREEN=0")
print("REGRESSION_BUDGET=0")
print("CONTENT_INTEGRITY=PASS")
print("LIGHT_DARK_TOKENS=PASS")
print("CONTRAST_CONTRACT=PASS")
