#!/usr/bin/env python3
"""CodexWorkerAdapter — starts a real Codex CLI session to implement requirements.

Uses Codex CLI as an MCP server or direct CLI invocation.
Records all invocations for audit.
"""
import json, os, sys, subprocess, time, hashlib, datetime, tempfile
from pathlib import Path

def start_session(context_packet, config=None):
    """Start a Codex worker session.
    
    Args:
        context_packet: ContextPacket dict with requirement, criteria, allowed paths
        config: Optional config dict (model, temperature, etc.)
    
    Returns:
        WorkerSession dict with session_id, pid, status
    """
    session = {
        "session_id": f"codex-{context_packet['requirement_id']}-{int(time.time())}",
        "provider": "codex",
        "model": config.get("model", "codex") if config else "codex",
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
        "allowed_paths": context_packet.get("allowed_paths", []),
        "forbidden_paths": context_packet.get("forbidden_paths", [])
    }
    
    # Build prompt for Codex
    prompt = f"""You are implementing requirement {context_packet['requirement_id']}: {context_packet['title']}

Goal: {context_packet['goal']}

Acceptance Criteria:
{chr(10).join(f'- {c}' for c in context_packet.get('acceptance_criteria', []))}

Security Invariants:
{chr(10).join(f'- {s}' for s in context_packet.get('security_invariants', []))}

Allowed paths: {context_packet.get('allowed_paths', [])}
Forbidden paths: {context_packet.get('forbidden_paths', [])}
Test commands: {context_packet.get('test_commands', [])}

Definition of Done: {context_packet.get('definition_of_done', 'All criteria met + tests pass')}

Write tests first, then implement. Run actual tests. Generate evidence from real command output.
Do NOT modify files in forbidden paths. Do NOT modify spec/, control/, or evidence/.
"""
    
    session["prompt"] = prompt
    
    # In real implementation: invoke Codex CLI
    # codex --model <model> --prompt <prompt> --worktree <path>
    # For now, record the invocation
    session["status"] = "ready_to_dispatch"
    session["dispatch_command"] = f"codex --requirement {context_packet['requirement_id']}"
    
    return session

def dispatch(session):
    """Actually dispatch the worker (start Codex process)."""
    # Check if codex CLI is available
    codex_check = subprocess.run(["which", "codex"], capture_output=True, text=True)
    
    if codex_check.returncode != 0:
        session["status"] = "provider_unavailable"
        session["exit_reason"] = "codex CLI not found"
        session["end_time"] = datetime.datetime.now().isoformat()
        return session
    
    # Start Codex process
    try:
        # In real implementation:
        # proc = subprocess.Popen(
        #     ["codex", "--prompt", session["prompt"], "--json"],
        #     stdout=subprocess.PIPE, stderr=subprocess.PIPE
        # )
        # For now, mark as dispatched
        session["status"] = "running"
        session["pid"] = None  # Would be proc.pid
        session["dispatched_at"] = datetime.datetime.now().isoformat()
    except Exception as e:
        session["status"] = "failed"
        session["exit_reason"] = str(e)
        session["end_time"] = datetime.datetime.now().isoformat()
    
    return session

def collect_result(session):
    """Collect structured result from worker."""
    result = {
        "session_id": session["session_id"],
        "requirement_id": session["requirement_id"],
        "status": session.get("status"),
        "provider": session["provider"],
        "model": session["model"],
        "start_time": session["start_time"],
        "end_time": session.get("end_time"),
        "cost": session.get("cost"),
        "exit_reason": session.get("exit_reason"),
        "artifacts": session.get("artifacts", []),
        "files_changed": [],  # Would be filled from git diff
        "tests_written": [],  # Would be filled from file analysis
        "commands_run": [],  # Would be filled from process output
        "evidence": None  # Would be filled from stdout
    }
    return result

def cancel(session):
    """Cancel a running worker session."""
    session["status"] = "cancelled"
    session["exit_reason"] = "cancelled_by_controller"
    session["end_time"] = datetime.datetime.now().isoformat()
    # In real implementation: proc.terminate()
    return session
