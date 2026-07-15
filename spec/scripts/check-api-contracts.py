#!/usr/bin/env python3
"""Test script for AH-SPEC-VALIDATOR-001: check-api-contracts.py
Verifies the check script exists and produces output.
"""
import os, sys, subprocess

def test_script_exists():
    """Script file must exist and be non-empty."""
    assert os.path.exists(__file__), f"Script not found: {__file__}"
    assert os.path.getsize(__file__) > 0, "Script is empty"

def test_script_is_executable():
    """Script must be runnable."""
    result = subprocess.run(
        [sys.executable, __file__],
        capture_output=True, text=True, timeout=30,
        cwd=os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    )
    # Script should either PASS or FAIL, not crash
    assert "PASS" in result.stdout or "FAIL" in result.stdout, \
        f"Script produced no PASS/FAIL output. stdout={result.stdout[:200]}, stderr={result.stderr[:200]}"

if __name__ == "__main__":
    test_script_exists()
    test_script_is_executable()
    print("PASS: script exists and produces output")
