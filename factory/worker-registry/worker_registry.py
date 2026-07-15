#!/usr/bin/env python3
"""[REAL] Worker registry.
Registers and queries available workers (Codex, Claude).
Tracks worker capabilities, status, and assignment.
"""
import json, os, sys, subprocess, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "state-store"))
from state_store import load_state, save_state

def check_provider_available(provider):
    """[REAL] Check if a provider CLI is actually available."""
    cli_map = {"codex": "codex", "claude": "claude"}
    cli = cli_map.get(provider)
    if not cli:
        return False, f"Unknown provider: {provider}"
    
    result = subprocess.run(["which", cli], capture_output=True, text=True)
    if result.returncode != 0:
        return False, f"{cli} CLI not found"
    
    return True, f"{cli} available at {result.stdout.strip()}"

def register_worker(provider, model, capabilities):
    """Register a worker in the registry."""
    state = load_state()
    state.setdefault("worker_registry", {})[provider] = {
        "provider": provider,
        "model": model,
        "capabilities": capabilities,
        "registered_at": datetime.datetime.now().isoformat(),
        "status": "registered"
    }
    save_state(state)
    return state["worker_registry"][provider]

def get_worker(provider):
    """Get worker info."""
    state = load_state()
    return state.get("worker_registry", {}).get(provider)

def list_workers():
    """List all registered workers."""
    state = load_state()
    return list(state.get("worker_registry", {}).values())

def assign_worker_for_role(role):
    """[REAL] Assign the appropriate worker for a role.
    
    Rules:
    - backend, frontend, devops, runtime, routing, rag-memory → codex
    - security, privacy → claude (different provider for security)
    - independent-verifier → claude (different from implementer)
    - cto_orchestrator → None (CTO doesn't implement)
    """
    role_map = {
        "backend": "codex",
        "frontend": "codex",
        "devops": "codex",
        "runtime": "codex",
        "routing": "codex",
        "rag-memory": "codex",
        "security": "claude",
        "privacy": "claude",
        "independent-verifier": "claude",
        "cto_orchestrator": None,
    }
    provider = role_map.get(role, "codex")
    
    if provider is None:
        return None, "CTO does not implement"
    
    available, detail = check_provider_available(provider)
    if not available:
        return None, detail
    
    return provider, detail

def update_worker_status(provider, status):
    """Update worker status."""
    state = load_state()
    if provider in state.get("worker_registry", {}):
        state["worker_registry"][provider]["status"] = status
        state["worker_registry"][provider]["updated_at"] = datetime.datetime.now().isoformat()
        save_state(state)
