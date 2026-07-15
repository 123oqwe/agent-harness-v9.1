#!/usr/bin/env bash
set -euo pipefail
echo "=== Gate: Phase 1 ==="

# 1. Specification validation must pass
python3 scripts/validate-specification.py

# 2. All phase requirements must be verified
python3 -c "
import json, sys
with open('requirements/requirements.ndjson') as f:
    reqs = [json.loads(l) for l in f if l.strip()]
phase_reqs = [r for r in reqs if r.get('delivery_phase') == 1]
if not phase_reqs:
    print('FAIL: Phase 1 has no requirements')
    sys.exit(1)
unverified = [r['id'] for r in phase_reqs if r.get('implementation_maturity') != 'verified']
if unverified:
    print(f'FAIL: {len(unverified)} requirements not verified: {unverified[:5]}')
    sys.exit(1)
print(f'PASS: All {len(phase_reqs)} Phase 1 requirements verified')
"

# 3. Phase-specific checks
echo "Phase 1 gate checks complete."
echo "=== Gate: Phase 1 PASSED ==="
