#!/usr/bin/env python3
"""R120/DEC-20: restore only own chat assets after frozen central public tree reconstruction.
No deployment, credentials, or write outside the build directory."""
from pathlib import Path
import shutil
ROOT=Path(__file__).resolve().parents[2]
src=ROOT/"sales-overlay"
dst=ROOT/"public"
if not dst.is_dir():
    raise SystemExit("R120_CHAT_ASSET_BUILD_DIR_MISSING")
for name in ("site-chat.js","site-chat.css"):
    original=src/name
    if not original.is_file():
        raise SystemExit("R120_CHAT_ASSET_SOURCE_MISSING:"+name)
    shutil.copyfile(original,dst/name)
    if (dst/name).read_bytes()!=original.read_bytes():
        raise SystemExit("R120_CHAT_ASSET_COPY_MISMATCH:"+name)
print("R120_CHAT_ASSETS_RESTORED=PASS")
