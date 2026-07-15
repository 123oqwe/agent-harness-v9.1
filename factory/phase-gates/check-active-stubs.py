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
            if "NotImplementedError" in content:
                # Check if it returns a default value instead of throwing
                lines = content.split('\n')
                for i, line in enumerate(lines):
                    if "NotImplementedError" in line:
                        stubs_found.append(f"{fpath}:{i+1}")
        except:
            pass

if stubs_found:
    print(f"FAIL: {len(stubs_found)} active stubs found:")
    for s in stubs_found[:10]:
        print(f"  {s}")
    sys.exit(1)
else:
    print("PASS: no active stubs found")
