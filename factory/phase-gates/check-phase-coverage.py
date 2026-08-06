#!/usr/bin/env python3
"""[REAL] Check exact Phase ownership and repository-state consistency."""
import json
import os
import re
import sys
from collections import Counter

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC_DIR = os.path.join(BASE, "spec")

req_path = os.path.join(SPEC_DIR, "requirements", "requirements.ndjson")
if not os.path.exists(req_path):
    print("FAIL: requirements.ndjson not found")
    sys.exit(1)

requirements = []
with open(req_path) as f:
    for line in f:
        if line.strip():
            requirements.append(json.loads(line))

errors = []
requirement_ids = [r["id"] for r in requirements]
duplicate_ids = sorted(rid for rid, count in Counter(requirement_ids).items() if count > 1)
if duplicate_ids:
    errors.append(f"Duplicate requirement IDs: {duplicate_ids}")

requirements_by_id = {r["id"]: r for r in requirements}
schema_path = os.path.join(SPEC_DIR, "requirements", "requirement-schema.json")
if not os.path.exists(schema_path):
    errors.append("Requirement schema missing")
else:
    with open(schema_path) as f:
        requirement_schema = json.load(f)
    for requirement in requirements:
        requirement_id = requirement.get("id", "<unknown>")
        for field in requirement_schema.get("required", []):
            if field not in requirement:
                errors.append(f"{requirement_id}: schema missing required field {field}")
        if requirement_schema.get("additionalProperties") is False:
            unknown = sorted(set(requirement) - set(requirement_schema.get("properties", {})))
            if unknown:
                errors.append(f"{requirement_id}: schema unknown fields {unknown}")
        for field, value in requirement.items():
            field_schema = requirement_schema.get("properties", {}).get(field, {})
            allowed_types = field_schema.get("type")
            if isinstance(allowed_types, str):
                allowed_types = [allowed_types]
            type_checks = {
                "string": lambda candidate: isinstance(candidate, str),
                "integer": lambda candidate: isinstance(candidate, int) and not isinstance(candidate, bool),
                "boolean": lambda candidate: isinstance(candidate, bool),
                "array": lambda candidate: isinstance(candidate, list),
                "null": lambda candidate: candidate is None,
            }
            if allowed_types and not any(type_checks[kind](value) for kind in allowed_types):
                errors.append(f"{requirement_id}: schema {field} has invalid type")
                continue
            if "enum" in field_schema and value not in field_schema["enum"]:
                errors.append(f"{requirement_id}: schema {field} has invalid enum value {value!r}")
            if isinstance(value, str) and "pattern" in field_schema and not re.fullmatch(field_schema["pattern"], value):
                errors.append(f"{requirement_id}: schema {field} does not match pattern")
            if isinstance(value, int) and not isinstance(value, bool):
                if value < field_schema.get("minimum", value):
                    errors.append(f"{requirement_id}: schema {field} is below minimum")
                if value > field_schema.get("maximum", value):
                    errors.append(f"{requirement_id}: schema {field} is above maximum")
            if isinstance(value, list):
                if len(value) < field_schema.get("minItems", 0):
                    errors.append(f"{requirement_id}: schema {field} has too few items")
                item_type = field_schema.get("items", {}).get("type")
                if item_type == "string" and any(not isinstance(item, str) for item in value):
                    errors.append(f"{requirement_id}: schema {field} contains a non-string item")

phase_reqs = {}
for requirement in requirements:
    phase_reqs.setdefault(requirement.get("delivery_phase", -1), []).append(requirement["id"])

