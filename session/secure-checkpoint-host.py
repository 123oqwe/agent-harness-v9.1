#!/usr/bin/env python3
"""Descriptor-relative filesystem host for SessionTree checkpoint bytes."""

import base64
import json
import os
import secrets
import stat
import sys


def fail(message):
    raise RuntimeError(message)


def open_directory(path, create):
    absolute = os.path.abspath(path)
    # macOS exposes /var as a system-owned compatibility symlink to /private/var.
    # Normalize only this fixed OS alias before the descriptor walk; arbitrary
    # user-controlled symlinks remain forbidden.
    if sys.platform == "darwin" and (absolute == "/var" or absolute.startswith("/var/")):
        absolute = "/private" + absolute
    descriptor = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in [part for part in absolute.split(os.sep) if part]:
            if create:
                try:
                    os.mkdir(component, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def verify_identity(descriptor, expected):
    actual = os.fstat(descriptor)
    if not stat.S_ISDIR(actual.st_mode) or actual.st_uid != os.getuid() or actual.st_mode & 0o077:
        fail("session tree checkpoint directory metadata is unsafe")
    if expected is not None and (
        actual.st_dev != expected.get("dev") or actual.st_ino != expected.get("ino")
    ):
        fail("session tree checkpoint directory authority changed")
    return {"dev": actual.st_dev, "ino": actual.st_ino}


def main():
    request = json.load(sys.stdin)
    command = request.get("command")
    expected_keys = {
        "ensure": {"command", "directory"},
        "read": {"command", "directory", "identity", "name", "max_bytes"},
        "write": {"command", "directory", "identity", "name", "max_bytes", "content"},
    }.get(command)
    if expected_keys is None or set(request) != expected_keys:
        fail("checkpoint host request schema is malformed")
    descriptor = open_directory(request["directory"], command == "ensure")
    try:
        identity = verify_identity(descriptor, request.get("identity"))
        if command == "ensure":
            os.fchmod(descriptor, 0o700)
            return {"identity": identity}
        name = request.get("name")
        if not isinstance(name, str) or os.sep in name or name in ("", ".", ".."):
            fail("session tree checkpoint filename is malformed")
        if command == "read":
            try:
                file_descriptor = os.open(
                    name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=descriptor
                )
            except FileNotFoundError:
                return {"identity": identity, "missing": True, "content": None}
            try:
                opened = os.fstat(file_descriptor)
                maximum = request["max_bytes"]
                if (
                    not stat.S_ISREG(opened.st_mode)
                    or opened.st_uid != os.getuid()
                    or opened.st_mode & 0o077
                    or opened.st_nlink != 1
                ):
                    fail("session tree checkpoint file metadata is unsafe")
                if opened.st_size > maximum:
                    fail("session tree checkpoint byte limit exceeded")
                chunks = []
                remaining = maximum + 1
                while remaining > 0:
                    chunk = os.read(file_descriptor, min(65536, remaining))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                content = b"".join(chunks)
                if len(content) > maximum:
                    fail("session tree checkpoint byte limit exceeded")
                return {
                    "identity": identity,
                    "missing": False,
                    "content": base64.b64encode(content).decode("ascii"),
                }
            finally:
                os.close(file_descriptor)
        if command == "write":
            content = base64.b64decode(request["content"], validate=True)
            if len(content) > request["max_bytes"]:
                fail("session tree checkpoint byte limit exceeded")
            temporary = f".{name}.{os.getpid()}.{secrets.token_hex(16)}.tmp"
            file_descriptor = None
            try:
                file_descriptor = os.open(
                    temporary,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=descriptor,
                )
                view = memoryview(content)
                while view:
                    written = os.write(file_descriptor, view)
                    if written <= 0:
                        fail("session tree checkpoint write made no progress")
                    view = view[written:]
                os.fsync(file_descriptor)
                os.close(file_descriptor)
                file_descriptor = None
                os.replace(
                    temporary,
                    name,
                    src_dir_fd=descriptor,
                    dst_dir_fd=descriptor,
                )
                os.fsync(descriptor)
                return {"identity": identity}
            finally:
                if file_descriptor is not None:
                    os.close(file_descriptor)
                try:
                    os.unlink(temporary, dir_fd=descriptor)
                except FileNotFoundError:
                    pass
        fail("unsupported checkpoint host command")
    finally:
        os.close(descriptor)


try:
    result = main()
    sys.stdout.write(json.dumps({"ok": True, **result}))
except Exception as error:
    sys.stdout.write(json.dumps({"ok": False, "error": str(error)}))
    sys.exit(1)
