#!/usr/bin/env python3
"""Fail-closed brand asset materialization for the EXACT central Cloudflare candidate."""
import hashlib,json,shutil,struct
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SRC=ROOT/"assets/brand/export"
MANIFEST=json.loads((SRC/"manifest.json").read_text(encoding="utf8"))
NAMES={
"avatar-400.png":(400,400),"avatar-800.png":(800,800),
"banner-bluesky.png":(1500,500),"banner-youtube.png":(2560,1440),
"banner-facebook.png":(1640,624),"post-01.png":(1080,1080),
"post-02.png":(1080,1080),"post-03.png":(1080,1080),
"pin.png":(1000,1500),"short.png":(1080,1920),
"link-card.png":(1200,630),"blog-card.png":(1200,630),
"email-card.png":(1200,630)
}
if set(MANIFEST)!=set(NAMES):raise SystemExit("BRAND_MISSING_OR_UNEXPECTED_ASSET")
DEST=ROOT/"public/brand/export"
DEST.mkdir(parents=True,exist_ok=True)
for name,(width,height) in NAMES.items():
    source=SRC/name
    if source.is_symlink() or not source.is_file():raise SystemExit("BRAND_FILE_ABSENT "+name)
    raw=source.read_bytes()
    if len(raw)>1_000_000 or raw[:8]!=b"\x89PNG\r\n\x1a\n":raise SystemExit("BRAND_INVALID_PNG "+name)
    if struct.unpack(">II",raw[16:24])!=(width,height):raise SystemExit("BRAND_DIMENSIONS_MISMATCH "+name)
    digest=hashlib.sha256(raw).hexdigest()
    if digest!=MANIFEST[name]["sha256"] or len(raw)!=MANIFEST[name]["size"]:raise SystemExit("BRAND_MANIFEST_MISMATCH "+name)
    shutil.copyfile(source,DEST/name)
    if (DEST/name).read_bytes()!=raw:raise SystemExit("BRAND_COPY_CORRUPTED "+name)
# The apex public/ tree is reconstructed from a frozen commit; overlay the CURRENT official
# vector logos (owner order 12-13/10/2026: internal seal removed) and retire the unapproved
# duplicate Facebook cover by serving the approved banner at its legacy path.
LOGO_SRC=ROOT/"sales-public/brand"
if (LOGO_SRC/"zevanory-logo-dark.svg").read_bytes()!=(ROOT/"assets/brand/logo-original.svg").read_bytes():raise SystemExit("BRAND_LOGO_NOT_CANONICAL")
for name in ("zevanory-logo-dark.svg","zevanory-logo-light.svg","zevanory-mark.svg"):
    raw=(LOGO_SRC/name).read_bytes()
    if b"CENTRAL OPERACIONAL" in raw or b"REVENUE OPERATIONS" in raw:raise SystemExit("BRAND_INTERNAL_SEAL "+name)
    (ROOT/"public/brand"/name).write_bytes(raw)
legacy=ROOT/"public/brand/social/zevanory-facebook-cover-1640x624.png"
legacy.parent.mkdir(parents=True,exist_ok=True)
shutil.copyfile(DEST/"banner-facebook.png",legacy)
for svg in (ROOT/"public").rglob("*.svg"):
    if b"CENTRAL OPERACIONAL" in svg.read_bytes():raise SystemExit("BRAND_INTERNAL_SEAL_LEFT "+str(svg.relative_to(ROOT)))
print("BRAND_CANONICAL_STATIC_ASSETS=PASS",len(NAMES))
