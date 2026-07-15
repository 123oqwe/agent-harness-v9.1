#!/usr/bin/env python3
"""[REAL] Context packet builder.
Builds minimal ContextPacket for a worker.
Only includes what the worker needs — not the entire repository.
"""
import json, os, sys, hashlib, datetime
from pathlib import Path

def build_packet(requirement, base_dir="."):
    """[REAL] Build a minimal ContextPacket from a requirement.
    
    The packet contains ONLY:
    - requirement ID, title, goal
    - acceptance criteria
    - dependencies
    - relevant schemas (from outputs)
    - allowed/forbidden paths
    - test commands
    - security/privacy invariants
    - budget
    - definition of done
    
    The packet does NOT contain:
    - the entire spec/ directory
    - other requirements
    - state.json
    - evidence files
    """
    spec_dir = os.path.join(base_dir, "spec")
    
    # Load relevant schemas
    relevant_schemas = []
    for output in requirement.get("outputs", []):
        if isinstance(output, str) and output.endswith(".schema.json"):
            schema_path = os.path.join(spec_dir, output) if not output.startswith("spec/") else os.path.join(base_dir, output)
            if os.path.exists(schema_path):
                with open(schema_path) as f:
                    schema = json.load(f)
                relevant_schemas.append({
                    "path": output,
                    "title": schema.get("title", ""),
                    "required_fields": schema.get("required", [])
                })
    
    # Load relevant ADRs
    relevant_adrs = []
    for adr_num in range(1, 13):
        adr_path = os.path.join(spec_dir, "adr", f"ADR-{adr_num:03d}-*.md")
        import glob
        adr_files = glob.glob(adr_path)
        if adr_files:
            with open(adr_files[0]) as f:
                adr_content = f.read()
            # Extract status
            status = "UNKNOWN"
            for line in adr_content.split("\n"):
                if line.startswith("## Status:"):
                    status = line.replace("## Status:", "").strip()
                    break
            relevant_adrs.append({
                "number": adr_num,
                "status": status,
                "path": os.path.relpath(adr_files[0], base_dir)
            })
    
    packet = {
        "schema_version": "context-packet.v1",
        "requirement_id": requirement["id"],
        "title": requirement["title"],
        "goal": requirement.get("description", requirement["title"]),
        "acceptance_criteria": requirement.get("acceptance_criteria", []),
        "dependencies": requirement.get("dependencies", []),
        "relevant_schemas": relevant_schemas,
        "relevant_adrs": relevant_adrs,
        "allowed_paths": requirement.get("source_files", []),
        "forbidden_paths": ["spec/", "control/", "evidence/", "archive/"],
        "test_commands": requirement.get("test_files", []),
        "security_invariants": requirement.get("security_invariants", []),
        "privacy_invariants": requirement.get("privacy_invariants", []),
        "budget": {
            "tokens": 100000,
            "usd_micros": "500000",
            "currency": "USD"
        },
        "tool_permissions": requirement.get("owner_module", ""),
        "definition_of_done": "All acceptance criteria met + tests pass + evidence generated + verifier passes",
        "prior_verifier_feedback": None,
        "hash": hashlib.sha256(
            json.dumps(requirement, sort_keys=True).encode()
        ).hexdigest()[:16],
        "size_limit_bytes": 50000,
        "sensitivity_labels": ["internal"],
        "provenance": {
            "created_by": "context-packet-builder",
            "created_at": datetime.datetime.now().isoformat()
        },
        "expiry": (datetime.datetime.now() + datetime.timedelta(hours=2)).isoformat()
    }
    
    # Check size limit
    packet_size = len(json.dumps(packet).encode())
    packet["actual_size_bytes"] = packet_size
    if packet_size > packet["size_limit_bytes"]:
        # Truncate schemas and ADRs to fit
        packet["relevant_schemas"] = packet["relevant_schemas"][:3]
        packet["relevant_adrs"] = packet["relevant_adrs"][:5]
        packet["size_warning"] = f"Truncated to fit {packet['size_limit_bytes']} bytes"
    
    return packet

def validate_packet(packet):
    """Validate a ContextPacket has all required fields."""
    required_fields = [
        "schema_version", "requirement_id", "title", "goal",
        "acceptance_criteria", "allowed_paths", "forbidden_paths",
        "test_commands", "security_invariants", "definition_of_done", "hash"
    ]
    missing = [f for f in required_fields if f not in packet or packet[f] is None]
    return len(missing) == 0, missing
