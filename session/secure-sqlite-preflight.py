#!/usr/bin/env python3
"""Descriptor-relative create and zero-write SQLite WAL snapshot preflight."""

import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
from urllib.parse import quote

MAX_FILE_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_SCHEMA_OBJECTS = 4096
MAX_SCHEMA_BYTES = 4 * 1024 * 1024


def fail(message):
    raise RuntimeError(message)


def canonical_path(path):
    absolute = os.path.abspath(path)
    if sys.platform == "darwin" and (absolute == "/var" or absolute.startswith("/var/")):
        absolute = "/private" + absolute
    return absolute


def open_root(path, expected):
    absolute = canonical_path(path)
    descriptor = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in [part for part in absolute.split(os.sep) if part]:
            child = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = child
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid not in (0, os.getuid())
            or stat.S_IMODE(opened.st_mode) != 0o700
            or opened.st_dev != expected.get("dev")
            or opened.st_ino != expected.get("ino")
        ):
            fail("trusted session state root identity or metadata changed")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def exact_name(name):
    if not isinstance(name, str) or name in ("", ".", "..") or os.sep in name:
        fail("SQLite main filename is malformed")


def public_identity(descriptor):
    value = os.fstat(descriptor)
    return {"dev": value.st_dev, "ino": value.st_ino}


def snapshot_identity(descriptor):
    value = os.fstat(descriptor)
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)


def open_regular(parent, name, required):
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
            dir_fd=parent,
        )
    except FileNotFoundError:
        if required:
            fail(f"SQLite snapshot file is missing: {name}")
        return None
    except OSError as error:
        fail(f"SQLite snapshot descriptor or symlink is unsafe: {name}: {error}")
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or opened.st_uid not in (0, os.getuid())
        or opened.st_mode & 0o022
        or opened.st_nlink != 1
        or opened.st_size > MAX_FILE_BYTES
    ):
        os.close(descriptor)
        fail(f"SQLite snapshot file metadata is unsafe: {name}")
    return descriptor


def copy_descriptor(source, destination):
    os.lseek(source, 0, os.SEEK_SET)
    with open(destination, "xb") as target:
        os.chmod(destination, 0o600)
        while True:
            chunk = os.read(source, 65536)
            if not chunk:
                break
            target.write(chunk)
        target.flush()
        os.fsync(target.fileno())


def create_database(root, name):
    try:
        descriptor = os.open(
            name,
            os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW,
            0o600,
            dir_fd=root,
        )
    except OSError as error:
        fail(f"descriptor-relative SQLite create rejected: {error}")
    try:
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
        os.fsync(root)
        return {
            "parent_identity": public_identity(root),
            "main_identity": public_identity(descriptor),
            "created": True,
        }
    finally:
        os.close(descriptor)


def preflight_database(root, name):
    descriptors = []
    temporary = tempfile.mkdtemp(prefix="ah-sqlite-preflight-")
    os.chmod(temporary, 0o700)
    try:
        main_descriptor = open_regular(root, name, True)
        descriptors.append((name, main_descriptor))
        wal = open_regular(root, f"{name}-wal", False)
        shm = open_regular(root, f"{name}-shm", False)
        if (wal is None) != (shm is None):
            fail("SQLite WAL snapshot is incomplete")
        if wal is not None and shm is not None:
            descriptors.extend([(f"{name}-wal", wal), (f"{name}-shm", shm)])
        before = {entry_name: snapshot_identity(fd) for entry_name, fd in descriptors}
        if sum(value[2] for value in before.values()) > MAX_TOTAL_BYTES:
            fail("SQLite snapshot byte limit exceeded")
        for entry_name, descriptor in descriptors:
            copy_descriptor(descriptor, os.path.join(temporary, entry_name))
        after = {entry_name: snapshot_identity(fd) for entry_name, fd in descriptors}
        if before != after:
            fail("SQLite snapshot changed during copy")
        copied = os.path.join(temporary, name)
        copied_shm = os.path.join(temporary, f"{name}-shm")
        if os.path.exists(copied_shm):
            os.unlink(copied_shm)
        database = sqlite3.connect(f"file:{quote(copied)}?mode=rw", uri=True)
        try:
            database.execute("PRAGMA query_only = ON")
            schema_rows = database.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master "
                "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
                "ORDER BY type, name LIMIT ?",
                (MAX_SCHEMA_OBJECTS + 1,),
            ).fetchall()
            if len(schema_rows) > MAX_SCHEMA_OBJECTS:
                fail("SQLite schema object limit exceeded")
            schema = [
                {"type": row[0], "name": row[1], "table": row[2], "sql": row[3]}
                for row in schema_rows
            ]
            if sum(len(row["sql"].encode("utf-8")) for row in schema) > MAX_SCHEMA_BYTES:
                fail("SQLite schema byte limit exceeded")
            tables = {row["name"] for row in schema if row["type"] == "table"}
            metadata = dict(database.execute(
                "SELECT key, value FROM metadata WHERE key IN "
                "('encryption_salt', 'session_record_key_check') LIMIT 3"
            )) if "metadata" in tables else {}
            legacy = database.execute(
                "SELECT run_id, goal FROM runs ORDER BY run_id LIMIT 1"
            ).fetchone() if "runs" in tables else None
            return {
                "parent_identity": public_identity(root),
                "main_identity": public_identity(main_descriptor),
                "created": False,
                "schema": schema,
                "salt": metadata.get("encryption_salt"),
                "sentinel": metadata.get("session_record_key_check"),
                "legacy": None if legacy is None else {"run_id": legacy[0], "goal": legacy[1]},
            }
        finally:
            database.close()
    finally:
        for _, descriptor in descriptors:
            os.close(descriptor)
        shutil.rmtree(temporary, ignore_errors=True)


def main():
    request = json.load(sys.stdin)
    if set(request) != {"command", "root", "root_identity", "name"}:
        fail("SQLite preflight request schema is malformed")
    if request["command"] not in ("create", "preflight"):
        fail("SQLite preflight command is malformed")
    exact_name(request["name"])
    root = open_root(request["root"], request["root_identity"])
    try:
        if request["command"] == "create":
            return create_database(root, request["name"])
        return preflight_database(root, request["name"])
    finally:
        os.close(root)


try:
    result = main()
    sys.stdout.write(json.dumps({"ok": True, **result}))
except Exception as error:
    sys.stdout.write(json.dumps({"ok": False, "error": str(error)}))
    sys.exit(1)
