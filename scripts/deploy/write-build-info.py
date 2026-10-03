#!/usr/bin/env python3
import json,os
with open("public/build-info.json","w",encoding="utf-8") as f:
    json.dump({"sha":os.environ["TARGET_RUNTIME_SHA"],"source":"github-actions-cloudflare","repository":os.environ["GITHUB_REPOSITORY"]},f,indent=2)
    f.write("\n")
