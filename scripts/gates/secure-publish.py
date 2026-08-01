#!/usr/bin/env python3
"""Descriptor-relative Phase 2 report publication and verification."""

from __future__ import annotations

import base64
import binascii
import ctypes
import errno
import hashlib
import json
import os
import re
import stat
import sys
import time
import uuid


DECIMAL = re.compile(r"^[0-9]+$")
TESTING = os.environ.get("PHASE2_SECURE_PUBLISH_TESTING") == "1"


def fail(message: str) -> None:
    raise RuntimeError(message)


def exact_object(value: object, required: set[str], optional: set[str] = set()) -> dict:
    if not isinstance(value, dict):
        fail("operation schema requires an object")
    keys = set(value)
    unknown = keys - required - optional
    missing = required - keys
    if unknown or missing:
        fail(
            "operation schema mismatch"
            f" (unknown={sorted(unknown)}, missing={sorted(missing)})"
        )
    return value


def components(path: object, *, publication_path: bool = True) -> list[str]:
    if not isinstance(path, str) or not path or path.startswith(("/", "\\")):
        fail(f"unsafe relative path: {path!r}")
    result = path.replace("\\", "/").split("/")
    if any(not part or part in (".", "..") for part in result):
        fail(f"unsafe relative path: {path!r}")
    for part in result:
        if "\0" in part:
            fail("NUL is forbidden in path components")
        try:
            encoded = os.fsencode(part)
        except UnicodeEncodeError as error:
            fail(f"path component is not filesystem-encodable: {error}")
        if b"\0" in encoded or os.fsdecode(encoded) != part:
            fail("path component has an unsafe filesystem encoding")
    if publication_path and (len(result) < 3 or result[:2] != ["reports", "phase2"]):
        fail("publication paths must be below reports/phase2")
    return result


def directory_flags() -> int:
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def open_root(request: dict) -> int:
    if sys.platform == "win32" or os.name != "posix":
        fail("descriptor-relative publication is unsupported on this platform")
    if "rootFd" in request:
        if request["rootFd"] != 3:
            fail("authority root descriptor must be fd 3")
        descriptor = os.dup(3)
    elif TESTING and isinstance(request.get("root"), str):
        # Direct helper tests exercise ancestor swaps. Production callers may not
        # supply a pathname root; the Node authority wrapper always passes fd 3.
        descriptor = os.open(request["root"], directory_flags())
    else:
        fail("authority root descriptor is required")
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            fail("authority root descriptor is not a directory")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


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


def identity_matches(value: os.stat_result, expected: dict[str, str]) -> bool:
    return str(value.st_dev) == expected["dev"] and str(value.st_ino) == expected["ino"]


def remove_relative_tree(
    root_fd: int, path_parts: list[str], expected: dict[str, str]
) -> None:
    parent = open_directory(root_fd, path_parts[:-1], False)
    try:
        target = os.open(path_parts[-1], directory_flags(), dir_fd=parent)
        try:
            identity = os.fstat(target)
            if not identity_matches(identity, expected):
                fail("owned directory identity changed")
            remove_contents(target)
        finally:
            os.close(target)
        # Recheck the directory name immediately before removal.
        named = os.stat(path_parts[-1], dir_fd=parent, follow_symlinks=False)
        if not identity_matches(named, expected):
            fail("owned directory identity changed before removal")
        os.rmdir(path_parts[-1], dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(parent)


def rename_noreplace(
    source_parent: int, source: str, target_parent: int, target: str
) -> None:
    library = ctypes.CDLL(None, use_errno=True)
    source_bytes = os.fsencode(source)
    target_bytes = os.fsencode(target)
    if sys.platform == "darwin":
        function = getattr(library, "renameatx_np", None)
        if function is None:
            fail("atomic no-replace rename is unavailable")
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = function(source_parent, source_bytes, target_parent, target_bytes, 0x00000004)
    elif sys.platform.startswith("linux"):
        function = getattr(library, "renameat2", None)
        if function is None:
            fail("atomic no-replace rename is unavailable")
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = function(source_parent, source_bytes, target_parent, target_bytes, 1)
    else:
        fail("atomic no-replace rename is unsupported on this platform")
    if result != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number), target)


