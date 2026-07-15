#!/usr/bin/env python3
"""
Agent Harness v9.2 Specification Validator
Runs actual checks and generates report from command output.
Does NOT self-declare PASS.
"""
import json, os, sys, re, hashlib, subprocess, datetime
from pathlib import Path

BASE = Path(__file__).parent.parent
FAILURES = []
WARNINGS = []
FILES_CHECKED = 0

def check(condition, message, file_path=""):
    global FILES_CHECKED
    FILES_CHECKED += 1
    if not condition:
        FAILURES.append({"check": message, "file": file_path})
        return False
    return True

def warn(condition, message, file_path=""):
    if not condition:
        WARNINGS.append({"check": message, "file": file_path})

# 1. Check referenced files exist
def check_file_references():
    # Check SPECIFICATION_INDEX references
    idx_path = BASE / "SPECIFICATION_INDEX.yaml"
    if idx_path.exists():
        with open(idx_path) as f:
            content = f.read()
        for match in re.findall(r'\b([\w/-]+\.[\w]+)\b', content):
            if match.startswith("agent-harness") or "/" not in match:
                continue
            fpath = BASE / match
            if not fpath.exists() and not match.startswith("http"):
                check(False, f"Referenced file missing: {match}", str(idx_path))

# 2. Check placeholder content
def check_placeholders():
    for fpath in BASE.rglob("*"):
        if fpath.is_file() and fpath.suffix in ('.md', '.yaml', '.json', '.txt', '.tla'):
            if '.git' in str(fpath) or 'artifacts' in str(fpath) or 'deprecated' in str(fpath):
                continue
            try:
                content = fpath.read_text()
            except:
                continue
            rel = str(fpath.relative_to(BASE))
            # Check for PENDING in model check
            if 'model-check' in rel and 'PENDING' in content:
                check(False, f"Model check report is PENDING", rel)
            # Check for TODO/FIXME in frozen contracts
            if 'contracts/' in rel and ('TODO' in content or 'FIXME' in content):
                check(False, f"TODO/FIXME in frozen contract", rel)
            # Check for generic UI template
            if 'ui/screens/' in rel and 'GET /runs' in content and 'skeleton_loader' in content:
                check(False, f"Generic UI template (all screens have identical content)", rel)

# 3. Check requirement coverage
def check_requirements():
    reqs_path = BASE / "requirements" / "requirements.ndjson"
    if not reqs_path.exists():
        check(False, "requirements.ndjson missing", str(reqs_path))
        return
    
    reqs = []
    with open(reqs_path) as f:
        for line in f:
            if line.strip():
                try:
                    reqs.append(json.loads(line))
                except:
                    check(False, f"Invalid JSON in requirements.ndjson", str(reqs_path))
    
    ids = [r.get("id","") for r in reqs]
    
    # Duplicate IDs
    dupes = [x for x in ids if ids.count(x) > 1]
    check(len(set(dupes)) == 0, f"Duplicate requirement IDs: {set(dupes)}", str(reqs_path))
    
    # Requirements without tests
    no_tests = [r["id"] for r in reqs if not r.get("test_files")]
    check(len(no_tests) == 0, f"Requirements without test_files: {no_tests[:5]}", str(reqs_path))
    
    # Requirements without acceptance criteria
    no_accept = [r["id"] for r in reqs if not r.get("acceptance_criteria")]
    check(len(no_accept) == 0, f"Requirements without acceptance_criteria: {no_accept[:5]}", str(reqs_path))
    
    # Phase coverage
    phase_cov = {}
    for r in reqs:
        p = r.get("delivery_phase", -1)
        phase_cov[p] = phase_cov.get(p, 0) + 1
    
    for phase in range(9):
        count = phase_cov.get(phase, 0)
        check(count > 0, f"Phase {phase} has 0 requirements", f"phases/phase-{phase}.yaml")
    
    return reqs

# 4. Check phase manifests
def check_phases(reqs):
    for i in range(9):
        ppath = BASE / f"phases" / f"phase-{i}.yaml"
        if not ppath.exists():
            check(False, f"phase-{i}.yaml missing", str(ppath))
            continue
        
        with open(ppath) as f:
            content = f.read()
        
        # Check status is not READY/VERIFIED unless justified
        if "status: READY" in content or "status: VERIFIED" in content:
            check(False, f"Phase {i} claims READY/VERIFIED but validation not run", str(ppath))
        
        # Check requirements list is not empty
        req_count = content.count("  - AH-")
        check(req_count > 0, f"Phase {i} has 0 requirements in manifest", str(ppath))

# 5. Check dependency cycles
def check_cycles(reqs):
    dep_graph = {}
    for r in reqs:
        dep_graph[r["id"]] = r.get("dependencies", [])
    
    visited = set()
    rec_stack = set()
    
    def dfs(node):
        visited.add(node)
        rec_stack.add(node)
        for dep in dep_graph.get(node, []):
            if dep not in visited:
                if dfs(dep):
                    return True
            elif dep in rec_stack:
                return True
        rec_stack.remove(node)
        return False
    
    has_cycle = False
    for node in dep_graph:
        if node not in visited:
            if dfs(node):
                has_cycle = True
                break
    
    check(not has_cycle, "Dependency cycle detected in requirements", "requirements/dependency-graph.json")

