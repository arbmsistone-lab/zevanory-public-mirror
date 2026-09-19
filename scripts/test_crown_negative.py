#!/usr/bin/env python3
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.zevanory_crown_gate import merkle_root

a=hashlib.sha256(b"a").hexdigest()
b=hashlib.sha256(b"b").hexdigest()
assert merkle_root([a,b]) != merkle_root([a,hashlib.sha256(b"B").hexdigest()])
print("PASS: crown negative tamper test")
