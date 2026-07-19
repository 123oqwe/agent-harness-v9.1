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
    
    # Map owner_module → relevant architecture docs (mirrors AGENTS.md Scenario-Based Reading Index)
    MODULE_DOC_MAP = {
        "runtime": ["architecture/runtime-core.md", "architecture/action-control.md", "architecture/trust-boundaries.md", "contracts/run-plan.schema.json"],
        "tools": ["architecture/tool-skill-fabric.md", "architecture/action-control.md", "contracts/tool-spec.schema.json", "contracts/effect-risk.schema.json", "contracts/capability-token.schema.json"],
        "security": ["architecture/action-control.md", "architecture/trust-boundaries.md", "architecture/security-control-mapping.md", "contracts/effect-risk.schema.json", "contracts/capability-token.schema.json", "threat-model/controls.yaml"],
        "routing": ["architecture/routing-system.md", "architecture/request-to-outcome.md", "contracts/run-plan.schema.json", "contracts/agent-graph.schema.json"],
        "router": ["architecture/routing-system.md", "architecture/request-to-outcome.md", "contracts/run-plan.schema.json", "contracts/agent-graph.schema.json"],
        "context": ["architecture/context-memory-rag.md", "contracts/context-graph.schema.json"],
        "memory": ["architecture/context-memory-rag.md", "contracts/memory-record.schema.json", "architecture/evolution.md"],
        "verification": ["architecture/assurance.md", "contracts/evidence-package.schema.json", "contracts/verification-graph.schema.json"],
        "gateway": ["architecture/model-api-gateway.md", "contracts/provider-adapter.schema.json"],
        "session": ["architecture/runtime-core.md", "state-machines/run.machine.json", "state-machines/step.machine.json"],
        "steering": ["architecture/runtime-core.md", "architecture/realtime-execution-visualization.md"],
        "hooks": ["architecture/harness-boundary.md"],
        "observability": ["architecture/assurance.md", "architecture/runtime-core.md"],
        "evolution": ["architecture/evolution.md", "architecture/assurance.md"],
        "external_actions": ["architecture/action-control.md", "architecture/failure-recovery.md", "state-machines/external-effect.machine.json", "architecture/evolution.md"],
        "enterprise": ["architecture/harness-boundary.md", "architecture/trust-boundaries.md", "architecture/security-control-mapping.md", "architecture/runtime-topology.md"],
        "documents": ["architecture/tool-skill-fabric.md", "architecture/context-memory-rag.md", "architecture/virtual-filesystem.md"],
        "multimodal": ["architecture/tool-skill-fabric.md", "architecture/model-api-gateway.md"],
        "personal_assistant": ["architecture/runtime-core.md", "architecture/context-memory-rag.md"],
        "founder_operator": ["architecture/routing-system.md", "architecture/runtime-core.md", "state-machines/mission.machine.json"],
        "frontend": ["architecture/realtime-execution-visualization.md", "api/asyncapi.yaml"],
        "operations": ["architecture/deployment-topology.md", "architecture/runtime-topology.md"],
        "deployment": ["architecture/deployment-topology.md", "architecture/runtime-topology.md"],
        "api": ["api/openapi.yaml", "api/asyncapi.yaml", "api/error-catalog.yaml"],
        "contracts": ["contracts/tool-spec.schema.json", "contracts/run-plan.schema.json"],
        "architecture": ["architecture/harness-boundary.md", "architecture/module-boundaries.md", "architecture/trust-boundaries.md"],
        "state-machines": ["state-machines/run.machine.json", "state-machines/operation.machine.json", "state-machines/invariants.md"],
        "adr": ["spec/NORMATIVE_PRECEDENCE.md"],
        "requirements": ["spec/AI_EXECUTION_PROTOCOL.md", "spec/NORMATIVE_PRECEDENCE.md"],
        "evaluation": ["spec/evals/"],
        "scripts": ["spec/AI_EXECUTION_PROTOCOL.md"],
        "threat-model": ["threat-model/threats.yaml", "threat-model/controls.yaml", "threat-model/control-test-map.yaml"],
    }
    owner_module = requirement.get("owner_module", "")
    relevant_docs = MODULE_DOC_MAP.get(owner_module, ["architecture/harness-boundary.md", "spec/AI_EXECUTION_PROTOCOL.md"])
    # Also add architecture docs based on dependencies (e.g. AH-TOOL-READ-001 depends on AH-SANDBOX-001 → read trust-boundaries)
    dep_ids = requirement.get("dependencies", [])
    if any("SANDBOX" in d for d in dep_ids):
        if "architecture/trust-boundaries.md" not in relevant_docs:
            relevant_docs.append("architecture/trust-boundaries.md")
        if "architecture/runtime-topology.md" not in relevant_docs:
            relevant_docs.append("architecture/runtime-topology.md")
    if any("POLICY" in d or "CAPABILITY" in d for d in dep_ids):
        if "architecture/action-control.md" not in relevant_docs:
            relevant_docs.append("architecture/action-control.md")
        if "architecture/security-control-mapping.md" not in relevant_docs:
            relevant_docs.append("architecture/security-control-mapping.md")
    if any("EFFECTRISK" in d for d in dep_ids):
        if "contracts/effect-risk.schema.json" not in relevant_docs:
            relevant_docs.append("contracts/effect-risk.schema.json")
    
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
    for adr_num in range(1, 14):
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

    # Read doc file contents so workers don't waste reasoning turns on file IO
    relevant_docs_content = {}
    for doc_path in relevant_docs:
        full_path = doc_path if os.path.isabs(doc_path) else os.path.join(spec_dir, doc_path)
        if os.path.isfile(full_path):
            try:
                with open(full_path, encoding="utf-8") as f:
                    content = f.read()
                # Cap each doc at 12000 chars to stay within packet size limit
                if len(content) > 12000:
                    content = content[:12000] + "\n...[truncated]"
                relevant_docs_content[doc_path] = content
            except Exception:
                pass

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
        "relevant_docs": relevant_docs,
        "relevant_docs_content": relevant_docs_content,
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
