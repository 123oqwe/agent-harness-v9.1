#!/usr/bin/env python3
"""Durable state store for the Autonomous Engineering Factory.
Survives process restart. Uses JSON file with atomic writes.
"""
import json, os, fcntl, tempfile
from pathlib import Path

STATE_FILE = os.environ.get("FACTORY_STATE_FILE", "factory/state-store/state.json")

def _lock():
    lock_file = STATE_FILE + ".lock"
    fd = open(lock_file, 'w')
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd

def _unlock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN)
    fd.close()

def load_state():
    """Load factory state. Returns default if not exists."""
    if not os.path.exists(STATE_FILE):
        return {
            "factory_version": "0.1.0",
            "current_phase": 0,
            "current_requirement": None,
            "active_worktrees": {},
            "worker_leases": {},
            "requirement_status": {},
            "phase_status": {"0": "BLOCKED"},
            "command_history": [],
            "evidence_refs": {},
            "verifier_results": {},
            "merge_queue": [],
            "blockers": [],
            "created_at": datetime.datetime.now().isoformat(),
            "updated_at": datetime.datetime.now().isoformat(),
            "restart_count": 0
        }
    with open(STATE_FILE) as f:
        return json.load(f)

def save_state(state):
    """Atomically save factory state."""
    fd = _lock()
    try:
        state["updated_at"] = datetime.datetime.now().isoformat()
        tmp = STATE_FILE + ".tmp"
        with open(tmp, 'w') as f:
            json.dump(state, f, indent=2)
        os.rename(tmp, STATE_FILE)  # atomic
    finally:
        _unlock(fd)

def update(key, value):
    """Update a single key in state."""
    state = load_state()
    state[key] = value
    save_state(state)
    return state

def append_to_list(key, item):
    """Append item to a list in state."""
    state = load_state()
    if key not in state:
        state[key] = []
    state[key].append(item)
    save_state(state)
    return state

def get(key, default=None):
    """Get a key from state."""
    return load_state().get(key, default)

def atomic_check_and_set(dict_key, item_key, value, check_fn=None):
    """[REAL] Atomically check-and-set an item inside a dict in state.
    
    The entire check-and-set is protected by flock — no TOCTOU gap.
    If check_fn returns False (or item_key already exists and check_fn is None),
    the operation is rejected and returns (False, None).
    Otherwise, the value is set and returns (True, state).
    
    Usage:
        # Atomic lock: only succeeds if req_id NOT already in active_worktrees
        success, state = atomic_check_and_set(
            "active_worktrees", req_id, lock_info
        )
        if not success:
            # Already locked
    """
    fd = _lock()
    try:
        # Reload state under lock — this is the key: load AND save are both inside flock
        if not os.path.exists(STATE_FILE):
            state = {
                "factory_version": "0.1.0",
                "current_phase": 0,
                "current_requirement": None,
                "active_worktrees": {},
                "worker_leases": {},
                "requirement_status": {},
                "phase_status": {"0": "BLOCKED"},
                "command_history": [],
                "evidence_refs": {},
                "verifier_results": {},
                "merge_queue": [],
                "blockers": [],
                "created_at": datetime.datetime.now().isoformat(),
                "updated_at": datetime.datetime.now().isoformat(),
                "restart_count": 0
            }
        else:
            with open(STATE_FILE) as f:
                state = json.load(f)
        
        target_dict = state.get(dict_key, {})
        
        # Check: if check_fn provided, use it; otherwise check item_key not in dict
        if check_fn is not None:
            allowed, reason = check_fn(state)
            if not allowed:
                return False, state
        else:
            if item_key in target_dict:
                return False, state
        
        # Set
        target_dict[item_key] = value
        state[dict_key] = target_dict
        state["updated_at"] = datetime.datetime.now().isoformat()
        
        # Atomic write (still inside flock)
        tmp = STATE_FILE + ".tmp"
        with open(tmp, 'w') as f:
            json.dump(state, f, indent=2)
        os.rename(tmp, STATE_FILE)
        
        return True, state
    finally:
        _unlock(fd)

import datetime
