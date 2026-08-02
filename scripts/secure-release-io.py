#!/usr/bin/env python3
"""Descriptor-relative, no-follow Phase 1 release Evidence I/O."""

from __future__ import annotations

import base64
import binascii
import ctypes
import errno
import hashlib
import json
import os
import stat
import sys
import uuid

TESTING = os.environ.get("PHASE1_SECURE_IO_TESTING") == "1"

def fail(message: str) -> None:
    raise RuntimeError(message)


def components(path: object) -> list[str]:
    if not isinstance(path, str) or not path or path.startswith(("/", "\\")):
        fail(f"unsafe relative path: {path!r}")
    result = path.replace("\\", "/").split("/")
    if any(not part or part in (".", "..") or "\0" in part for part in result):
        fail(f"unsafe relative path: {path!r}")
    for part in result:
        encoded = os.fsencode(part)
        if b"\0" in encoded or os.fsdecode(encoded) != part:
            fail("path component has an unsafe filesystem encoding")
    return result


def directory_flags() -> int:
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def open_root(request: dict) -> int:
    if sys.platform == "win32" or os.name != "posix":
        fail("descriptor-relative release I/O is unsupported on this platform")
    if request.get("rootFd") != 3:
        fail("authority root descriptor must be fd 3")
    descriptor = os.dup(3)
    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        fail("authority root descriptor is not a directory")
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


def write_all(descriptor: int, payload: bytes, short_write_max: int | None = None) -> int:
    offset = 0
    calls = 0
    while offset < len(payload):
        upper = len(payload) if short_write_max is None else offset + short_write_max
        written = os.write(descriptor, payload[offset:upper])
        calls += 1
        if written <= 0:
            fail("descriptor write made no progress")
        offset += written
    return calls


def rename_noreplace(parent: int, source: str, target: str) -> None:
    library = ctypes.CDLL(None, use_errno=True)
    source_bytes = os.fsencode(source)
    target_bytes = os.fsencode(target)
    if sys.platform == "darwin":
        function = getattr(library, "renameatx_np", None)
        flag = 0x00000004
    elif sys.platform.startswith("linux"):
        function = getattr(library, "renameat2", None)
        flag = 1
    else:
        fail("atomic no-replace rename is unsupported on this platform")
    if function is None:
        fail("atomic no-replace rename is unavailable")
    function.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    if function(parent, source_bytes, parent, target_bytes, flag) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number), target)


def decode_base64(value: object) -> bytes:
    if not isinstance(value, str):
        fail("contentBase64 must be a string")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        fail(f"invalid base64 content: {error}")


def write_file_exclusive(root_fd: int, request: dict) -> dict:
    path = components(request.get("path"))
    payload = decode_base64(request.get("contentBase64"))
    parent = open_directory(root_fd, path[:-1], True)
    temporary = f".{path[-1]}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    created = False
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent,
        )
        created = True
        try:
            calls = write_all(descriptor, payload, request.get("testShortWriteMax"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        rename_noreplace(parent, temporary, path[-1])
        created = False
        os.fsync(parent)
        return {"ok": True, "bytes": len(payload), "writeCalls": calls}
    finally:
        if created:
            try:
                os.unlink(temporary, dir_fd=parent)
                os.fsync(parent)
            except FileNotFoundError:
                pass
        os.close(parent)


def write_new_file(
    parent_fd: int,
    name: str,
    payload: bytes,
    mode: int,
    short_write_max: int | None = None,
) -> int:
    descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode,
        dir_fd=parent_fd,
    )
    try:
        calls = write_all(descriptor, payload, short_write_max)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return calls


def publish_tree(root_fd: int, request: dict) -> dict:
    temporary = components(request.get("temporary"))
    final = components(request.get("final"))
    if temporary[:-1] != final[:-1]:
        fail("publish_tree temporary and final must share one parent")
    raw_files = request.get("files")
    if not isinstance(raw_files, list):
        fail("publish_tree files must be an array")
    decoded = []
    seen = set()
    for entry in raw_files:
        if not isinstance(entry, dict) or set(entry) != {"path", "contentBase64", "mode"}:
            fail("publish_tree file schema mismatch")
        logical = components(entry["path"])
        normalized = "/".join(logical)
        if normalized in seen:
            fail(f"duplicate publication path: {normalized}")
        seen.add(normalized)
        if entry["mode"] not in (0o600, 0o700):
            fail("published file mode must be 0600 or 0700")
        decoded.append((logical, decode_base64(entry["contentBase64"]), entry["mode"]))
    temporary_parent = open_directory(root_fd, temporary[:-1], True)
    final_parent = open_directory(root_fd, final[:-1], True)
    temporary_fd = -1
    created = False
    renamed = False
    identity = None
    write_calls = 0
    try:
        os.mkdir(temporary[-1], 0o700, dir_fd=temporary_parent)
        created = True
        os.fsync(temporary_parent)
        temporary_fd = os.open(temporary[-1], directory_flags(), dir_fd=temporary_parent)
        opened = os.fstat(temporary_fd)
        identity = {"dev": str(opened.st_dev), "ino": str(opened.st_ino)}
        for logical, payload, mode in decoded:
            parent = open_directory(temporary_fd, logical[:-1], True)
            try:
                write_calls += write_new_file(
                    parent,
                    logical[-1],
                    payload,
                    mode,
                    request.get("testShortWriteMax"),
                )
                os.fsync(parent)
            finally:
                os.close(parent)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = -1
        rename_noreplace(temporary_parent, temporary[-1], final[-1])
        renamed = True
        created = False
        os.fsync(temporary_parent)
        if request.get("testFailAfterRenameFsync"):
            fail("injected post-rename fsync failure")
        os.fsync(final_parent)
        return {
            "ok": True,
            **identity,
            "files": len(decoded),
            "writeCalls": write_calls,
        }
    except BaseException:
        if temporary_fd >= 0:
            os.close(temporary_fd)
            temporary_fd = -1
        if identity is not None and (created or renamed):
            target = final if renamed else temporary
            remove_relative_tree(root_fd, target, identity)
        raise
    finally:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        os.close(final_parent)
        os.close(temporary_parent)


def remove_contents(directory_fd: int) -> None:
    for name in os.listdir(directory_fd):
        try:
            child = os.open(name, directory_flags(), dir_fd=directory_fd)
        except OSError as error:
            if error.errno not in (errno.ENOTDIR, errno.ELOOP):
                raise
            os.unlink(name, dir_fd=directory_fd)
            continue
        try:
            remove_contents(child)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=directory_fd)
    os.fsync(directory_fd)


