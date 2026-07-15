#!/usr/bin/env python3
"""Blocker service for the Factory.
When a requirement is blocked, creates a structured HumanActionRequest.
"""
import json, os, sys, datetime
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent / "state-store"))
from state_store import load_state, save_state

BLOCKER_TYPES = [
    "specification_conflict",
    "missing_dependency",
    "real_credential_required",
    "paid_account_required",
    "human_legal_decision",
    "vendor_approval",
    "test_environment_unavailable",
    "security_property_unprovable",
    "undefined_state_transition",
    "external_api_unknown",
    "product_ux_decision",
    "irreversible_infrastructure",
    "provider_unavailable",
    "merge_conflict",
    "budget_exhausted",
    "worker_crash"
]

def create_blocker(requirement_id, blocker_type, evidence, required_decision):
    """Create a structured blocker."""
    if blocker_type not in BLOCKER_TYPES:
        raise ValueError(f"Unknown blocker type: {blocker_type}")
    
    blocker = {
        "blocker_id": f"BLK-{requirement_id}-{int(datetime.datetime.now().timestamp())}",
        "requirement_id": requirement_id,
        "blocker_type": blocker_type,
        "evidence": evidence,
        "required_decision": required_decision,
        "status": "open",
        "created_at": datetime.datetime.now().isoformat(),
        "resolved_at": None,
        "resolved_by": None,
        "resolution": None
    }
    
    state = load_state()
    state.setdefault("blockers", []).append(blocker)
    save_state(state)
    return blocker

def resolve_blocker(blocker_id, resolved_by, resolution):
    """Resolve a blocker."""
    state = load_state()
    for b in state.get("blockers", []):
        if b["blocker_id"] == blocker_id:
            b["status"] = "resolved"
            b["resolved_at"] = datetime.datetime.now().isoformat()
            b["resolved_by"] = resolved_by
            b["resolution"] = resolution
            save_state(state)
            return b
    return None

def list_open_blockers():
    """List all open blockers."""
    state = load_state()
    return [b for b in state.get("blockers", []) if b["status"] == "open"]
