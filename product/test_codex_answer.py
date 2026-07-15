"""Tests for TEST-CODEX-001: Test Codex Popen.

Goal: Reply with the number 42.
Acceptance Criteria: Output contains 42.

The test invokes the implementation as a subprocess (Popen) and asserts the
captured stdout contains "42".
"""

import os
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.join(_HERE, "codex_answer.py")


class CodexAnswerTest(unittest.TestCase):
    def test_output_contains_42(self):
        proc = subprocess.Popen(
            [sys.executable, IMPL],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout, stderr = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 0, f"stderr: {stderr}")
        self.assertIn("42", stdout, f"expected '42' in output, got: {stdout!r}")


if __name__ == "__main__":
    unittest.main()
