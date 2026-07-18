#!/usr/bin/env python3
"""[REAL] Requirement queue.
Maintains a priority-ordered queue of requirements.
Supports atomic pop (only one worker gets a requirement).
"""
import json, os, sys, heapq
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "state-store"))
from state_store import load_state, save_state

PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}

def build_queue(requirements, current_phase, req_status):
    """Build a priority queue from requirements list.
    
    Returns list of (priority_score, req_id, req) tuples, sorted.
    A requirement is queueable if:
    - delivery_phase == current_phase
    - implementation_maturity == "not_started"
    - not already in_progress or verified in req_status
    - all dependencies have implementation_maturity == "verified"
    """
    req_map = {r["id"]: r for r in requirements}
    queue = []
    
    # Count how many other requirements depend on each requirement
    dependents_count = {}
    for req in requirements:
        for dep_id in req.get("dependencies", []):
            dependents_count[dep_id] = dependents_count.get(dep_id, 0) + 1
    
    for req in requirements:
        req_id = req["id"]
        
        if req.get("delivery_phase") != current_phase:
            continue
        if req.get("implementation_maturity") != "not_started":
            continue
        
        runtime_status = req_status.get(req_id, {}).get("status")
        if runtime_status in ("in_progress", "verified"):
            continue
        
        # Check dependencies
        deps = req.get("dependencies", [])
        all_deps_verified = True
        for dep_id in deps:
            dep_req = req_map.get(dep_id)
            if dep_req is None or dep_req.get("implementation_maturity") != "verified":
                all_deps_verified = False
                break
        
        if not all_deps_verified:
            continue
        
        priority = PRIORITY_ORDER.get(req.get("priority", "P3"), 3)
        # Secondary sort: more dependents = higher priority (negative for min-heap)
        deps_count = dependents_count.get(req_id, 0)
        heapq.heappush(queue, (priority, -deps_count, req_id, req))
    
    return queue

def pop_next(queue):
    """Atomically pop the next requirement from queue."""
    if not queue:
        return None
    _, _, req_id, req = heapq.heappop(queue)
    return req

def queue_size(queue):
    """Return queue size."""
    return len(queue)

def list_queueable(requirements, current_phase, req_status):
    """List all queueable requirements without popping."""
    queue = build_queue(requirements, current_phase, req_status)
    return [(req_id, req.get("title", "")) for _, req_id, req in sorted(queue)]
