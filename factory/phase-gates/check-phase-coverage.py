#!/usr/bin/env python3
"""[REAL] Check that each phase manifest covers all requirements for that phase."""
import json, os, sys, re

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC_DIR = os.path.join(BASE, "spec")

req_path = os.path.join(SPEC_DIR, "requirements", "requirements.ndjson")
if not os.path.exists(req_path):
    print("FAIL: requirements.ndjson not found")
    sys.exit(1)

phase_reqs = {}
with open(req_path) as f:
    for line in f:
        if line.strip():
            r = json.loads(line)
            p = r.get("delivery_phase", -1)
            if p not in phase_reqs:
                phase_reqs[p] = []
            phase_reqs[p].append(r["id"])

missing = []
for phase in range(9):
    manifest_path = os.path.join(SPEC_DIR, "phases", f"phase-{phase}.yaml")
    if not os.path.exists(manifest_path):
        continue
    with open(manifest_path) as f:
        content = f.read()
    manifest_reqs = set(re.findall(r'AH-[A-Z][A-Z-]*-\d{3}', content))
    expected = set(phase_reqs.get(phase, []))
    not_in_manifest = expected - manifest_reqs
    if not_in_manifest:
        missing.append(f"Phase {phase}: {len(not_in_manifest)} missing: {sorted(not_in_manifest)[:5]}")

if missing:
    print(f"FAIL: phase coverage gaps:")
    for m in missing:
        print(f"  {m}")
    sys.exit(1)
else:
    print("PASS: all phase manifests cover their requirements")
