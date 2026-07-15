#!/usr/bin/env python3
"""[STUB] Sandbox runner.
Runs test commands in an isolated environment.

NOTE: This module depends on harness code existing.
When harness/ is empty, sandbox runner has nothing to run.

Future implementation:
- Docker container isolation
- Resource limits (CPU, memory, time)
- Network egress policy
- Filesystem isolation
"""
import subprocess, os, datetime, hashlib

def run_command(command, cwd=None, timeout=300, env=None):
    """Run a command in sandboxed environment.
    
    NOTE: Currently runs directly. Future: Docker/container isolation.
    """
    try:
        # Use shell=False with shlex for safety (prevent injection)
        import shlex
        cmd_list = shlex.split(command) if isinstance(command, str) else command
        result = subprocess.run(
            cmd_list, shell=False, capture_output=True, text=True,
            cwd=cwd, timeout=timeout, env=env
        )
        return {
            "command": command,
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "stdout_hash": hashlib.sha256(result.stdout.encode()).hexdigest()[:16] if result.stdout else None,
            "ran_at": datetime.datetime.now().isoformat()
        }
    except subprocess.TimeoutExpired:
        return {
            "command": command,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"TIMEOUT after {timeout}s",
            "ran_at": datetime.datetime.now().isoformat()
        }
    except Exception as e:
        return {
            "command": command,
            "exit_code": -1,
            "stdout": "",
            "stderr": str(e),
            "ran_at": datetime.datetime.now().isoformat()
        }

def run_tests(test_commands, cwd=None):
    """Run multiple test commands.
    
    NOTE: Depends on harness code existing.
    """
    results = []
    for cmd in test_commands:
        result = run_command(cmd, cwd=cwd)
        results.append(result)
        if result["exit_code"] != 0:
            break  # Stop on first failure
    return results
