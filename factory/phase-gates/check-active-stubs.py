#!/usr/bin/env python3
"""[REAL] Check for active stubs in harness code.
Scans harness/ for NotImplementedError that would be on active path.
"""
import os, sys, re

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PRODUCT_DIR = os.path.join(BASE, "harness")

if not os.path.exists(PRODUCT_DIR):
    print("PASS: no harness/ directory yet")
    sys.exit(0)

stubs_found = []
for root, dirs, files in os.walk(PRODUCT_DIR):
    for fname in files:
        if not fname.endswith(('.ts', '.js', '.py')):
            continue
        fpath = os.path.join(root, fname)
        try:
            with open(fpath) as f:
                content = f.read()
            # Scan for multiple stub patterns (not just NotImplementedError)
            stub_patterns = [
                "NotImplementedError",
                "return null", "return None", "return undefined",
                "pass  # stub", "pass  # TODO", "pass  # placeholder",
                "throw new Error('not implemented')",
                "throw new Error('TODO')",
                "throw new Error('placeholder')",
            ]
            found_in_file = False
            for pattern in stub_patterns:
                if pattern.lower() in content.lower():
                    lines = content.split('\n')
                    for i, line in enumerate(lines):
                        if pattern.lower() in line.lower():
                            stubs_found.append(f"{fpath}:{i+1}: {line.strip()[:60]}")
                            found_in_file = True
            # Also scan for TODO/FIXME in code (not comments)
            import re
            for i, line in enumerate(content.split('\n')):
                stripped = line.strip()
                if stripped.startswith('#') or stripped.startswith('//'):
                    continue
                if re.search(r'\bTODO\b|\bFIXME\b', line, re.IGNORECASE):
                    stubs_found.append(f"{fpath}:{i+1}: {line.strip()[:60]}")
        except:
            pass

if stubs_found:
    print(f"FAIL: {len(stubs_found)} active stubs found:")
    for s in stubs_found[:10]:
        print(f"  {s}")
    sys.exit(1)
else:
    print("PASS: no active stubs found")
