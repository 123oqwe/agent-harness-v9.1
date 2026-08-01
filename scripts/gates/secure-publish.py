#!/usr/bin/env python3
"""Descriptor-relative Phase 2 release publication for POSIX platforms."""

from __future__ import annotations

import base64
import json
import os
import stat
import sys
import time
import uuid


def fail(message: str) -> None:
    raise RuntimeError(message)


def components(path: object) -> list[str]:
    if not isinstance(path, str) or not path or path.startswith(("/", "\\")):
        fail(f"unsafe relative path: {path!r}")
    result = path.replace("\\", "/").split("/")
    if any(not part or part in (".", "..") for part in result):
        fail(f"unsafe relative path: {path!r}")
    return result


def directory_flags() -> int:
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def open_root(path: object) -> int:
    if sys.platform == "win32" or os.name != "posix":
        fail("descriptor-relative publication is unsupported on this platform")
    if not isinstance(path, str) or not os.path.isabs(path):
        fail("repository root must be absolute")
    descriptor = os.open(path, directory_flags())
    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        fail("repository root is not a directory")
    return descriptor


def open_directory(root_fd: int, parts: list[str], create: bool) -> int:
    current = os.dup(root_fd)
    try:
        for part in parts:
            try:
                child = os.open(part, directory_flags(), dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o700, dir_fd=current)
                os.fsync(current)
                child = os.open(part, directory_flags(), dir_fd=current)
                os.fsync(child)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            fail("descriptor write made no progress")
        offset += written


def write_new_file(parent_fd: int, name: str, payload: bytes) -> None:
    descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=parent_fd,
    )
    try:
        write_all(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def remove_contents(directory_fd: int) -> None:
    for name in os.listdir(directory_fd):
        try:
            child = os.open(name, directory_flags(), dir_fd=directory_fd)
        except OSError:
            os.unlink(name, dir_fd=directory_fd)
            continue
        try:
            remove_contents(child)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=directory_fd)
    os.fsync(directory_fd)


def remove_relative_tree(root_fd: int, path_parts: list[str], expected: dict | None) -> None:
    parent = open_directory(root_fd, path_parts[:-1], False)
    try:
        target = os.open(path_parts[-1], directory_flags(), dir_fd=parent)
        try:
            identity = os.fstat(target)
            if expected is not None and (
                identity.st_dev != expected.get("dev")
                or identity.st_ino != expected.get("ino")
            ):
                fail("owned directory identity changed")
            remove_contents(target)
        finally:
            os.close(target)
        os.rmdir(path_parts[-1], dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(parent)


def write_file_atomic(root_fd: int, request: dict) -> dict:
    path_parts = components(request.get("path"))
    parent = open_directory(root_fd, path_parts[:-1], True)
    temporary = f".{path_parts[-1]}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    try:
        payload = base64.b64decode(request.get("contentBase64", ""), validate=True)
        write_new_file(parent, temporary, payload)
        os.rename(
            temporary,
            path_parts[-1],
            src_dir_fd=parent,
            dst_dir_fd=parent,
        )
        os.fsync(parent)
        return {"ok": True, "bytes": len(payload)}
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=parent)
            os.fsync(parent)
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(parent)


def publish_tree(root_fd: int, request: dict) -> dict:
    temporary_parts = components(request.get("temporary"))
    final_parts = components(request.get("final"))
    temporary_parent = open_directory(root_fd, temporary_parts[:-1], True)
    final_parent = open_directory(root_fd, final_parts[:-1], True)
    created = False
    temporary_fd = -1
    try:
        os.mkdir(temporary_parts[-1], 0o700, dir_fd=temporary_parent)
        created = True
        os.fsync(temporary_parent)
        temporary_fd = os.open(
            temporary_parts[-1], directory_flags(), dir_fd=temporary_parent
        )
        identity = os.fstat(temporary_fd)
        for entry in request.get("files", []):
            logical = components(entry.get("path"))
            parent = open_directory(temporary_fd, logical[:-1], True)
            try:
                payload = base64.b64decode(
                    entry.get("contentBase64", ""), validate=True
                )
                write_new_file(parent, logical[-1], payload)
                os.fsync(parent)
            finally:
                os.close(parent)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = -1
        os.rename(
            temporary_parts[-1],
            final_parts[-1],
            src_dir_fd=temporary_parent,
            dst_dir_fd=final_parent,
        )
        created = False
        os.fsync(temporary_parent)
        os.fsync(final_parent)
        return {
            "ok": True,
            "dev": identity.st_dev,
            "ino": identity.st_ino,
            "files": len(request.get("files", [])),
        }
    except BaseException:
        if temporary_fd >= 0:
            os.close(temporary_fd)
            temporary_fd = -1
        if created:
            try:
                remove_relative_tree(root_fd, temporary_parts, None)
            except BaseException:
                pass
        raise
    finally:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        os.close(final_parent)
        os.close(temporary_parent)


def execute(request: dict) -> dict:
    root_fd = open_root(request.get("root"))
    try:
        pause_ms = request.get("testPauseAfterRootOpenMs", 0)
        if pause_ms:
            if os.environ.get("PHASE2_SECURE_PUBLISH_TESTING") != "1":
                fail("secure publication test pause is forbidden")
            if not isinstance(pause_ms, int) or pause_ms < 1 or pause_ms > 5_000:
                fail("invalid secure publication test pause")
            sys.stderr.write("SECURE_ROOT_OPEN\n")
            sys.stderr.flush()
            time.sleep(pause_ms / 1_000)
        operation = request.get("operation")
        if operation == "write_file_atomic":
            return write_file_atomic(root_fd, request)
        if operation == "publish_tree":
            return publish_tree(root_fd, request)
        if operation == "remove_tree":
            remove_relative_tree(
                root_fd, components(request.get("path")), request.get("expected")
            )
            return {"ok": True}
        fail(f"unsupported secure publication operation: {operation!r}")
    finally:
        os.close(root_fd)


def main() -> int:
    try:
        request = json.load(sys.stdin)
        result = execute(request)
        json.dump(result, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    except BaseException as error:
        json.dump(
            {"ok": False, "error": f"{type(error).__name__}: {error}"},
            sys.stdout,
            sort_keys=True,
        )
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
