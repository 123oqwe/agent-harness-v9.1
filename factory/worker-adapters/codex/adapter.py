#!/usr/bin/env python3
"""[REAL] CodexWorkerAdapter — starts a real Codex CLI session.

Uses: codex exec --json <prompt>
Records all invocations for audit.
"""
import json, os, sys, subprocess, time, hashlib, datetime, signal
from pathlib import Path

def start_session(context_packet, config=None):
    """[REAL] Start a Codex worker session."""
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
        "forbidden_paths": context_packet.get("forbidden_paths", []),
        "worktree_path": config.get("worktree_path") if config else None,
        "proc": None,
        "stdout": None,
        "stderr": None,
        "exit_code": None
    }
    
    # Build prompt
    prompt = f"""You are implementing requirement {context_packet['requirement_id']}: {context_packet['title']}

Goal: {context_packet['goal']}

Acceptance Criteria:
{chr(10).join(f'- {c}' for c in context_packet.get('acceptance_criteria', []))}

Security Invariants:
{chr(10).join(f'- {s}' for s in context_packet.get('security_invariants', []))}

Test commands: {context_packet.get('test_commands', [])}

Definition of Done: {context_packet.get('definition_of_done', 'All criteria met + tests pass')}

Write tests first, then implement. Run actual tests. Do NOT modify files in forbidden paths.
"""
    
    session["prompt"] = prompt
    session["status"] = "ready_to_dispatch"
    return session

def dispatch(session, timeout=600):
    """[REAL] Dispatch the worker — actually Popen codex exec.
    
    Executes: codex exec --json <prompt>
    Captures stdout, stderr, exit code.
    """
    # Check if codex CLI is available
    codex_check = subprocess.run(["which", "codex"], capture_output=True, text=True)
    if codex_check.returncode != 0:
        session["status"] = "provider_unavailable"
        session["exit_reason"] = "codex CLI not found"
        session["end_time"] = datetime.datetime.now().isoformat()
        return session
    
    # Build command
    cmd = ["codex", "exec", "--json"]
    
    # Add model if specified
    if session.get("model") and session["model"] != "codex":
        cmd.extend(["-m", session["model"]])
    
    # Add sandbox mode (read-write for implementation)
    cmd.extend(["-s", "workspace-write"])
    
    # Add prompt
    cmd.append(session["prompt"])
    
    # Set working directory to worktree if available
    cwd = session.get("worktree_path")
    if cwd and not os.path.exists(cwd):
        cwd = None
    
    session["dispatch_command"] = " ".join(cmd[:3]) + " ..."
    session["status"] = "running"
    session["dispatched_at"] = datetime.datetime.now().isoformat()
    
    try:
        # REAL Popen — actually start the process
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            text=True,
            preexec_fn=os.setsid  # Create new process group for clean kill
        )
        session["proc"] = proc
        session["pid"] = proc.pid
        
        # Wait for completion with timeout
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            session["stdout"] = stdout
            session["stderr"] = stderr
            session["exit_code"] = proc.returncode
            session["status"] = "completed" if proc.returncode == 0 else "failed"
            session["exit_reason"] = "success" if proc.returncode == 0 else f"exit_code={proc.returncode}"
        except subprocess.TimeoutExpired:
            # Kill the process group
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            stdout, stderr = proc.communicate(timeout=10)
            session["stdout"] = stdout
            session["stderr"] = stderr + "\nTIMEOUT after {timeout}s"
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
    """[REAL] Collect structured result from worker."""
    result = {
        "session_id": session["session_id"],
        "requirement_id": session["requirement_id"],
        "status": session.get("status"),
        "provider": session["provider"],
        "model": session["model"],
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
        "stderr_hash": hashlib.sha256(
            (session.get("stderr") or "").encode()
        ).hexdigest()[:16] if session.get("stderr") else None,
        "dispatch_command": session.get("dispatch_command"),
        "artifacts": session.get("artifacts", []),
    }
    return result

def cancel(session):
    """[REAL] Cancel a running worker session — kills the process group."""
    if session.get("proc") and session.get("pid"):
        try:
            os.killpg(os.getpgid(session["pid"]), signal.SIGTERM)
        except ProcessLookupError:
            pass  # Already dead
    session["status"] = "cancelled"
    session["exit_reason"] = "cancelled_by_controller"
    session["end_time"] = datetime.datetime.now().isoformat()
    return session
