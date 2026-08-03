#!/usr/bin/env python3
"""Bounded process supervisor for immutable, build-pinned Python host bytes."""

import base64
import json
import os
import signal
import subprocess
import sys
import tempfile
import time


def fail(message):
    sys.stdout.write(json.dumps({"ok": False, "error": message}))
    raise SystemExit(1)


def process_tree(root_pid):
    try:
        output = subprocess.check_output(
            ["/bin/ps", "-axo", "pid=,ppid="],
            text=True,
            timeout=1.0,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        )
    except Exception:
        return set()
    children = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) != 2:
            continue
        pid, parent = map(int, fields)
        children.setdefault(parent, []).append(pid)
    found = set()
    pending = [root_pid]
    while pending:
        parent = pending.pop()
        for child in children.get(parent, []):
            if child not in found:
                found.add(child)
                pending.append(child)
    return found


def kill_recorded(process, recorded):
    kill_pid_tree(process.pid, recorded)
    try:
        process.wait(timeout=0.2)
    except subprocess.TimeoutExpired:
        pass


def kill_pid_tree(root_pid, recorded):
    targets = set(recorded)
    targets.add(root_pid)
    try:
        os.kill(root_pid, signal.SIGSTOP)
    except ProcessLookupError:
        pass
    time.sleep(0.05)
    targets.update(process_tree(root_pid))
    try:
        os.killpg(root_pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    for pid in sorted(targets, reverse=True):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    time.sleep(0.2)
    for pid in sorted(targets, reverse=True):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def watchdog(read_descriptor, deadline):
    try:
        os.setsid()
    except OSError:
        pass
    payload = b""
    while b"\n" not in payload and len(payload) < 32:
        chunk = os.read(read_descriptor, 32 - len(payload))
        if not chunk:
            os._exit(0)
        payload += chunk
    try:
        root_pid = int(payload.split(b"\n", 1)[0])
    except ValueError:
        os._exit(1)
    recorded = set()
    while time.monotonic() < deadline:
        recorded.update(process_tree(root_pid))
        try:
            os.kill(root_pid, 0)
        except ProcessLookupError:
            os._exit(0)
        time.sleep(0.01)
    recorded.update(process_tree(root_pid))
    kill_pid_tree(root_pid, recorded)
    os._exit(0)


def main():
    envelope = json.load(sys.stdin)
    if set(envelope) != {
        "request",
        "timeout_ms",
        "max_output_bytes",
        "verified_host_b64",
        "scan_descendants",
    }:
        fail("trusted host supervisor request is malformed")
    timeout_ms = envelope["timeout_ms"]
    maximum = envelope["max_output_bytes"]
    scan_descendants = envelope["scan_descendants"]
    if (
        not isinstance(timeout_ms, int)
        or isinstance(timeout_ms, bool)
        or timeout_ms < 1
        or timeout_ms > 300_000
        or not isinstance(maximum, int)
        or isinstance(maximum, bool)
        or maximum < 1
        or maximum > 16 * 1024 * 1024
        or not isinstance(scan_descendants, bool)
    ):
        fail("trusted host supervisor limits are malformed")
    try:
        host_bytes = base64.b64decode(envelope["verified_host_b64"], validate=True)
    except Exception:
        fail("trusted host bytes are malformed")
    if len(host_bytes) > 128 * 1024:
        fail("trusted host bytes exceed execution limit")
    host_b64 = base64.b64encode(host_bytes).decode("ascii")
    request_bytes = json.dumps(
        envelope["request"], ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    with (
        tempfile.TemporaryFile() as request_file,
        tempfile.TemporaryFile() as stdout_file,
        tempfile.TemporaryFile() as stderr_file,
    ):
        request_file.write(request_bytes)
        request_file.seek(0)
        deadline = time.monotonic() + timeout_ms / 1000
        watchdog_pid = None
        watchdog_write = None
        if scan_descendants:
            watchdog_read, watchdog_write = os.pipe()
            watchdog_pid = os.fork()
            if watchdog_pid == 0:
                os.close(watchdog_write)
                watchdog(watchdog_read, deadline)
            os.close(watchdog_read)
        process = subprocess.Popen(
            [
                "/usr/bin/python3",
                "-I",
                "-B",
                "-E",
                "-c",
                "import base64;exec(compile(base64.b64decode('"
                + host_b64
                + "'),'<trusted-host>','exec'))",
            ],
            stdin=request_file,
            stdout=stdout_file,
            stderr=stderr_file,
            close_fds=True,
            start_new_session=True,
            env={
                "HOME": "/var/empty",
                "LANG": "C",
                "LC_ALL": "C",
                "PATH": "/usr/bin:/bin",
            },
        )
        if watchdog_write is not None:
            os.write(watchdog_write, f"{process.pid}\n".encode("ascii"))
            os.close(watchdog_write)
        failure = None
        recorded = set()
        while process.poll() is None:
            if scan_descendants:
                recorded.update(process_tree(process.pid))
            if stdout_file.tell() + stderr_file.tell() > maximum:
                failure = "trusted host output limit exceeded"
                break
            if time.monotonic() >= deadline:
                failure = "trusted host timed out"
                break
            time.sleep(0.01)
        if scan_descendants:
            recorded.update(process_tree(process.pid))
        status = process.poll()
        kill_recorded(process, recorded)
        if watchdog_pid is not None:
            try:
                os.kill(watchdog_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(watchdog_pid, 0)
            except ChildProcessError:
                pass
        if failure is not None:
            fail(failure)
        stdout_file.seek(0)
        output = stdout_file.read(maximum + 1)
        if len(output) > maximum:
            fail("trusted host output limit exceeded")
        sys.stdout.buffer.write(output)
        raise SystemExit(status if status is not None else 1)


main()
