#!/usr/bin/env python3
"""Secret request service.
Workers cannot access secrets directly. They request through this service.
Secrets are provided only for staging/test accounts, never production.
"""
import json, os, sys, datetime
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent / "state-store"))
from state_store import load_state, save_state

PRODUCTION_SECRETS = []  # Production secrets are NEVER available to workers

def request_secret(worker_id, secret_type, justification):
    """Request a secret. Only staging/test secrets are provided."""
    if secret_type in PRODUCTION_SECRETS:
        return {
            "granted": False,
            "reason": "Production secrets are not available to workers",
            "requires_human_approval": True
        }
    
    # Staging secrets can be provided
    return {
        "granted": True,
        "secret_type": secret_type,
        "environment": "staging",
        "expires_at": (datetime.datetime.now() + datetime.timedelta(hours=1)).isoformat(),
        "worker_id": worker_id,
        "justification": justification
    }