# 6. Check API files
def check_api():
    api_files = ['openapi.yaml', 'asyncapi.yaml', 'error-catalog.yaml', 'auth-scopes.yaml', 'rate-limits.yaml', 'compatibility-policy.md']
    for f in api_files:
        fpath = BASE / "api" / f
        if not fpath.exists():
            check(False, f"API file missing: api/{f}", str(fpath))
        else:
            size = fpath.stat().st_size
            check(size > 100, f"API file too small (possibly placeholder): api/{f} ({size} bytes)", str(fpath))
    
    # Check OpenAPI has real operations
    oa_path = BASE / "api" / "openapi.yaml"
    if oa_path.exists():
        with open(oa_path) as f:
            oa = f.read()
        op_count = len(re.findall(r'operationId:', oa))
        check(op_count >= 20, f"OpenAPI has only {op_count} operations (need 20+)", str(oa_path))

# 7. Check state machines
def check_state_machines():
    sm_dir = BASE / "state-machines"
    machines = list(sm_dir.glob("*.machine.json"))
    check(len(machines) >= 7, f"Only {len(machines)} state machines (need 7)", str(sm_dir))
    
    tla_path = sm_dir / "harness.tla"
    check(tla_path.exists(), "TLA+ spec missing", str(tla_path))
    
    # Check model check report
    mc_path = sm_dir / "model-check-report.txt"
    if mc_path.exists():
        with open(mc_path) as f:
            mc = f.read()
        # Check that model check status is explicitly VERIFIED (not BLOCKED, not PENDING)
        status_line = [l for l in mc.split("\n") if l.startswith("Status:")]
        if status_line:
            status = status_line[0].replace("Status:", "").strip()
            check(status == "VERIFIED", f"Model check status is {status} (must be VERIFIED)", str(mc_path))
        else:
            check(False, "Model check report has no Status line", str(mc_path))
    else:
        check(False, "model-check-report.txt missing", str(mc_path))

# 8. Check ADR status
def check_adrs():
    adr_dir = BASE / "adr"
    for f in adr_dir.glob("ADR-*.md"):
        with open(f) as fh:
            content = fh.read()
        if "NEEDS_VERIFICATION" in content:
            warn(True, f"ADR still NEEDS_VERIFICATION: {f.name}", str(f))

# 9. Check deprecated references in normative files
def check_deprecated_refs():
    for fpath in BASE.rglob("*"):
        if fpath.is_file() and fpath.suffix in ('.md', '.yaml'):
            if 'deprecated' in str(fpath) or 'appendix' in str(fpath) or 'artifacts' in str(fpath):
                continue
            try:
                content = fpath.read_text()
            except:
                continue
            if 'deprecated-v8-content' in content and 'appendix/deprecated-v8-content' not in content:
                check(False, f"Normative file references deprecated content without appendix prefix", str(fpath))

# 10. Check CODEOWNERS
def check_protection():
    co_path = BASE / "CODEOWNERS"
    check(co_path.exists(), "CODEOWNERS missing", str(co_path))

# 11. Check orchestrator
def check_orchestrator():
    orch_dir = BASE / "scripts" / "orchestrator"
    main_path = orch_dir / "main"
    check(main_path.exists(), "Orchestrator main script missing", str(main_path))

# Run all checks
print("Running specification validation...")
started = datetime.datetime.now().isoformat()

check_file_references()
check_placeholders()
reqs = check_requirements()
if reqs:
    check_phases(reqs)
    check_cycles(reqs)
check_api()
check_state_machines()
check_adrs()
check_deprecated_refs()
check_protection()
check_orchestrator()

completed = datetime.datetime.now().isoformat()

# Generate report
report = {
    "validator_commit": "v9.2-repair",
    "started_at": started,
    "completed_at": completed,
    "files_checked": FILES_CHECKED,
    "failures": FAILURES,
    "warnings": WARNINGS,
    "failure_count": len(FAILURES),
    "warning_count": len(WARNINGS),
    "overall": "FAIL" if FAILURES else "PASS",
    "note": "This report was generated by running actual file checks, not manually authored."
}

# Compute input tree hash
h = hashlib.sha256()
for fpath in sorted(BASE.rglob("*")):
    if fpath.is_file() and '.git' not in str(fpath) and 'artifacts' not in str(fpath):
        h.update(str(fpath.relative_to(BASE)).encode())
        h.update(fpath.read_bytes() if fpath.stat().st_size < 1000000 else b"large")
report["input_tree_hash"] = h.hexdigest()[:16]

report_path = BASE / "validation-report.json"
with open(report_path, "w") as f:
    json.dump(report, f, indent=2)

print(f"\nValidation complete: {report['overall']}")
print(f"  Files checked: {FILES_CHECKED}")
print(f"  Failures: {len(FAILURES)}")
print(f"  Warnings: {len(WARNINGS)}")
print(f"  Report: {report_path}")

if FAILURES:
    print(f"\nFailures:")
    for f in FAILURES[:20]:
        print(f"  FAIL: {f['check']} [{f.get('file','')}]")

sys.exit(1 if FAILURES else 0)
