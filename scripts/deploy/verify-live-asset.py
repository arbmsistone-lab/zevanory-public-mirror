#!/usr/bin/env python3
from pathlib import Path
import re
s=Path("/tmp/live.js").read_text(encoding="utf-8")
bad=[r"Ã[\x80-\xBF]",r"Â[\x80-\xBF ]",r"â€”",r"â€“",r"â€™",r"â€œ",r"â€",r"â†",r"\ufffd"]
assert sum(len(re.findall(p,s)) for p in bad)==0
assert "QUORUM & TRUST CHAIN" in s
assert "Decisão executiva baseada em evidência." in s
