#!/usr/bin/env bash
set -euo pipefail
echo "=== Gate: Specification Validation ==="
python3 scripts/validate-specification.py
echo "=== Gate: Specification PASSED ==="
