#!/usr/bin/env bash
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "$1" ]; then
    echo "Usage: $0 <blocker_id> <resolution>"
    echo ""
    echo "Open blockers:"
    python3 -c "
import sys, json
sys.path.insert(0, '$BASE_DIR/factory/state-store')
sys.path.insert(0, '$BASE_DIR/factory/blocker-service')
from blocker_service import list_open_blockers
for b in list_open_blockers():
    print(f'  {b[\"blocker_id\"]}: {b[\"blocker_type\"]} - {b.get(\"required_decision\",\"\")}')
" 2>/dev/null || echo "  (no blockers or state not found)"
    exit 1
fi
python3 -c "
import sys, json
sys.path.insert(0, '$BASE_DIR/factory/state-store')
sys.path.insert(0, '$BASE_DIR/factory/blocker-service')
from blocker_service import resolve_blocker, list_open_blockers
blocker_id = '$1'
resolution = '${2:-resolved by human}'
result = resolve_blocker(blocker_id, 'human', resolution)
if result:
    print(f'Blocker {blocker_id} resolved: {resolution}')
    print('Factory daemon will auto-resume on next poll cycle.')
else:
    print(f'Blocker {blocker_id} not found')
"
