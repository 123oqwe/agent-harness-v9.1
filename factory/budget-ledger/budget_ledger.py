#!/usr/bin/env python3
"""Budget ledger for the Factory.
Tracks all costs: model calls, tool costs, verification costs, external effects.
"""
import json, os, sys, datetime
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent / "state-store"))
from state_store import load_state, save_state

def reserve(requirement_id, amount_usd_micros, category="model"):
    """Reserve budget for a requirement."""
    state = load_state()
    ledger = state.setdefault("budget_ledger", {})
    req_budget = ledger.setdefault(requirement_id, {
        "reserved": {}, "consumed": {}, "remaining": 0
    })
    req_budget["reserved"][category] = req_budget["reserved"].get(category, 0) + int(amount_usd_micros)
    save_state(state)

def consume(requirement_id, actual_usd_micros, category="model"):
    """Consume budget (actual cost)."""
    state = load_state()
    ledger = state.setdefault("budget_ledger", {})
    req_budget = ledger.setdefault(requirement_id, {
        "reserved": {}, "consumed": {}, "remaining": 0
    })
    req_budget["consumed"][category] = req_budget["consumed"].get(category, 0) + int(actual_usd_micros)
    save_state(state)

def check_budget(requirement_id, requested_usd_micros):
    """Check if budget is available."""
    state = load_state()
    ledger = state.get("budget_ledger", {})
    req_budget = ledger.get(requirement_id, {})
    reserved = sum(req_budget.get("reserved", {}).values())
    consumed = sum(req_budget.get("consumed", {}).values())
    remaining = reserved - consumed
    return remaining >= int(requested_usd_micros)