def remove_relative_tree(root_fd: int, path: list[str], expected: dict) -> None:
    if (
        not isinstance(expected, dict)
        or set(expected) != {"dev", "ino"}
        or not all(isinstance(expected[key], str) and expected[key].isdigit() for key in expected)
    ):
        fail("remove_tree requires exact decimal dev/ino identity")
    parent = open_directory(root_fd, path[:-1], False)
    try:
        target = os.open(path[-1], directory_flags(), dir_fd=parent)
        try:
            opened = os.fstat(target)
            if str(opened.st_dev) != expected["dev"] or str(opened.st_ino) != expected["ino"]:
                fail("owned directory identity changed")
            remove_contents(target)
        finally:
            os.close(target)
        named = os.stat(path[-1], dir_fd=parent, follow_symlinks=False)
        if str(named.st_dev) != expected["dev"] or str(named.st_ino) != expected["ino"]:
            fail("owned directory identity changed before removal")
        os.rmdir(path[-1], dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(parent)


def read_file_bytes(parent_fd: int, name: str) -> bytes:
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            fail(f"non-file entry in release tree: {name}")
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
    finally:
        os.close(descriptor)


def collect_tree(directory_fd: int, prefix: str = "") -> list[dict]:
    result = []
    for name in sorted(os.listdir(directory_fd)):
        logical = f"{prefix}/{name}" if prefix else name
        try:
            child = os.open(name, directory_flags(), dir_fd=directory_fd)
        except OSError as error:
            if error.errno not in (errno.ENOTDIR, errno.ELOOP):
                raise
            payload = read_file_bytes(directory_fd, name)
            result.append(
                {
                    "path": logical,
                    "contentBase64": base64.b64encode(payload).decode("ascii"),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "bytes": len(payload),
                }
            )
            continue
        try:
            result.extend(collect_tree(child, logical))
        finally:
            os.close(child)
    return result


def read_tree(root_fd: int, request: dict) -> dict:
    directory = open_directory(root_fd, components(request.get("path")), False)
    try:
        files = collect_tree(directory)
    finally:
        os.close(directory)
    digest = hashlib.sha256()
    for entry in files:
        digest.update(entry["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(base64.b64decode(entry["contentBase64"]))
        digest.update(b"\0")
    return {
        "ok": True,
        "count": len(files),
        "setSha256": digest.hexdigest(),
        "files": files,
    }


def execute(request: object) -> dict:
    if not isinstance(request, dict):
        fail("operation schema requires an object")
    test_write = {"testShortWriteMax"}
    test_publish = test_write | {"testFailAfterRenameFsync"}
    required = {
        "write_file_exclusive": {"operation", "rootFd", "path", "contentBase64"},
        "read_tree": {"operation", "rootFd", "path"},
        "publish_tree": {"operation", "rootFd", "temporary", "final", "files"},
        "remove_tree": {"operation", "rootFd", "path", "expected"},
    }
    optional = {
        "write_file_exclusive": test_write,
        "read_tree": set(),
        "publish_tree": test_publish,
        "remove_tree": set(),
    }
    operation = request.get("operation")
    if (
        operation not in required
        or not required[operation].issubset(request)
        or set(request) - required[operation] - optional[operation]
    ):
        fail("operation schema mismatch")
    if "testShortWriteMax" in request and (
        not TESTING
        or not isinstance(request["testShortWriteMax"], int)
        or isinstance(request["testShortWriteMax"], bool)
        or request["testShortWriteMax"] <= 0
    ):
        fail("invalid short-write test hook")
    if "testFailAfterRenameFsync" in request and (
        not TESTING or request["testFailAfterRenameFsync"] is not True
    ):
        fail("invalid fsync test hook")
    root_fd = open_root(request)
    try:
        if operation == "write_file_exclusive":
            return write_file_exclusive(root_fd, request)
        if operation == "read_tree":
            return read_tree(root_fd, request)
        if operation == "publish_tree":
            return publish_tree(root_fd, request)
        remove_relative_tree(root_fd, components(request.get("path")), request.get("expected"))
        return {"ok": True}
    finally:
        os.close(root_fd)


def main() -> int:
    try:
        result = execute(json.load(sys.stdin))
        json.dump(result, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    except BaseException as error:
        detail = f"{type(error).__name__}: {error}"
        if isinstance(error, NotADirectoryError):
            detail = f"not a directory or symlink: {error}"
        json.dump({"ok": False, "error": detail}, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
