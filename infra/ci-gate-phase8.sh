#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 factory/phase-gates/gate_runner.py phase8
