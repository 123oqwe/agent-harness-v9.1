#!/usr/bin/env python3
"""[REAL] Check that normative files don't reference deprecated v8 content.
Scans spec/ for references to deprecated-v8-content without appendix prefix.
"""
import os, sys, re

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC_DIR = os.path.join(BASE, "spec")

violations = []
for root, dirs, files in os.walk(SPEC_DIR):
    if "deprecated-v8-content" in root or "appendix" in root:
        continue
    for fname in files:
        if not fname.endswith(('.md', '.yaml', '.json')):
            continue
        fpath = os.path.join(root, fname)
        try:
            with open(fpath) as f:
                content = f.read()
            # Look for references to deprecated content without appendix/ prefix
            if "deprecated-v8-content" in content and "appendix/deprecated-v8-content" not in content:
                violations.append(fpath)
        except:
            pass

if violations:
    print(f"FAIL: {len(violations)} files reference deprecated content without appendix prefix:")
    for v in violations[:10]:
        print(f"  {v}")
    sys.exit(1)
else:
    print("PASS: no deprecated references in normative files")
