#!/usr/bin/env python3
"""AH-TOOL-VIDEO-EDIT-001: ffmpeg video editing helper.

Reads a JSON command spec from stdin, builds an ffmpeg ARG ARRAY (never a shell
string) and executes it via subprocess.run(argv) — no shell interpolation, so
paths and text cannot escape into the shell. Prints a JSON result to stdout.

Usage:
    python3 cli/video_editor.py            # normal: reads JSON spec from stdin
    python3 cli/video_editor.py --dry-run  # build argv only, print it, exit 0
                                           # (verification mode: no ffmpeg run)

Input JSON (EditVideoPayload):
    {command, input, output, inputs?, start?, end?, subtitle?, text?, x?, y?,
     fontfile?, audio?, codec?, frame_rate?}

Output JSON (ok):  {"status":"ok","output_path":<host output>,"duration":<float|absent>}
Output JSON (err): {"status":"error","error":"<message>","stderr":"<ffmpeg stderr>"}

Commands:
    trim           ffmpeg -ss START -to END -i INPUT -c copy OUTPUT
    concat         writes a concat list file, ffmpeg -f concat -safe 0 -i LIST -c copy OUTPUT
    add_subtitle   muxes a .srt/.vtt as a subtitle track
    overlay_text   drawtext filter with x/y coordinates (text kept literal)
    mux            replaces/keeps the audio track from AUDIO
    transcode      converts codec/container
    extract_frames extracts a frame sequence (OUTPUT is a pattern, e.g. %04d.png)
"""

import json
import os
import subprocess
import sys
import tempfile

COMMANDS = {
    "trim",
    "concat",
    "add_subtitle",
    "overlay_text",
    "mux",
    "transcode",
    "extract_frames",
}

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


def _err(message, stderr=""):
    return {"status": "error", "error": message, "stderr": stderr}


def _require_str(spec, key):
    value = spec.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required")
    return value


def _require_list(spec, key):
    value = spec.get(key)
    if not isinstance(value, list) or not value or not all(
        isinstance(p, str) and p for p in value
    ):
        raise ValueError(f"{key} must be a non-empty list of paths")
    return value


def _concat_list_file(paths):
    """Write an ffmpeg -f concat list file. Paths are single-quote escaped."""
    handle = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8")
    try:
        for path in paths:
            escaped = path.replace("'", "'\\''")
            handle.write(f"file '{escaped}'\n")
        handle.close()
        return handle.name
    except Exception:
        try:
            handle.close()
        except Exception:
            pass
        raise


def _escape_filter_value(value):
    """Escape a value for a single-quoted ffmpeg filtergraph string.

    Inside single quotes only backslash and quote are special; `:` is literal.
    """
    return value.replace("\\", "\\\\").replace("'", "'\\''")


def _build_argv(spec):
    command = spec.get("command")
    if command not in COMMANDS:
        raise ValueError(f"command must be one of {sorted(COMMANDS)}")
    input_path = _require_str(spec, "input")
    output_path = _require_str(spec, "output")

    argv = []
    if command == "trim":
        start = _require_str(spec, "start")
        argv = [FFMPEG, "-ss", start]
        if spec.get("end"):
            argv += ["-to", str(spec["end"])]
        argv += ["-i", input_path, "-c", "copy", "-y", output_path]

    elif command == "concat":
        paths = _require_list(spec, "inputs")
        list_file = _concat_list_file(paths)
        argv = [
            FFMPEG,
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_file,
            "-c",
            "copy",
            "-y",
            output_path,
        ]

    elif command == "add_subtitle":
        subtitle = _require_str(spec, "subtitle")
        argv = [
            FFMPEG,
            "-i",
            input_path,
            "-i",
            subtitle,
            "-c",
            "copy",
            "-c:s",
            "mov_text",
            "-y",
            output_path,
        ]

    elif command == "overlay_text":
        text = _require_str(spec, "text")
        x = str(spec.get("x", "0"))
        y = str(spec.get("y", "0"))
        fontfile = spec.get("fontfile")
        escaped_text = _escape_filter_value(text)
        filter_expr = f"drawtext=text='{escaped_text}':x={x}:y={y}"
        if fontfile:
            escaped_font = _escape_filter_value(str(fontfile))
            filter_expr += f":fontfile='{escaped_font}'"
        argv = [FFMPEG, "-i", input_path, "-vf", filter_expr, "-y", output_path]

    elif command == "mux":
        audio = _require_str(spec, "audio")
        argv = [
            FFMPEG,
            "-i",
            input_path,
            "-i",
            audio,
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c",
            "copy",
            "-y",
            output_path,
        ]

    elif command == "transcode":
        argv = [FFMPEG, "-i", input_path]
        if spec.get("codec"):
            argv += ["-c:v", str(spec["codec"])]
        argv += ["-y", output_path]

    elif command == "extract_frames":
        argv = [FFMPEG, "-i", input_path]
        if spec.get("frame_rate"):
            argv += ["-vf", f"fps={spec['frame_rate']}"]
        argv += ["-y", output_path]

    return argv


def _probe_duration(path):
    """Best-effort duration probe via ffprobe; None when unavailable."""
    try:
        result = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            return None
        return float(result.stdout.decode("utf-8").strip())
    except (OSError, ValueError):
        return None


def _ensure_output_dir(output_path):
    parent = os.path.dirname(output_path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def main(argv):
    dry_run = "--dry-run" in argv
    raw = sys.stdin.buffer.read()
    try:
        spec = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeDecodeError) as exc:
        print(json.dumps(_err(f"invalid JSON on stdin: {exc}")))
        return 0

    try:
        argv_built = _build_argv(spec)
    except ValueError as exc:
        print(json.dumps(_err(f"invalid spec: {exc}")))
        return 0

    if dry_run:
        print(json.dumps({"status": "ok", "argv": argv_built}))
        return 0

    _ensure_output_dir(spec.get("output", ""))
    try:
        result = subprocess.run(argv_built, capture_output=True, check=False)
    except OSError as exc:
        print(json.dumps(_err(f"failed to run ffmpeg: {exc}")))
        return 0

    stderr_text = result.stderr.decode("utf-8", errors="replace")
    if result.returncode != 0:
        print(json.dumps(_err(f"ffmpeg exited {result.returncode}", stderr=stderr_text)))
        return 0

    payload = {"status": "ok", "output_path": spec.get("output")}
    duration = _probe_duration(spec.get("output", ""))
    if duration is not None:
        payload["duration"] = duration
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
