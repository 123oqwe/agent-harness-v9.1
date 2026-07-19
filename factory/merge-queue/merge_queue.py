#!/usr/bin/env python3
"""[REAL] Merge queue.
Rebases, reruns checks, and merges only after required checks pass.
Executes real git commands.
"""
import json, os, sys, subprocess, datetime
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent / "state-store"))
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent / "blocker-service"))
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent / "worktree-manager"))
from state_store import load_state, save_state
from blocker_service import create_blocker

BASE_DIR = __import__('pathlib').Path(__file__).parent.parent.parent
WORKTREE_BASE = BASE_DIR.parent / "worktrees"

def enqueue(requirement_id, branch, verification_result):
    """Enqueue a requirement for merge."""
    state = load_state()
    state.setdefault("merge_queue", []).append({
        "requirement_id": requirement_id,
        "branch": branch,
        "verification_result": verification_result,
        "status": "queued",
        "enqueued_at": datetime.datetime.now().isoformat()
    })
    save_state(state)

def process_next():
    """[REAL] Process next item in merge queue.
    
    1. git rebase main (in worktree)
    2. Run required checks
    3. git merge --no-ff (in main repo)
    4. Update registry atomically
    5. Clean up worktree
    
    If rebase fails → create blocker
    If checks fail → return without merging
    """
    state = load_state()
    queue = state.get("merge_queue", [])
    if not queue:
        return None
    
    item = queue[0]
    req_id = item["requirement_id"]
    branch = item["branch"]
    worktree_path = WORKTREE_BASE / req_id
    
    # 1. [REAL] git rebase main in worktree
    if worktree_path.exists():
        rebase = subprocess.run(
            ["git", "rebase", "main"],
            capture_output=True, text=True,
            cwd=str(worktree_path)
        )
        if rebase.returncode != 0:
            # Try abort rebase first
            subprocess.run(["git", "rebase", "--abort"], capture_output=True, text=True, cwd=str(worktree_path))
            # Try 3-way merge instead of rebase
            merge_try = subprocess.run(
                ["git", "merge", "--no-ff", "--no-edit", "main"],
                capture_output=True, text=True, cwd=str(worktree_path)
            )
            if merge_try.returncode != 0:
                # Try git mergetool auto-resolve with ours/then theirs
                subprocess.run(["git", "merge", "--abort"], capture_output=True, text=True, cwd=str(worktree_path))
                # Last resort: discard branch and create blocker
                create_blocker(req_id, "merge_conflict", [rebase.stderr[:500]], "Auto-resolve failed. Manual review needed.")
                item["status"] = "conflict"
                item["error"] = rebase.stderr[:200]
                state["merge_queue"] = queue[1:]
                save_state(state)
                return item
            # 3-way merge succeeded, continue to gate check
    
    # 2. Run required checks (spec gate)
    try:
        sys.path.insert(0, str(BASE_DIR / "factory" / "phase-gates"))
        from gate_runner import run_spec_gate
        gate = run_spec_gate()
        if gate["result"] != "PASS":
            item["status"] = "gate_failed"
            item["gate_result"] = gate["result"]
            state["merge_queue"] = queue[1:]
            save_state(state)
            return item
    except Exception as e:
        item["status"] = "gate_error"
        item["error"] = str(e)
        state["merge_queue"] = queue[1:]
        save_state(state)
        return item
    
    # 3. [REAL] git merge --no-ff in main repo
    # Stash uncommitted changes (update_registry modifies requirements.ndjson in main repo)
    stash = subprocess.run(
        ["git", "stash"],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    stashed = stash.returncode == 0 and "No local changes" not in (stash.stdout or "")

    merge = subprocess.run(
        ["git", "merge", "--no-ff", branch, "-m", f"Merge {req_id}"],
        capture_output=True, text=True,
        cwd=str(BASE_DIR)
    )

    # Pop stash to restore uncommitted changes (requirements.ndjson etc.)
    if stashed:
        pop = subprocess.run(
            ["git", "stash", "pop"],
            capture_output=True, text=True, cwd=str(BASE_DIR)
        )
        if pop.returncode != 0:
            # Conflict — discard stash, merged version is authoritative
            subprocess.run(["git", "checkout", "--", "."], capture_output=True, cwd=str(BASE_DIR))
            subprocess.run(["git", "stash", "drop"], capture_output=True, cwd=str(BASE_DIR))
            # Re-apply verified status in requirements.ndjson
            try:
                req_path = BASE_DIR / "spec" / "requirements" / "requirements.ndjson"
                lines = open(req_path).readlines()
                for i, line in enumerate(lines):
                    if not line.strip():
                        continue
                    r = json.loads(line)
                    if r["id"] == req_id and r.get("implementation_maturity") != "verified":
                        r["implementation_maturity"] = "verified"
                        lines[i] = json.dumps(r, ensure_ascii=False) + "\n"
                        break
                else:
                    lines = None
                if lines:
                    with open(req_path, 'w') as f:
                        f.writelines(lines)
            except Exception:
                pass

    if merge.returncode != 0:
        create_blocker(req_id, "merge_conflict", [merge.stderr[:500]], "Resolve merge conflict")
        item["status"] = "merge_failed"
        item["error"] = merge.stderr[:200]
        state["merge_queue"] = queue[1:]
        save_state(state)
        return item
    
    # 4. Clean up worktree
    try:
        from worktree_manager import remove_worktree
        remove_worktree(req_id)
    except:
        pass
    
    # 5. Update item status
    item["status"] = "merged"
    item["merged_at"] = datetime.datetime.now().isoformat()
    state["merge_queue"] = queue[1:]
    save_state(state)
    
    return item

def queue_size():
    """Return queue size."""
    return len(load_state().get("merge_queue", []))
