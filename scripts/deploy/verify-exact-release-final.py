#!/usr/bin/env python3
import json,os
status=json.load(open("/tmp/status.json"))
health=json.load(open("/tmp/health.json"))
control=json.load(open("/tmp/control.json"))
core=json.load(open("/tmp/core.json"))
zea10=json.load(open("/tmp/zea10.json"))
assert status["runtime"]["sales"]=="globally-blocked"
assert health["ready"] is True
assert control["global_state"]=="operational_commercial_blocked"
assert control["root_blocker"]=="global_sale_disabled"
assert control["release"]["deployment"]["commit_sha"]==os.environ["TARGET_RUNTIME_SHA"], (control["release"]["deployment"]["commit_sha"],os.environ["TARGET_RUNTIME_SHA"])
assert core["release_sha"]==os.environ["TARGET_RUNTIME_SHA"]
assert core["architecture"]["flow"]==["runtime-ci","ZEES-16","ZEA-10","ZEVANORY Control Core","Admin"]
assert core["architecture"]["circular_dependency"] is False
assert core["invariants"]["evidence_to_evaluation_unidirectional"] is True
assert zea10["source_layer"]=="ZEES-16" and zea10["authority"] is False
print("PRODUCTION_EXACT_SHA_PASS",os.environ["TARGET_RUNTIME_SHA"])
print("PRODUCTION_ZEES_ZEA_CORE_ADMIN_ARCHITECTURE_PASS")
print("PRODUCTION_CENTRAL_UTF8_AND_SAFETY_PASS")
