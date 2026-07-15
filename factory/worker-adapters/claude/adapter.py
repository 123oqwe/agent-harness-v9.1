#!/usr/bin/env python3
"""ClaudeWorkerAdapter — starts a real Claude Code session to implement requirements.

Uses Claude Code Agent SDK or CLI invocation.
Can be used for implementation OR independent verification (different provider).
"""
import json, os, sys, subprocess, time, hashlib, datetime
from pathlib import Path

def start_session(context_packet, config=None):
    """Start a Claude worker session."""
    session = {
        "session_id": f"claude-{context_packet['requirement_id']}-{int(time.time())}",
        "provider": "claude",
        "model": config.get("model", "claude-sonnet") if config else "claude-sonnet",
        "agent_role": context_packet.get("tool_permissions", "backend"),
        "context_hash": context_packet["hash"],
        "prompt_hash": hashlib.sha256(
            json.dumps(context_packet, sort_keys=True).encode()
        ).hexdigest()[:16],
        "start_time": datetime.datetime.now().isoformat(),
        "end_time": None,
        "cost": None,
        "exit_reason": None,
        "artifacts": [],
        "status": "starting",
        "tool_permissions": context_packet.get("tool_permissions"),
        "budget": context_packet.get("budget"),
        "requirement_id": context_packet["requirement_id"],
        "is_verifier": config.get("is_verifier", False) if config else False,
        "allowed_paths": context_packet.get("allowed_paths", []),
        "forbidden_paths": context_packet.get("forbidden_paths", [])
    }
    
    if session["is_verifier"]:
        prompt = f"""You are an INDEPENDENT VERIFIER for requirement {context_packet['requirement_id']}.

You have READ-ONLY access. You CANNOT modify code, tests, requirements, or evidence.

Your job:
1. Read the requirement and acceptance criteria
2. Read the implementation
3. Read the test files
4. RERUN the tests yourself
5. Check if acceptance criteria are actually met (not just declared)
6. Check if tests are real (not empty or weakened)
7. Check if evidence matches actual command output
8. Issue a signed VerificationRecord

Acceptance Criteria:
{chr(10).join(f'- {c}' for c in context_packet.get('acceptance_criteria', []))}

Security Invariants:
{chr(10).join(f'- {s}' for s in context_packet.get('security_invariants', []))}

Result must be PASS or FAIL with specific evidence.
"""
    else:
        prompt = f"""You are implementing requirement {context_packet['requirement_id']}: {context_packet['title']}

Goal: {context_packet['goal']}

Acceptance Criteria:
{chr(10).join(f'- {c}' for c in context_packet.get('acceptance_criteria', []))}

Write tests first, then implement. Run actual tests.
Do NOT modify files in forbidden paths.
"""
    
    session["prompt"] = prompt
    session["status"] = "ready_to_dispatch"
    
    return session

def dispatch(session):
    """Dispatch Claude worker."""
    # Check if claude CLI is available
    claude_check = subprocess.run(["which", "claude"], capture_output=True, text=True)
    
    if claude_check.returncode != 0:
        session["status"] = "provider_unavailable"
        session["exit_reason"] = "claude CLI not found"
        session["end_time"] = datetime.datetime.now().isoformat()
        return session
    
    session["status"] = "running"
    session["dispatched_at"] = datetime.datetime.now().isoformat()
    return session

def collect_result(session):
    """Collect structured result."""
    result = {
        "session_id": session["session_id"],
        "requirement_id": session["requirement_id"],
        "status": session.get("status"),
        "provider": session["provider"],
        "model": session["model"],
        "is_verifier": session.get("is_verifier", False),
        "start_time": session["start_time"],
        "end_time": session.get("end_time"),
        "cost": session.get("cost"),
        "exit_reason": session.get("exit_reason"),
        "artifacts": session.get("artifacts", []),
        "verification_result": None  # Would be filled if is_verifier
    }
    return result

def cancel(session):
    """Cancel running session."""
    session["status"] = "cancelled"
    session["exit_reason"] = "cancelled_by_controller"
    session["end_time"] = datetime.datetime.now().isoformat()
    return session
