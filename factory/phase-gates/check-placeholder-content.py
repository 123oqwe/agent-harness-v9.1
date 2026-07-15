#!/usr/bin/env python3
"""[REAL] Check for placeholder content (TODO/FIXME/placeholder) in normative files."""
import os, sys, re

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC_DIR = os.path.join(BASE, "spec")

placeholders = []
# Use word boundary to avoid matching "jtbd" as "tbd"
pattern = re.compile(r'\b(todo|fixme|placeholder|xxx|tbd):', re.IGNORECASE)

for root, dirs, files in os.walk(SPEC_DIR):
    if "deprecated-v8-content" in root or "appendix" in root:
        continue
    for fname in files:
        if not fname.endswith(('.md', '.yaml', '.json', '.tla', '.txt')):
            continue
        fpath = os.path.join(root, fname)
        try:
            with open(fpath) as f:
                lines = f.readlines()
            for i, line in enumerate(lines, 1):
                if pattern.search(line):
                    if not line.lstrip().startswith('#'):
                        placeholders.append(f"{fpath}:{i}: {line.strip()[:80]}")
        except:
            pass

if placeholders:
    print(f"FAIL: {len(placeholders)} placeholder markers found:")
    for p in placeholders[:10]:
        print(f"  {p}")
    sys.exit(1)
else:
    print("PASS: no placeholder content found")
