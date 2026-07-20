#!/usr/bin/env python3
"""Validate or deterministically refresh requirement-derived repository views."""
import argparse
import json
import os
import tempfile
from collections import Counter
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]
REQ_DIR = BASE / "spec" / "requirements"


def load_requirements():
    return [json.loads(line) for line in (REQ_DIR / "requirements.ndjson").read_text().splitlines() if line.strip()]


def build_views(requirements):
    phase_coverage = dict(sorted(Counter(str(row["delivery_phase"]) for row in requirements).items(), key=lambda item: int(item[0])))
    domain_coverage = dict(sorted(Counter(row["domain"] for row in requirements).items()))
    dependency_graph = {row["id"]: row.get("dependencies", []) for row in requirements}
    traceability = {}
    for row in requirements:
        contracts = [path.removeprefix("spec/") for path in row.get("source_files", []) if path.startswith("spec/contracts/")]
        traceability[row["id"]] = {
            "requirement_id": row["id"],
            "product_journey": row.get("experience_profile", "all"),
            "architecture_module": row["owner_module"],
            "contract": contracts,
            "api": row.get("API_operations", []),
            "source_package": row["owner_module"],
            "test": row.get("test_files", []),
            "eval": row.get("eval_files") or None,
            "phase_gate": f"phases/phase-{row['delivery_phase']}.yaml",
            "evidence": row["evidence_path"],
        }
    return {
        "phase-coverage.json": phase_coverage,
        "domain-coverage.json": domain_coverage,
        "dependency-graph.json": dependency_graph,
        "traceability-matrix.json": traceability,
    }


def atomic_write(path, payload):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="atomically refresh the four derived JSON views")
    args = parser.parse_args()
    expected = build_views(load_requirements())
    if args.write:
        for name, payload in expected.items():
            atomic_write(REQ_DIR / name, payload)
    mismatches = []
    for name, payload in expected.items():
        path = REQ_DIR / name
        actual = json.loads(path.read_text()) if path.exists() else None
        if actual != payload:
            mismatches.append(name)
    if mismatches:
        print(f"FAIL: stale requirement-derived views: {', '.join(mismatches)}")
        raise SystemExit(1)
    print(f"PASS: {len(expected)} requirement-derived views match {len(load_requirements())} registry rows")


if __name__ == "__main__":
    main()
