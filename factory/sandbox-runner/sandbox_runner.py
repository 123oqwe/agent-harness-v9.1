#!/usr/bin/env python3
"""Sandbox runner with process-level isolation.

Phase 1: Uses subprocess + resource limits (no Docker needed).
Phase 7: Upgrade to Docker/MicroVM (see ADR).
"""
import subprocess, os, datetime, hashlib, shlex, resource

def run_command(command, cwd=None, timeout=300, env=None, max_memory_mb=512):
    """Run a command with process-level isolation.
    
    Isolation measures:
    - Separate process (not inline)
    - CPU time limit (timeout)
    - Memory limit (setrlimit RLIMIT_AS)
    - Restricted environment variables
    - No network policy (Phase 7: add network namespace)
    """
    cmd_list = shlex.split(command) if isinstance(command, str) else command
    
    def set_limits():
        if max_memory_mb:
            mem_bytes = max_memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
        resource.setrlimit(resource.RLIMIT_CPU, (timeout, timeout + 5))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    
    safe_env = {}
    if env:
        safe_env.update(env)
    else:
        safe_env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('OPENAI_', 'ANTHROPIC_', 'AWS_', 'GCP_'))}
    safe_env["PATH"] = os.environ.get("PATH", "/usr/bin:/bin")
    
    try:
        result = subprocess.run(
            cmd_list, shell=False, capture_output=True, text=True,
            cwd=cwd, timeout=timeout, env=safe_env,
            preexec_fn=set_limits
        )
        return {
            "command": command,
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "stdout_hash": hashlib.sha256(result.stdout.encode()).hexdigest()[:16] if result.stdout else None,
            "sandbox": "process_level",
            "memory_limit_mb": max_memory_mb,
            "timeout_s": timeout,
            "ran_at": datetime.datetime.now().isoformat()
        }
    except subprocess.TimeoutExpired:
        return {
            "command": command,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"TIMEOUT after {timeout}s",
            "sandbox": "process_level",
            "ran_at": datetime.datetime.now().isoformat()
        }
    except Exception as e:
        return {
            "command": command,
            "exit_code": -1,
            "stdout": "",
            "stderr": str(e),
            "sandbox": "process_level",
            "ran_at": datetime.datetime.now().isoformat()
        }

def run_tests(test_commands, cwd=None):
    results = []
    for cmd in test_commands:
        result = run_command(cmd, cwd=cwd)
        results.append(result)
        if result["exit_code"] != 0:
            break
    return results