def decode_base64(value: object) -> bytes:
    if not isinstance(value, str):
        fail("contentBase64 must be a string")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        fail(f"invalid base64 content: {error}")


def validate_expected(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        fail("expected ownership receipt must contain decimal-string dev/ino")
    expected = exact_object(value, {"dev", "ino"})
    for key in ("dev", "ino"):
        if not isinstance(expected[key], str) or not DECIMAL.fullmatch(expected[key]):
            fail("ownership dev/ino must be exact decimal strings")
    return expected


def validate_request(raw: object) -> dict:
    if not isinstance(raw, dict):
        fail("operation schema requires an object")
    operation = raw.get("operation")
    root_key = "rootFd" if "rootFd" in raw else "root"
    test_pause = {"testPauseAfterRootOpenMs"}
    if operation == "write_file_atomic":
        request = exact_object(
            raw,
            {"operation", root_key, "path", "contentBase64"},
            test_pause | {"testFailCleanup"},
        )
        request["pathParts"] = components(request["path"])
        request["payload"] = decode_base64(request["contentBase64"])
    elif operation == "publish_tree":
        optional = {"testFailAfterRenameFsync", "testFailCleanup", "testIdentity"} | test_pause
        request = exact_object(raw, {"operation", root_key, "temporary", "final", "files"}, optional)
        request["temporaryParts"] = components(request["temporary"])
        request["finalParts"] = components(request["final"])
        if not isinstance(request["files"], list):
            fail("publish_tree files must be an array")
        decoded = []
        seen = set()
        for entry in request["files"]:
            exact_object(entry, {"path", "contentBase64"})
            logical = components(entry["path"], publication_path=False)
            normalized = "/".join(logical)
            if normalized in seen:
                fail(f"duplicate publication path: {normalized}")
            seen.add(normalized)
            decoded.append((logical, decode_base64(entry["contentBase64"])))
        request["decodedFiles"] = decoded
        if "testIdentity" in request:
            if not TESTING:
                fail("test identity is forbidden")
            request["testIdentity"] = validate_expected(request["testIdentity"])
    elif operation == "remove_tree":
        request = exact_object(raw, {"operation", root_key, "path", "expected"}, test_pause)
        request["pathParts"] = components(request["path"])
        request["expected"] = validate_expected(request["expected"])
    elif operation == "read_tree":
        request = exact_object(raw, {"operation", root_key, "path"}, test_pause)
        request["pathParts"] = components(request["path"])
    else:
        fail(f"unsupported secure publication operation: {operation!r}")
    for key in ("testFailAfterRenameFsync", "testFailCleanup"):
        if key in request and (not TESTING or request[key] is not True):
            fail(f"{key} is forbidden outside secure publication tests")
    pause = request.get("testPauseAfterRootOpenMs", 0)
    if pause and (not TESTING or not isinstance(pause, int) or isinstance(pause, bool) or not 1 <= pause <= 5_000):
        fail("invalid secure publication test pause")
    return request


def write_file_atomic(root_fd: int, request: dict) -> dict:
    path_parts = request["pathParts"]
    payload = request["payload"]
    parent = open_directory(root_fd, path_parts[:-1], True)
    temporary = f".{path_parts[-1]}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    try:
        write_new_file(parent, temporary, payload)
        # The singleton gate report is an atomic current-state file. Evidence
        # directories use rename_noreplace and remain immutable.
        os.rename(temporary, path_parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
        return {"ok": True, "bytes": len(payload)}
    except BaseException as original:
        cleanup_errors = []
        try:
            os.unlink(temporary, dir_fd=parent)
            os.fsync(parent)
        except FileNotFoundError:
            pass
        except BaseException as cleanup_error:
            cleanup_errors.append(cleanup_error)
        if request.get("testFailCleanup"):
            cleanup_errors.append(RuntimeError("injected cleanup failure"))
        if cleanup_errors:
            detail = "; ".join(
                f"{type(error).__name__}: {error}" for error in cleanup_errors
            )
            fail(f"{type(original).__name__}: {original}; cleanup failed: {detail}")
        raise
    finally:
        os.close(parent)


def cleanup_owned(root_fd: int, parts: list[str], identity: dict[str, str]) -> None:
    remove_relative_tree(root_fd, parts, identity)


def publish_tree(root_fd: int, request: dict) -> dict:
    temporary_parts = request["temporaryParts"]
    final_parts = request["finalParts"]
    temporary_parent = open_directory(root_fd, temporary_parts[:-1], True)
    final_parent = open_directory(root_fd, final_parts[:-1], True)
    temporary_fd = -1
    created = False
    renamed = False
    owned_identity: dict[str, str] | None = None
    try:
        os.mkdir(temporary_parts[-1], 0o700, dir_fd=temporary_parent)
        created = True
        os.fsync(temporary_parent)
        temporary_fd = os.open(temporary_parts[-1], directory_flags(), dir_fd=temporary_parent)
        identity = os.fstat(temporary_fd)
        owned_identity = {"dev": str(identity.st_dev), "ino": str(identity.st_ino)}
        for logical, payload in request["decodedFiles"]:
            parent = open_directory(temporary_fd, logical[:-1], True)
            try:
                write_new_file(parent, logical[-1], payload)
                os.fsync(parent)
            finally:
                os.close(parent)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = -1
        rename_noreplace(temporary_parent, temporary_parts[-1], final_parent, final_parts[-1])
        renamed = True
        created = False
        os.fsync(temporary_parent)
        if request.get("testFailAfterRenameFsync"):
            fail("injected post-rename fsync failure")
        os.fsync(final_parent)
        receipt = request.get("testIdentity", owned_identity)
        return {"ok": True, **receipt, "files": len(request["decodedFiles"])}
    except BaseException as original:
        cleanup_errors = []
        if temporary_fd >= 0:
            os.close(temporary_fd)
            temporary_fd = -1
        try:
            if owned_identity is not None and renamed:
                cleanup_owned(root_fd, final_parts, owned_identity)
            elif owned_identity is not None and created:
                cleanup_owned(root_fd, temporary_parts, owned_identity)
        except BaseException as cleanup_error:
            cleanup_errors.append(cleanup_error)
        if request.get("testFailCleanup"):
            cleanup_errors.append(RuntimeError("injected cleanup failure"))
        if cleanup_errors:
            detail = "; ".join(f"{type(error).__name__}: {error}" for error in cleanup_errors)
            fail(f"{type(original).__name__}: {original}; cleanup failed: {detail}")
        raise
    finally:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        os.close(final_parent)
        os.close(temporary_parent)


def read_file_bytes(parent_fd: int, name: str) -> bytes:
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            fail(f"non-file entry in Evidence tree: {name}")
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
    directory = open_directory(root_fd, request["pathParts"], False)
    try:
        files = collect_tree(directory)
    finally:
        os.close(directory)
    set_hash = hashlib.sha256()
    for entry in files:
        set_hash.update(entry["path"].encode("utf-8"))
        set_hash.update(b"\0")
        set_hash.update(base64.b64decode(entry["contentBase64"]))
        set_hash.update(b"\0")
    return {"ok": True, "count": len(files), "setSha256": set_hash.hexdigest(), "files": files}


def execute(raw: object) -> dict:
    # Full validation, including every payload, happens before a directory can be
    # opened with create=True.
    request = validate_request(raw)
    root_fd = open_root(request)
    try:
        pause_ms = request.get("testPauseAfterRootOpenMs", 0)
        if pause_ms:
            sys.stderr.write("SECURE_ROOT_OPEN\n")
            sys.stderr.flush()
            time.sleep(pause_ms / 1_000)
        operation = request["operation"]
        if operation == "write_file_atomic":
            return write_file_atomic(root_fd, request)
        if operation == "publish_tree":
            return publish_tree(root_fd, request)
        if operation == "remove_tree":
            remove_relative_tree(root_fd, request["pathParts"], request["expected"])
            return {"ok": True}
        if operation == "read_tree":
            return read_tree(root_fd, request)
        fail(f"unsupported secure publication operation: {operation!r}")
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
