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
            # Rebase conflict → create blocker
            create_blocker(req_id, "merge_conflict", [rebase.stderr[:500]], "Resolve conflict or discard branch")
            item["status"] = "conflict"
            item["error"] = rebase.stderr[:200]
            state["merge_queue"] = queue[1:]
            save_state(state)
            return item
    
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
    merge = subprocess.run(
        ["git", "merge", "--no-ff", branch, "-m", f"Merge {req_id}"],
        capture_output=True, text=True,
        cwd=str(BASE_DIR)
    )
    
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
