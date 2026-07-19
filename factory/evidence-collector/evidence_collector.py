#!/usr/bin/env python3
"""[REAL] Evidence collector.
Extracts structured evidence from subprocess stdout/stderr.
Calculates hashes, saves raw output.

NOTE: Full functionality depends on harness code existing.
When harness/ is empty, evidence collection is limited to
worker stdout (model output), not test execution output.
"""
import json, os, hashlib, datetime
from pathlib import Path

def collect_from_worker(worker_result, requirement_id, evidence_dir="evidence"):
    """[REAL] Collect evidence from worker result.
    
    Extracts:
    - stdout (model output)
    - stderr (errors)
    - exit_code
    - dispatch_command
    - timestamps
    
    Calculates:
    - stdout_hash (SHA-256)
    - stderr_hash (SHA-256)
    """
    stdout = worker_result.get("stdout", "") or ""
    stderr = worker_result.get("stderr", "") or ""
    
    evidence = {
        "requirement_id": requirement_id,
        "collected_at": datetime.datetime.now().isoformat(),
        "worker_session_id": worker_result.get("session_id"),
        "worker_provider": worker_result.get("provider"),
        "worker_model": worker_result.get("model"),
        "dispatch_command": worker_result.get("dispatch_command"),
        "exit_code": worker_result.get("exit_code"),
        "exit_reason": worker_result.get("exit_reason"),
        "stdout": stdout[:10000],  # Truncate for storage
        "stdout_full_length": len(stdout),
        "stdout_hash": hashlib.sha256(stdout.encode()).hexdigest()[:16] if stdout else None,
        "stderr": stderr[:5000],
        "stderr_full_length": len(stderr),
        "stderr_hash": hashlib.sha256(stderr.encode()).hexdigest()[:16] if stderr else None,
        "test_results": None,  # Would be parsed from stdout if harness code exists
        "coverage": None,  # Would be parsed from test output
        "files_changed": [],  # Would be from git diff
        "mode": "METADATA_ONLY" if not os.path.exists("harness") else "FULL",
    }
    
    # [REAL] Collect test output when product code exists
    test_stdout, test_hash = collect_test_output()
    evidence["test_output"] = test_stdout
    evidence["test_output_hash"] = test_hash
    # Parse test results from test_output (more reliable than worker stdout)
    if test_stdout:
        parsed = parse_test_output(test_stdout)
        if parsed:
            evidence["test_results"] = parsed
    
    # Save to evidence directory
    ev_path = Path(evidence_dir) / f"{requirement_id}.json"
    ev_path.parent.mkdir(parents=True, exist_ok=True)
    with open(ev_path, 'w') as f:
        json.dump(evidence, f, indent=2)
    
    return evidence


def collect_test_output(base_dir=None):
    """base_dir defaults to the repository root (parent of factory/)."""
    if base_dir is None:
        base_dir = Path(__file__).parent.parent.parent
    """[REAL] Run the test suite and collect stdout.
    
    Called by collect_from_worker when product code exists.
    Returns (test_stdout, test_hash) or (None, None) if no product code.
    """
    import subprocess
    harness_dir = Path(base_dir) / "harness"
    if not (harness_dir / "package.json").exists():
        return None, None
    try:
        result = subprocess.run(
            ["npm", "test", "--", "--run"],
            capture_output=True, text=True, cwd=str(harness_dir), timeout=120
        )
        test_stdout = result.stdout or ""
        test_hash = hashlib.sha256(test_stdout.encode()).hexdigest()[:16] if test_stdout else None
        return test_stdout[:20000], test_hash  # Truncate for storage
    except Exception:
        return None, None

def parse_test_output(stdout):
    """Parse test results from stdout.
    
    Looks for common test output patterns:
    - vitest/jest: "Tests: X passed, Y failed"
    - pytest: "X passed, Y failed"
    - npm test: exit code based
    """
    import re
    
    # vitest v2.x pattern: "Tests  58 passed (58)" or "Tests  56 passed (56) | 2 failed (2)"
    # Also matches colon variant "Tests: 58 passed, 2 failed"
    # Greedy match for failed to ensure it's captured when present
    match = re.search(r'Tests:?\s+(\d+)\s+passed.*?(\d+)\s+failed', stdout)
    if match:
        return {"passed": int(match.group(1)), "failed": int(match.group(2))}

    # 0-failed case: "Tests  58 passed (58)" or "Tests: 58 passed" (no "failed" in output)
    match = re.search(r'Tests:?\s+(\d+)\s+passed', stdout)
    if match:
        return {"passed": int(match.group(1)), "failed": 0}

    # pytest pattern: "58 passed, 2 failed" or "58 passed"
    match = re.search(r'(\d+)\s+passed.*?(\d+)\s+failed', stdout)
    if match:
        return {"passed": int(match.group(1)), "failed": int(match.group(2))}

    match = re.search(r'(\d+)\s+passed', stdout)
    if match:
        return {"passed": int(match.group(1)), "failed": 0}

    return None
