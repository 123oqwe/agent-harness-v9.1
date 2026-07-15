#!/usr/bin/env python3
"""[REAL] ClaudeWorkerAdapter — starts a real Claude Code session.

Uses: claude -p --output-format json <prompt>
Can be used for implementation OR independent verification (different provider).
"""
import json, os, sys, subprocess, time, hashlib, datetime, signal
from pathlib import Path

def start_session(context_packet, config=None):
    """[REAL] Start a Claude worker session."""
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
        "forbidden_paths": context_packet.get("forbidden_paths", []),
        "worktree_path": config.get("worktree_path") if config else None,
        "proc": None,
        "stdout": None,
        "stderr": None,
        "exit_code": None
    }
    
    if session["is_verifier"]:
        prompt = f"""You are an INDEPENDENT VERIFIER for requirement {context_packet['requirement_id']}.

You have READ-ONLY access. You CANNOT modify code, tests, requirements, or evidence.

Your job:
1. Read the requirement and acceptance criteria
2. Read the implementation
3. Read the test files
4. RERUN the tests yourself
5. Check if acceptance criteria are actually met
6. Check if tests are real (not empty or weakened)
7. Issue a PASS or FAIL result with specific evidence

Acceptance Criteria:
{chr(10).join(f'- {c}' for c in context_packet.get('acceptance_criteria', []))}

Security Invariants:
{chr(10).join(f'- {s}' for s in context_packet.get('security_invariants', []))}
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

def dispatch(session, timeout=600):
    """[REAL] Dispatch Claude worker — actually Popen claude -p.
    
    Executes: claude -p --output-format json <prompt>
    Captures stdout, stderr, exit code.
    """
    claude_check = subprocess.run(["which", "claude"], capture_output=True, text=True)
    if claude_check.returncode != 0:
        session["status"] = "provider_unavailable"
        session["exit_reason"] = "claude CLI not found"
        session["end_time"] = datetime.datetime.now().isoformat()
        return session
    
    # Build command
    cmd = ["claude", "-p", "--output-format", "json"]
    
    # For verifier: read-only mode
    if session.get("is_verifier"):
        cmd.append("--allowedTools")
        cmd.append("Read")  # Read-only
    
    # Add prompt
    cmd.append(session["prompt"])
    
    # Set working directory
    cwd = session.get("worktree_path")
    if cwd and not os.path.exists(cwd):
        cwd = None
    
    session["dispatch_command"] = " ".join(cmd[:4]) + " ..."
    session["status"] = "running"
    session["dispatched_at"] = datetime.datetime.now().isoformat()
    
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            text=True,
            preexec_fn=os.setsid
        )
        session["proc"] = proc
        session["pid"] = proc.pid
        
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            session["stdout"] = stdout
            session["stderr"] = stderr
            session["exit_code"] = proc.returncode
            session["status"] = "completed" if proc.returncode == 0 else "failed"
            session["exit_reason"] = "success" if proc.returncode == 0 else f"exit_code={proc.returncode}"
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            stdout, stderr = proc.communicate(timeout=10)
            session["stdout"] = stdout
            session["stderr"] = stderr + f"\nTIMEOUT after {timeout}s"
            session["exit_code"] = -1
            session["status"] = "timeout"
            session["exit_reason"] = f"timeout after {timeout}s"
            
    except Exception as e:
        session["status"] = "failed"
        session["exit_reason"] = str(e)
        session["exit_code"] = -1
    
    session["end_time"] = datetime.datetime.now().isoformat()
    return session

def collect_result(session):
    """[REAL] Collect structured result."""
    result = {
        "session_id": session["session_id"],
        "requirement_id": session["requirement_id"],
        "status": session.get("status"),
        "provider": session["provider"],
        "model": session["model"],
        "is_verifier": session.get("is_verifier", False),
        "start_time": session["start_time"],
        "end_time": session.get("end_time"),
        "exit_code": session.get("exit_code"),
        "exit_reason": session.get("exit_reason"),
        "pid": session.get("pid"),
        "stdout": session.get("stdout", ""),
        "stderr": session.get("stderr", ""),
        "stdout_hash": hashlib.sha256(
            (session.get("stdout") or "").encode()
        ).hexdigest()[:16] if session.get("stdout") else None,
        "dispatch_command": session.get("dispatch_command"),
        "artifacts": session.get("artifacts", []),
    }
    return result

def cancel(session):
    """[REAL] Cancel running session."""
    if session.get("proc") and session.get("pid"):
        try:
            os.killpg(os.getpgid(session["pid"]), signal.SIGTERM)
        except ProcessLookupError:
            pass
    session["status"] = "cancelled"
    session["exit_reason"] = "cancelled_by_controller"
    session["end_time"] = datetime.datetime.now().isoformat()
    return session
