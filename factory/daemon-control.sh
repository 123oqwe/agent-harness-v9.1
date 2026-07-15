#!/usr/bin/env bash
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.agent-harness.factory.plist"

case "${1:-status}" in
    start)
        launchctl load "$PLIST" 2>/dev/null || true
        echo "Factory daemon started"
        ;;
    stop)
        launchctl unload "$PLIST" 2>/dev/null || true
        echo "Factory daemon stopped"
        ;;
    status)
        if launchctl list 2>/dev/null | grep -q com.agent-harness.factory; then
            echo "Factory daemon: RUNNING"
        else
            echo "Factory daemon: STOPPED"
        fi
        python3 -c "
import json
try:
    d = json.load(open('$BASE_DIR/factory/state-store/state.json'))
    print(f'  daemon_running: {d.get(\"daemon_running\", False)}')
    print(f'  current_phase: {d.get(\"current_phase\", 0)}')
    print(f'  active_worktrees: {len(d.get(\"active_worktrees\", {}))}')
    print(f'  blockers: {sum(1 for b in d.get(\"blockers\",[]) if b[\"status\"]==\"open\")} open')
except: print('  state.json: not found')
"
        ;;
    restart)
        launchctl unload "$PLIST" 2>/dev/null || true
        sleep 2
        launchctl load "$PLIST" 2>/dev/null || true
        echo "Factory daemon restarted"
        ;;
    logs)
        tail -f "$BASE_DIR/factory/state-store/daemon.log"
        ;;
    *)
        echo "Usage: $0 {start|stop|status|restart|logs}"
        ;;
esac