manifest_membership = Counter()
manifest_statuses = {}
for phase in range(9):
    manifest_path = os.path.join(SPEC_DIR, "phases", f"phase-{phase}.yaml")
    if not os.path.exists(manifest_path):
        errors.append(f"Phase {phase}: manifest missing")
        continue
    with open(manifest_path) as f:
        manifest_lines = f.read().splitlines()

    status_line = next((line for line in manifest_lines if re.match(r"^status:\s*", line)), "")
    manifest_statuses[str(phase)] = status_line.split(":", 1)[1].strip().strip('"\'') if status_line else None
    manifest_req_list = []
    in_requirements = False
    for line in manifest_lines:
        if line == "requirements:":
            in_requirements = True
            continue
        if in_requirements and line and not line.startswith((" ", "\t")):
            break
        if in_requirements:
            match = re.match(r"^\s+-\s+(AH-[A-Z0-9-]+-\d{3})", line)
            if match:
                manifest_req_list.append(match.group(1))
    manifest_counts = Counter(manifest_req_list)
    duplicate_members = sorted(rid for rid, count in manifest_counts.items() if count > 1)
    if duplicate_members:
        errors.append(f"Phase {phase}: duplicate manifest members: {duplicate_members}")

    manifest_membership.update(manifest_req_list)
    manifest_reqs = set(manifest_req_list)
    expected = set(phase_reqs.get(phase, []))
    missing = sorted(expected - manifest_reqs)
    extra = sorted(manifest_reqs - expected)
    if missing:
        errors.append(f"Phase {phase}: missing from manifest: {missing}")
    if extra:
        errors.append(f"Phase {phase}: wrong-phase or unknown members: {extra}")
    if phase == 1:
        manifest_position = {requirement_id: index for index, requirement_id in enumerate(manifest_req_list)}
        for requirement_id in manifest_req_list:
            requirement = requirements_by_id.get(requirement_id, {})
            for dependency_id in requirement.get("dependencies", []):
                if dependency_id in manifest_position and manifest_position[dependency_id] > manifest_position[requirement_id]:
                    errors.append(
                        f"Phase 1: {requirement_id} appears before dependency {dependency_id} in implementation order"
                    )

duplicate_phase_owners = sorted(rid for rid, count in manifest_membership.items() if count > 1)
if duplicate_phase_owners:
    errors.append(f"Requirements owned by multiple Phase manifests: {duplicate_phase_owners}")

for requirement in requirements:
    phase = requirement.get("delivery_phase", -1)
    for dependency_id in requirement.get("dependencies", []):
        dependency = requirements_by_id.get(dependency_id)
        if dependency is None:
            errors.append(f"{requirement['id']}: unknown dependency {dependency_id}")
        elif dependency.get("delivery_phase", -1) > phase:
            errors.append(
                f"{requirement['id']}: Phase {phase} depends on later Phase "
                f"{dependency.get('delivery_phase')} requirement {dependency_id}"
            )

    if phase >= 1 and requirement.get("implementation_maturity") in {"implemented", "verified"}:
        for field in ("source_files", "test_files"):
            declared_paths = requirement.get(field, [])
            if not declared_paths:
                errors.append(f"{requirement['id']}: {field} is empty at implemented/verified maturity")
            for declared_path in declared_paths:
                if not os.path.exists(os.path.join(BASE, declared_path)):
                    errors.append(
                        f"{requirement['id']}: missing {field[:-1]} at implemented/verified maturity: "
                        f"{declared_path}"
                    )

state_path = os.path.join(BASE, "control", "current-state.json")
if not os.path.exists(state_path):
    errors.append("control/current-state.json missing")
else:
    with open(state_path) as f:
        current_state = json.load(f)
    for phase, manifest_status in manifest_statuses.items():
        state_status = current_state.get("phases", {}).get(phase, {}).get("status")
        if state_status != manifest_status:
            errors.append(
                f"Phase {phase}: manifest status {manifest_status!r} != current-state status {state_status!r}"
            )
    recorded_count = current_state.get("verification_evidence", {}).get("requirements")
    if recorded_count != len(requirements):
        errors.append(
            f"current-state requirement count {recorded_count!r} != registry count {len(requirements)}"
        )
    recorded_summary = current_state.get("registry_summary", {})
    actual_phase_summary = {}
    for phase in range(9):
        phase_rows = [r for r in requirements if r.get("delivery_phase") == phase]
        actual_phase_summary[str(phase)] = {
            "total": len(phase_rows),
            "maturity": dict(sorted(Counter(r.get("implementation_maturity") for r in phase_rows).items())),
        }
    if recorded_summary.get("phases") != actual_phase_summary:
        errors.append("current-state registry_summary.phases does not match requirements.ndjson")
    capability_coverage_path = os.path.join(SPEC_DIR, "requirements", "capability-coverage.json")
    if os.path.exists(capability_coverage_path):
        with open(capability_coverage_path) as f:
            capability_coverage = json.load(f)
        actual_capability_summary = {
            "total": capability_coverage.get("total_capabilities"),
            "mapped": capability_coverage.get("mapped"),
            "unmapped": capability_coverage.get("unmapped"),
        }
        if recorded_summary.get("capabilities") != actual_capability_summary:
            errors.append("current-state registry_summary.capabilities does not match capability-coverage.json")
    else:
        errors.append("spec/requirements/capability-coverage.json missing")

if errors:
    print("FAIL: Phase architecture consistency errors:")
    for error in errors:
        print(f"  - {error}")
    sys.exit(1)
else:
    print(
        f"PASS: {len(requirements)} requirements have one Phase owner, valid dependency order, "
        "truthful implemented/verified paths, and consistent authoritative state"
    )
