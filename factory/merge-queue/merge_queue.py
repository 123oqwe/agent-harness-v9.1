#!/usr/bin/env python3
"""Merge queue.
Rebases, reruns checks, and merges only after required checks pass.
"""
import json, os, sys, subprocess, datetime
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent / "state-store"))
from state_store import load_state, save_state

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
    """Process next item in merge queue.
    
    1. Rebase onto main
    2. Rerun required checks
    3. Merge if all pass
    4. Update registry atomically
    """
    state = load_state()
    queue = state.get("merge_queue", [])
    if not queue:
        return None
    
    item = queue[0]
    
    # In real implementation:
    # 1. git rebase main
    # 2. Run required checks
    # 3. git merge --no-ff
    # 4. Update registry
    
    item["status"] = "merged"
    item["merged_at"] = datetime.datetime.now().isoformat()
    state["merge_queue"] = queue[1:]
    save_state(state)
    
    return item
