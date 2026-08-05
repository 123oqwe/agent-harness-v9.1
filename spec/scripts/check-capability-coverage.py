#!/usr/bin/env python3
"""Fail closed when capability coverage or generated inventory views are stale."""
import argparse
import json
import os
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]
REQ_DIR = BASE / "spec" / "requirements"
requirements = [json.loads(line) for line in (REQ_DIR / "requirements.ndjson").read_text().splitlines() if line.strip()]
requirement_ids = {row["id"] for row in requirements}
actionable_ids = {row["id"] for row in requirements if row["delivery_phase"] >= 1}
inventory = json.loads((REQ_DIR / "product-capability-inventory.json").read_text())
capabilities = [capability for family in inventory["families"].values() for capability in family]


def render_yaml_view():
    lines = [
        "# Product Capability Inventory — GENERATED VIEW",
        "# Authority: product-capability-inventory.json; regenerate with check-capability-coverage.py --write",
        f"version: {json.dumps(inventory['version'])}",
        f"total_families: {inventory['total_families']}",
        f"total_capabilities: {inventory['total_capabilities']}",
        "families:",
    ]
    for family_name, family in inventory["families"].items():
        lines.append(f"  {family_name}:")
        for capability in family:
            lines.extend([
                f"    - capability_id: {capability['capability_id']}",
                f"      name: {capability['name']}",
                "      requirement_ids:",
            ])
            lines.extend(f"        - {requirement_id}" for requirement_id in capability["requirement_ids"])
            if capability.get("description"):
                lines.append(f"      description: {json.dumps(capability['description'], ensure_ascii=False)}")
    return "\n".join(lines) + "\n"


def atomic_write(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

errors = []
mapped_requirement_ids = set()
for capability in capabilities:
    mapped = capability.get("requirement_ids", [])
    if not mapped:
        errors.append(f"{capability['capability_id']}: no requirement mapping")
    unknown = sorted(set(mapped) - requirement_ids)
    if unknown:
        errors.append(f"{capability['capability_id']}: unknown requirements {unknown}")
    mapped_requirement_ids.update(mapped)

unmapped_actionable = sorted(actionable_ids - mapped_requirement_ids)
if unmapped_actionable:
    errors.append(f"actionable requirements without capability mapping: {unmapped_actionable}")
if inventory.get("total_capabilities") != len(capabilities):
    errors.append(f"inventory total {inventory.get('total_capabilities')} != actual {len(capabilities)}")

expected_summary = {
    "total_capabilities": len(capabilities),
    "mapped": sum(bool(capability.get("requirement_ids")) for capability in capabilities),
    "unmapped": sum(not capability.get("requirement_ids") for capability in capabilities),
    "coverage": f"{sum(bool(capability.get('requirement_ids')) for capability in capabilities) / len(capabilities):.0%}",
}
parser = argparse.ArgumentParser()
parser.add_argument("--write", action="store_true", help="refresh generated YAML and coverage summary")
args = parser.parse_args()
if args.write:
    atomic_write(REQ_DIR / "capability-coverage.json", json.dumps(expected_summary, indent=2) + "\n")
    atomic_write(REQ_DIR / "product-capability-inventory.yaml", render_yaml_view())

summary = json.loads((REQ_DIR / "capability-coverage.json").read_text())
if summary != expected_summary:
    errors.append(f"capability-coverage.json stale: expected {expected_summary}, found {summary}")
yaml_view = (REQ_DIR / "product-capability-inventory.yaml").read_text()
if yaml_view != render_yaml_view():
    errors.append("product-capability-inventory.yaml is stale; run with --write")

if errors:
    print("FAIL: capability coverage errors:")
    for error in errors:
        print(f"  - {error}")
    raise SystemExit(1)
print(f"PASS: {len(capabilities)} capabilities and {len(actionable_ids)} actionable requirements are mapped bidirectionally")
