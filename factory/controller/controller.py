#!/usr/bin/env python3
"""Factory Controller — the durable authority that controls requirements,
worktrees, tests, verification, merges, phases, deployments, and evidence.

This is NOT a task selection script. It is a state machine that:
1. Selects READY requirements
2. Acquires atomic locks
3. Creates worktrees
4. Assigns specialists
5. Dispatches workers
6. Collects evidence
7. Dispatches independent verifier
8. Manages merge queue
9. Updates registry atomically
10. Runs phase gates
11. Handles blockers
12. Survives restarts
"""
import json, os, sys, time, hashlib, datetime, subprocess
from pathlib import Path

# Add factory modules to path
sys.path.insert(0, str(Path(__file__).parent.parent / "state-store"))
sys.path.insert(0, str(Path(__file__).parent.parent / "requirement-queue"))
sys.path.insert(0, str(Path(__file__).parent.parent / "worktree-manager"))
sys.path.insert(0, str(Path(__file__).parent.parent / "context-packet-builder"))
sys.path.insert(0, str(Path(__file__).parent.parent / "evidence-collector"))
sys.path.insert(0, str(Path(__file__).parent.parent / "verifier"))
sys.path.insert(0, str(Path(__file__).parent.parent / "merge-queue"))
sys.path.insert(0, str(Path(__file__).parent.parent / "phase-gates"))
sys.path.insert(0, str(Path(__file__).parent.parent / "blocker-service"))
sys.path.insert(0, str(Path(__file__).parent.parent / "budget-ledger"))

from state_store import load_state, save_state, update, append_to_list, get

BASE_DIR = Path(__file__).parent.parent.parent
SPEC_DIR = BASE_DIR / "spec"
EVIDENCE_DIR = BASE_DIR / "evidence"

_log_buffer = []

def log(msg, level="INFO"):
    """Log to in-memory buffer (flushed by flush_logs)."""
    _log_buffer.append({
        "timestamp": datetime.datetime.now().isoformat(),
        "level": level,
        "message": msg
    })
    if len(_log_buffer) > 200:
        _log_buffer[:] = _log_buffer[-200:]
    print(f"[{level}] {msg}")

def flush_logs():
    """Flush buffered logs to state.json."""
    if not _log_buffer:
        return
    state = load_state()
    state.setdefault("command_history", []).extend(_log_buffer)
    state["command_history"] = state["command_history"][-1000:]
    save_state(state)
    _log_buffer.clear()

def select_ready_requirement():
    """[REAL] Select a READY requirement.
    
    Uses requirement_queue.build_queue for priority ordering when available.
    Falls back to inline scanning.
    Reads implementation_maturity from requirements.ndjson (source of truth).
    """
    # Try requirement_queue module for priority-ordered selection
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "requirement-queue"))
        from requirement_queue import build_queue
        state = load_state()
        req_path = SPEC_DIR / "requirements" / "requirements.ndjson"
        if req_path.exists():
            all_reqs = [json.loads(l) for l in open(req_path) if l.strip()]
            current_phase = state.get("current_phase", 0)
            req_status = state.get("requirement_status", {})
            queue = build_queue(all_reqs, current_phase, req_status)
            for _, _, _, req in queue:
                rid = req["id"]
                runtime_status = req_status.get(rid, {}).get("status")
                if runtime_status in ("verification_failed", "failed", "retry_required"):
                    retry_count = req_status.get(rid, {}).get("retry_count", 0)
                    if retry_count >= 3:
                        continue
                    last_failure = req_status.get(rid, {}).get("failure_reason", "")
                    permanent_markers = ["acceptance criteria", "specification_conflict", "impossible"]
                    if any(m in last_failure.lower() for m in permanent_markers):
                        continue
                log(f"Selected requirement: {rid}")
                return req
    except Exception:
        pass  # Fall back to inline implementation
    
    """Inline fallback: Select a READY requirement.
    Checks state.json only to avoid re-selecting requirements already in progress
    or that have failed and need retry.
    """
    req_path = SPEC_DIR / "requirements" / "requirements.ndjson"
    if not req_path.exists():
        log("Requirements file not found", "ERROR")
        return None
    
    state = load_state()
    current_phase = state.get("current_phase", 0)
    req_status = state.get("requirement_status", {})
    
    # Load all requirements into a dict for dependency lookup
    reqs = []
    req_map = {}
    with open(req_path) as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                reqs.append(r)
                req_map[r["id"]] = r
    
    for req in reqs:
        req_id = req["id"]
        
        # Must match current phase
        if req.get("delivery_phase") != current_phase:
            continue
        
        # Must be not_started in the registry (source of truth)
        if req.get("implementation_maturity") != "not_started":
            continue
        
        # Skip if Controller has already processed it (in_progress, verified, or failed)
        runtime_status = req_status.get(req_id, {}).get("status")
        if runtime_status in ("in_progress", "verified"):
            continue
        # Retry classification: limit retries to prevent infinite loops
        if runtime_status in ("verification_failed", "failed", "retry_required"):
            retry_count = req_status.get(req_id, {}).get("retry_count", 0)
            if retry_count >= 3:
                # Permanently failed after 3 retries — needs human intervention
                continue
            # Check if failure was transient (network/timeout) or permanent (criteria impossible)
            last_failure = req_status.get(req_id, {}).get("failure_reason", "")
            permanent_markers = ["acceptance criteria", "specification_conflict", "impossible"]
            if any(m in last_failure.lower() for m in permanent_markers):
                continue  # Don't retry permanent failures
        # Allow retry for "failed" or "verification_failed" or "retry_required"
        
        # Check dependencies: all must have implementation_maturity == "verified"
        deps = req.get("dependencies", [])
        all_deps_verified = True
        for dep_id in deps:
            dep_req = req_map.get(dep_id)
            if dep_req is None:
                # Dependency doesn't exist in registry
                log(f"Requirement {req_id} depends on non-existent {dep_id}", "WARN")
                all_deps_verified = False
                break
            if dep_req.get("implementation_maturity") != "verified":
                all_deps_verified = False
                break
        
        if all_deps_verified:
            return req
    
    return None

def acquire_lock(req_id):
    """[REAL] Acquire atomic lock for a requirement.
    
    Uses atomic_check_and_set: flock covers the entire check-and-set.
    No TOCTOU gap — two workers cannot both acquire the same lock.
    """
    from state_store import atomic_check_and_set
    
    lock_info = {
        "acquired_at": datetime.datetime.now().isoformat(),
        "worker": None,
        "status": "locked"
    }
    
    success, state = atomic_check_and_set("active_worktrees", req_id, lock_info)
    
    if not success:
        log(f"Requirement {req_id} already locked", "WARN")
        return False
    
    log(f"Lock acquired for {req_id}")
    return True

def release_lock(req_id):
    """[REAL] Release lock for a requirement. Uses flock-protected operation."""
    fd = None
    try:
        import fcntl
        lock_file = os.path.join(str(Path(__file__).parent.parent / "state-store"), "state.json.lock")
        fd = open(lock_file, 'w')
        fcntl.flock(fd, fcntl.LOCK_EX)
        
        state = load_state()
        active = state.get("active_worktrees", {})
        if req_id in active:
            del active[req_id]
            state["active_worktrees"] = active
            save_state(state)
            log(f"Lock released for {req_id}")
            return True
        return False
    finally:
        if fd:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_UN)
            fd.close()

def assign_specialist(req):
    """Assign specialist based on owner_role."""
    role = req.get("owner_role", "backend")
    role_map = {
        "backend": "factory/worker-adapters/codex",
        "frontend": "factory/worker-adapters/codex",
        "runtime": "factory/worker-adapters/codex",
        "routing": "factory/worker-adapters/codex",
        "rag_memory": "factory/worker-adapters/codex",
        "architecture": "factory/worker-adapters/codex",
        "devops": "factory/worker-adapters/codex",
        "admin": "factory/worker-adapters/codex",
        "sre": "factory/worker-adapters/codex",
        "product_requirements": "factory/worker-adapters/codex",
        "qa": "factory/worker-adapters/codex",
        "evaluation": "factory/worker-adapters/codex",
        "security": "factory/worker-adapters/codex",
        "privacy": "factory/worker-adapters/codex",
        "independent_verifier": "factory/worker-adapters/codex",
        "adversarial_reviewer": "factory/worker-adapters/codex",
        "cto_orchestrator": None,
    }
    adapter = role_map.get(role, "factory/worker-adapters/codex")

    # [REAL] Check provider CLI availability before assigning
    provider = "codex" if "codex" in (adapter or "") else "claude" if adapter else None
    if provider:
        try:
            sys.path.insert(0, str(Path(__file__).parent.parent / "worker-registry"))
            from worker_registry import check_provider_available
            available, msg = check_provider_available(provider)
            if not available:
                log(f"Provider {provider} not available: {msg}", "ERROR")
                return None
        except ImportError:
            check = subprocess.run(["which", provider], capture_output=True, text=True)
            if check.returncode != 0:
                log(f"Provider {provider} CLI not found", "ERROR")
                return None

    log(f"Assigned {role} specialist using {adapter} for {req['id']}")
    return adapter

def build_context_packet(req):
    """Build context packet. Delegates to context_packet_builder, falls back to inline."""
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "context-packet-builder"))
        from context_packet_builder import build_packet
        packet = build_packet(req, str(SPEC_DIR.parent))
        if packet and "requirement_id" in packet:
            return packet
    except Exception:
        pass
    packet = {
        "requirement_id": req["id"],
        "title": req["title"],
        "goal": req.get("description", req["title"]),
        "acceptance_criteria": req.get("acceptance_criteria", []),
        "dependencies": req.get("dependencies", []),
        "relevant_schemas": [o for o in req.get("outputs", []) if ".schema.json" in str(o)],
        "allowed_paths": req.get("source_files", []),
        "forbidden_paths": ["spec/", "control/"],
        "test_commands": req.get("test_files", []),
        "security_invariants": req.get("security_invariants", []),
        "privacy_invariants": req.get("privacy_invariants", []),
        "budget": {"tokens": 100000, "usd_micros": "500000"},
        "tool_permissions": req.get("owner_module", ""),
        "definition_of_done": "All acceptance criteria met + tests pass + evidence generated + verifier passes",
        "prior_verifier_feedback": None,
        "schema_version": "context-packet.v1",
        "hash": hashlib.sha256(json.dumps(req, sort_keys=True).encode()).hexdigest()[:16],
        "size_limit_bytes": 50000,
        "sensitivity_labels": ["internal"],
        "provenance": {"created_by": "factory-controller", "created_at": datetime.datetime.now().isoformat()},
        "expiry": (datetime.datetime.now() + datetime.timedelta(hours=2)).isoformat()
    }
    return packet

def dispatch_worker(req, context_packet, adapter_path, worktree_path=None):
    """[REAL] Dispatch worker — actually Popen Codex or Claude.
    
    Uses worker-adapters to start real CLI processes.
    Captures real stdout, stderr, exit_code.
    """
    state = load_state()
    
    # Determine provider and import adapter
    provider = "codex" if "codex" in adapter_path else "claude"
    adapter_dir = Path(__file__).parent.parent / "worker-adapters" / provider
    sys.path.insert(0, str(adapter_dir))
    
    try:
        from adapter import start_session, dispatch as adapter_dispatch, collect_result
    except ImportError:
        log(f"Could not import {provider} adapter", "ERROR")
        return {"status": "adapter_error", "exit_code": -1, "exit_reason": "import failed"}
    
    # Start session
    config = {"worktree_path": worktree_path}
    session = start_session(context_packet, config)
    
    # Record worker lease
    state.setdefault("worker_leases", {})[req["id"]] = {
        "adapter": adapter_path,
        "provider": provider,
        "started_at": session["start_time"],
        "heartbeat": session["start_time"],
        "lease_expiry": (datetime.datetime.now() + datetime.timedelta(hours=1)).isoformat(),
        "status": "active",
        "session_id": session["session_id"]
    }
    save_state(state)
    
    log(f"Worker dispatched for {req['id']} using {provider} (session={session['session_id']})")
    
    # [REAL] Actually dispatch — Popen the CLI process
    session = adapter_dispatch(session, timeout=1800)
    
    # [REAL] Collect result with real stdout/stderr
    result = collect_result(session)
    
    # Update worker lease
    state = load_state()
    if req["id"] in state.get("worker_leases", {}):
        state["worker_leases"][req["id"]]["status"] = "completed" if result.get("exit_code") == 0 else "failed"
        state["worker_leases"][req["id"]]["end_time"] = result.get("end_time")
    save_state(state)
    
    log(f"Worker completed for {req['id']}: exit_code={result.get('exit_code')}, stdout={len(result.get('stdout',''))} chars")
    
    return result

def collect_evidence(req_id, commands_run, exit_codes, stdout, stderr, test_results, coverage, worker_result=None):
    """[REAL] Collect evidence from actual command output.
    
    Delegates to evidence_collector.collect_from_worker when available,
    then enhances with test_results parsing and state update.
    """
    # Delegate structured evidence collection to evidence_collector module
    if worker_result:
        try:
            sys.path.insert(0, str(Path(__file__).parent.parent / "evidence-collector"))
            from evidence_collector import collect_from_worker, parse_test_output
            ev_path_obj = collect_from_worker(worker_result, req_id, str(EVIDENCE_DIR))
            if ev_path_obj:
                # Enhance: parse test results from stdout
                # Only parse from worker stdout if collect_from_worker didn't already
                # set test_results (from collect_test_output which runs npm test).
                # collect_test_output's parse is more reliable (real test output).
                parsed = parse_test_output(worker_result.get("stdout", "") or "")
                if parsed and not ev_path_obj.get("test_results"):
                   ev_path_obj["test_results"] = parsed
                # Add exit_codes for verifier compatibility
                ec = worker_result.get("exit_code")
                ev_path_obj["exit_codes"] = [ec] if ec is not None else []
                # Save enhanced evidence
                ev_file = EVIDENCE_DIR / f"{req_id}.json"
                ev_file.parent.mkdir(parents=True, exist_ok=True)
                with open(ev_file, 'w') as f:
                    json.dump(ev_path_obj, f, indent=2)
                # Update state
                state = load_state()
                state.setdefault("evidence_refs", {})[req_id] = str(ev_file)
                save_state(state)
                log(f"Evidence collected for {req_id}")
                return ev_path_obj
        except Exception:
            pass  # Fall back to inline implementation

    # Inline fallback
    if worker_result:
        stdout = worker_result.get("stdout", "") or ""
        stderr = worker_result.get("stderr", "") or ""
        exit_codes = [worker_result.get("exit_code", -1)] if worker_result.get("exit_code") is not None else []
        commands_run = [worker_result.get("dispatch_command", "unknown")] if worker_result.get("dispatch_command") else []

    # Refuse empty evidence
    if not stdout and not exit_codes:
        return {
            "requirement_id": req_id,
            "error": "REFUSED: empty evidence (no stdout, no exit codes)",
            "collected_at": datetime.datetime.now().isoformat()
        }

    # Parse test results from stdout
    parsed_tests = None
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "evidence-collector"))
        from evidence_collector import parse_test_output
        parsed_tests = parse_test_output(stdout)
    except Exception:
        pass

    # Construct evidence dict
    evidence = {
        "requirement_id": req_id,
        "collected_at": datetime.datetime.now().isoformat(),
        "commands_run": commands_run,
        "exit_codes": exit_codes,
        "stdout": stdout[:10000],
        "stdout_full_length": len(stdout),
        "stdout_hash": hashlib.sha256(stdout.encode()).hexdigest()[:16] if stdout else None,
        "stderr": stderr[:5000],
        "stderr_full_length": len(stderr),
        "stderr_hash": hashlib.sha256(stderr.encode()).hexdigest()[:16] if stderr else None,
        "test_results": parsed_tests,
        "coverage": coverage if coverage else None,
        "mode": "METADATA_ONLY" if not (BASE_DIR / "harness" / "package.json").exists() else "FULL"
    }

    # Save raw output to evidence directory
    ev_path = EVIDENCE_DIR / f"{req_id}.json"
    ev_path.parent.mkdir(parents=True, exist_ok=True)
    with open(ev_path, 'w') as f:
        json.dump(evidence, f, indent=2)
    evidence["raw_output_saved"] = True

    # Update state
    state = load_state()
    state.setdefault("evidence_refs", {})[req_id] = str(ev_path)
    save_state(state)

    log(f"Evidence collected for {req_id}")
    return evidence

def dispatch_verifier(req_id, evidence, commit_sha=None):
    """Dispatch independent verifier via subprocess.

    Verifier runs as a SEPARATE PROCESS (real process isolation).
    Uses standalone run_verifier.py which:
    - Runs in its own process
    - Has read-only access
    - When product code exists: reruns tests + optionally calls claude CLI (different model family)
    - Cannot modify code, tests, requirements, acceptance criteria, evidence
    - Cannot merge or approve production
    """
    state = load_state()
    
    verification = {
        "verification_id": f"VER-{req_id}-{int(time.time())}",
        "requirement_id": req_id,
        "verifier": "independent-verifier",
        "verifier_process": "separate",
        "verifier_read_only": True,
        "commit_sha": commit_sha,
        "evidence_ref": state.get("evidence_refs", {}).get(req_id),
        "checks": [],
        "result": "PENDING",
        "cannot_modify": ["code", "tests", "requirements", "acceptance_criteria", "evidence", "merge", "production_approval"],
        "started_at": datetime.datetime.now().isoformat()
    }
    
    # [REAL] Run verifier as a separate subprocess for true process isolation
    verifier_script = Path(__file__).parent.parent / "verifier" / "run_verifier.py"
    ev_path = state.get("evidence_refs", {}).get(req_id)

    try:
        result = subprocess.run(
            [sys.executable, str(verifier_script), req_id, ev_path or "", commit_sha or ""],
            capture_output=True, text=True, timeout=120,
            cwd=str(BASE_DIR)
        )
        if result.returncode == 0:
            verification = json.loads(result.stdout)
            verification["verifier_subprocess_pid"] = verification.get("verifier_pid")
            verification["verifier_model_family"] = "standalone"
        else:
            verification = {
                "verification_id": f"VER-{req_id}-{int(time.time())}",
                "requirement_id": req_id,
                "verifier": "standalone-subprocess",
                "result": "FAIL",
                "error": f"Verifier subprocess failed: {result.stderr[:500]}",
                "checks": [{"name": "subprocess_executed", "passed": False, "detail": result.stderr[:200]}],
                "started_at": datetime.datetime.now().isoformat(),
                "completed_at": datetime.datetime.now().isoformat()
            }
    except Exception as e:
        verification = {
            "verification_id": f"VER-{req_id}-{int(time.time())}",
            "requirement_id": req_id,
            "verifier": "standalone-subprocess",
            "result": "FAIL",
            "error": str(e),
            "checks": [{"name": "subprocess_executed", "passed": False, "detail": str(e)[:200]}],
            "started_at": datetime.datetime.now().isoformat(),
            "completed_at": datetime.datetime.now().isoformat()
        }

    # Record in state
    state.setdefault("verifier_results", {})[req_id] = verification
    save_state(state)

    log(f"Verifier result for {req_id}: {verification['result']} ({sum(1 for c in verification.get('checks', []) if c.get('passed'))}/{len(verification.get('checks', []))} checks passed)")
    return verification


def update_registry(req_id, status, verification=None):
    """Update requirement status in registry. Only controller can do this."""
    state = load_state()
    existing = state.get("requirement_status", {}).get(req_id, {})
    retry_count = existing.get("retry_count", 0)
    if status in ("verification_failed", "failed", "retry_required"):
        retry_count += 1
    elif status == "verified":
        retry_count = 0
    state.setdefault("requirement_status", {})[req_id] = {
        "status": status,
        "updated_at": datetime.datetime.now().isoformat(),
        "verification_id": verification["verification_id"] if verification else None,
        "verifier_result": verification["result"] if verification else None,
        "retry_count": retry_count,
        "failure_reason": verification.get("error", "") if verification and verification.get("result") == "FAIL" else existing.get("failure_reason", "")
    }
    save_state(state)

    # Sync ndjson implementation_maturity (source of truth for dependency checks)
    ndjson_maturity = {"verified": "verified", "in_progress": "in_progress"}.get(status)
    if ndjson_maturity:
        try:
            req_path = SPEC_DIR / "requirements" / "requirements.ndjson"
            lines = open(req_path).readlines()
            for i, line in enumerate(lines):
                if not line.strip():
                    continue
                r = json.loads(line)
                if r["id"] == req_id and r.get("implementation_maturity") != ndjson_maturity:
                    r["implementation_maturity"] = ndjson_maturity
                    lines[i] = json.dumps(r, ensure_ascii=False) + "\n"
                    break
            else:
                lines = None
            if lines:
                with open(req_path, 'w') as f:
                    f.writelines(lines)
        except Exception as e:
            log(f"Failed to sync ndjson for {req_id}: {e}", "WARN")

    log(f"Registry updated: {req_id} -> {status}")

def run_cycle():
    """Run one complete requirement cycle."""
    # Check for expired worker leases before starting
    expired = check_expired_leases()
    if expired:
        log(f"Expired {len(expired)} worker leases", "WARN")
    sync_phase_status()  # Ensure state.json matches current-state.json
    log("=== Factory Controller Cycle Start ===")
    
    # 1. Select READY requirement
    req = select_ready_requirement()
    if not req:
        log("No READY requirements found")
        # Check if phase is complete
        state = load_state()
        current_phase = state.get("current_phase", 0)
        # Would run phase gate here
        return {"action": "no_requirement", "phase": current_phase}
    
    req_id = req["id"]
    log(f"Selected requirement: {req_id}")
    
    # 2. Acquire atomic lock
    if not acquire_lock(req_id):
        log(f"Could not acquire lock for {req_id}", "WARN")
        return {"action": "lock_failed", "requirement": req_id}
    
    try:
        # 2.5 Mark in_progress (prevents re-selection on crash)
        update_registry(req_id, "in_progress")

        # 3. Build context packet
        packet = build_context_packet(req)
        log(f"Context packet built (hash: {packet['hash']})")

        # 4. Assign specialist
        adapter = assign_specialist(req)
        if not adapter:
            log(f"No adapter for role {req.get('owner_role')}", "ERROR")
            # Create blocker so run_loop stops retrying (provider unavailable)
            try:
                from blocker_service import create_blocker
                create_blocker(req_id, "provider_unavailable",
                    [f"Provider CLI not available for role {req.get('owner_role')}"],
                    "Install provider CLI or assign different role")
            except Exception:
                pass
            release_lock(req_id)
            return {"action": "no_adapter", "requirement": req_id}

        # 4.5 Create isolated worktree
        from worktree_manager import create_worktree, remove_worktree
        wt = create_worktree(req_id)
        if not wt.get("created"):
            log(f"Failed to create worktree for {req_id}: {wt.get('error')}", "ERROR")
            release_lock(req_id)
            return {"action": "worktree_failed", "requirement": req_id}
        worktree_path = wt["path"]
        worktree_branch = wt["branch"]
        log(f"Worktree created: {worktree_path} (branch={worktree_branch})")

        try:
            # 5. Reserve budget before dispatch
            try:
                sys.path.insert(0, str(Path(__file__).parent.parent / "budget-ledger"))
                from budget_ledger import reserve, consume, check_budget
                budget_usd = int(packet.get("budget", {}).get("usd_micros", "500000"))
                reserve(req_id, budget_usd, category="model")
                if not check_budget(req_id, budget_usd):
                    log(f"Budget insufficient for {req_id} — blocking dispatch", "ERROR")
                    release_lock(req_id)
                    remove_worktree(req_id)
                    return {"action": "budget_exhausted", "requirement": req_id}
            except Exception:
                pass

            # 5.1 Dispatch worker — [REAL] actually Popen Codex/Claude
            worker_result = dispatch_worker(req, packet, adapter, worktree_path=worktree_path)

            # 5.2 Consume actual budget
            try:
                from budget_ledger import consume as budget_consume
                stdout_len = len(worker_result.get("stdout", "") or "")
                actual_cost = min(budget_usd, max(100000, stdout_len * 10))
                budget_consume(req_id, actual_cost, category="model")
            except Exception:
                pass

            # 5.5 Commit worker output in worktree
            worker_committed = False
            if worker_result.get("exit_code") == 0:
                # Check if there are actual changes to commit (prevent empty commit fake PASS)
                diff_check = subprocess.run(
                    ["git", "add", "-A"], cwd=worktree_path, capture_output=True
                )
                diff_cached = subprocess.run(
                    ["git", "diff", "--cached", "--quiet"],
                    cwd=worktree_path, capture_output=True
                )
                # exit code 1 = there are staged changes, 0 = nothing staged
                if diff_cached.returncode == 1:
                    commit = subprocess.run(
                        ["git", "commit", "-m", f"Implement {req_id}"],
                        cwd=worktree_path, capture_output=True, text=True
                    )
                    if commit.returncode == 0:
                        worker_committed = True
                        log(f"Committed {req_id} in worktree")
                    else:
                        log(f"Git commit failed for {req_id}: {commit.stderr[:200]}", "WARN")
                else:
                    log(f"No file changes from worker for {req_id} — empty commit, marking as failed", "WARN")

            # 6. If worker didn't commit anything, fail immediately without verifier
            if not worker_committed:
                verification = {
                    "verification_id": f"VER-{req_id}-{int(time.time())}",
                    "requirement_id": req_id,
                    "verifier": "controller-precheck",
                    "result": "FAIL",
                    "error": "git commit failed: no files changed by worker. Worker produced no output.",
                    "checks": [{"name": "worker_produced_output", "passed": False, "detail": "No staged changes after worker execution"}],
                    "started_at": datetime.datetime.now().isoformat(),
                    "completed_at": datetime.datetime.now().isoformat()
                }
                state = load_state()
                state.setdefault("verifier_results", {})[req_id] = verification
                save_state(state)
                update_registry(req_id, "verification_failed", verification)
                log(f"Requirement {req_id} FAILED: no output from worker", "WARN")
                remove_worktree(req_id)
                release_lock(req_id)
                return {"action": "completed", "requirement": req_id, "verification": "FAIL", "evidence": {"error": "no output"}}

            # 7. Collect evidence from worker's actual stdout/stderr
            evidence = collect_evidence(
                req_id,
                commands_run=[],
                exit_codes=[],
                stdout="",
                stderr="",
                test_results={},
                coverage={},
                worker_result=worker_result
            )

            # 8. Dispatch verifier (with real commit_sha from the new commit)
            commit_sha = None
            try:
                rev = subprocess.run(
                    ["git", "rev-parse", "HEAD"],
                    cwd=worktree_path, capture_output=True, text=True
                )
                if rev.returncode == 0:
                    commit_sha = rev.stdout.strip()
            except Exception:
                pass
            verification = dispatch_verifier(req_id, evidence, commit_sha=commit_sha)

            # 8. Update registry and merge based on verification
            if verification["result"] == "PASS":
                update_registry(req_id, "verified", verification)
                log(f"Requirement {req_id} VERIFIED")
                # 8.5 Enqueue merge
                from merge_queue import enqueue, process_next
                enqueue(req_id, worktree_branch, verification)
                merge_result = process_next()
                if merge_result and merge_result.get("status") == "merged":
                    log(f"Requirement {req_id} MERGED")
                elif merge_result:
                    log(f"Merge for {req_id}: {merge_result.get('status')}", "WARN")
            else:
                update_registry(req_id, "verification_failed", verification)
                log(f"Requirement {req_id} VERIFICATION FAILED", "WARN")
                # Clean up worktree on failure
                remove_worktree(req_id)

        finally:
            # Clean up worktree on any non-merged path (prevents leak on exception)
            try:
                state = load_state()
                # Check if this requirement was merged (not in active_worktrees = already cleaned)
                if req_id in state.get("active_worktrees", {}):
                    remove_worktree(req_id)
                    log(f"Worktree cleanup for {req_id} (exception/non-merged path)")
            except Exception:
                pass

        # 9. Release lock
        release_lock(req_id)
        flush_logs()

        return {
            "action": "completed",
            "requirement": req_id,
            "verification": verification["result"],
            "evidence": evidence
        }
        
    except Exception as e:
        log(f"Error in cycle for {req_id}: {e}", "ERROR")
        release_lock(req_id)
        update_registry(req_id, "failed")
        flush_logs()
        return {"action": "error", "requirement": req_id, "error": str(e)}

def restart_recovery():
    """Recover from crash/restart."""
    state = load_state()
    state["restart_count"] = state.get("restart_count", 0) + 1
    
    # Check for orphaned locks
    active = state.get("active_worktrees", {})
    now = datetime.datetime.now()
    
    for req_id, info in list(active.items()):
        acquired = datetime.datetime.fromisoformat(info["acquired_at"])
        if (now - acquired).total_seconds() > 3600:  # 1 hour timeout
            log(f"Releasing orphaned lock for {req_id} (acquired >1h ago)")
            del active[req_id]
            state["active_worktrees"] = active
            # Mark requirement as needing retry
            state.setdefault("requirement_status", {})[req_id] = {
                "status": "retry_required",
                "reason": "orphaned_lock_recovery",
                "updated_at": now.isoformat()
            }
    
    save_state(state)
    log(f"Restart recovery complete (restart #{state['restart_count']})")

def sync_phase_status():
    """[REAL] Sync state.json phase_status with control/current-state.json.
    
    Ensures the two state sources never contradict each other.
    control/current-state.json is the authority — state.json follows.
    """
    cs_path = BASE_DIR / "control" / "current-state.json"
    if not cs_path.exists():
        return
    
    with open(cs_path) as f:
        cs = json.load(f)
    
    state = load_state()
    new_phase_status = {}
    for phase_id, phase_info in cs.get("phases", {}).items():
        new_phase_status[phase_id] = phase_info.get("status", "BLOCKED")
    
    if state.get("phase_status") != new_phase_status:
        state["phase_status"] = new_phase_status
        save_state(state)
        log(f"Synced phase_status from current-state.json: {new_phase_status}")

def advance_phase():
    """[REAL] Advance to the next phase after current phase gate passes."""
    state = load_state()
    current = state.get("current_phase", 0)
    next_phase = current + 1
    
    # Check if there are requirements for the next phase
    req_path = SPEC_DIR / "requirements" / "requirements.ndjson"
    has_next_reqs = False
    if req_path.exists():
        with open(req_path) as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    if r.get("delivery_phase") == next_phase:
                        has_next_reqs = True
                        break
    
    if not has_next_reqs:
        log(f"No requirements for phase {next_phase}, staying at phase {current}", "WARN")
        return False
    
    state["current_phase"] = next_phase
    state.setdefault("phase_status", {})[str(next_phase)] = "READY"
    save_state(state)
    log(f"Advanced to phase {next_phase}")
    
    # Update current-state.json
    cs_path = BASE_DIR / "control" / "current-state.json"
    if cs_path.exists():
        with open(cs_path) as f:
            cs = json.load(f)
        cs["phase"] = next_phase
        for pid in cs.get("phases", {}):
            if pid == str(next_phase):
                cs["phases"][pid]["status"] = "READY"
                cs["phases"][pid]["blockers"] = []
            elif pid == str(current):
                cs["phases"][pid]["status"] = "VERIFIED"
                cs["phases"][pid]["blockers"] = []
        cs["last_updated"] = datetime.datetime.now().isoformat()
        with open(cs_path, "w") as f:
            json.dump(cs, f, indent=2)
    
    return True

def check_expired_leases():
    """Check for expired worker leases and release them.
    
    Runs on every cycle to detect hung workers without waiting for restart.
    """
    state = load_state()
    now = datetime.datetime.now()
    expired = []
    
    for req_id, lease in state.get("worker_leases", {}).items():
        if lease.get("status") != "active":
            continue
        expiry_str = lease.get("lease_expiry")
        if not expiry_str:
            continue
        try:
            expiry = datetime.datetime.fromisoformat(expiry_str)
            if now > expiry:
                expired.append(req_id)
                lease["status"] = "expired"
                # Release the requirement lock
                if req_id in state.get("active_worktrees", {}):
                    del state["active_worktrees"][req_id]
                log(f"Worker lease expired for {req_id}, releasing", "WARN")
        except Exception:
            pass
    
    if expired:
        save_state(state)
    
    return expired


def deploy(environment="staging", gate_check=True):
    """Deploy to staging/canary/production.
    
    Requires ReleaseApproval for production.
    Runs phase gate before deploy.
    """
    if environment not in ("staging", "canary", "production"):
        return {"action": "deploy_failed", "error": f"Unknown environment: {environment}"}
    
    if environment == "production":
        # Check for ReleaseApproval
        release_path = SPEC_DIR / "contracts" / "release-approval.schema.json"
        state = load_state()
        release = state.get("release_approval")
        if not release:
            return {"action": "deploy_blocked", "error": "Production deploy requires signed ReleaseApproval"}
        log(f"Production deploy authorized by {release.get('approved_by')}")
    
    if gate_check:
        # Run current phase gate
        current_phase = load_state().get("current_phase", 0)
        try:
            sys.path.insert(0, str(BASE_DIR / "factory" / "phase-gates"))
            from gate_runner import run_phase_gate
            gate = run_phase_gate(current_phase)
            if gate.get("result") != "PASS":
                return {"action": "deploy_blocked", "error": f"Phase {current_phase} gate not passed", "gate": gate}
        except Exception as e:
            return {"action": "deploy_error", "error": str(e)}
    
    # Execute deployment
    deploy_script_map = {
        "staging": "deploy:staging",
        "canary": "deploy:canary",
        "production": "deploy:production",
    }
    
    harness_dir = BASE_DIR / "harness"
    
    if not (harness_dir / "package.json").exists():
        return {"action": "deploy_skipped", "error": "No harness code to deploy"}
    
    # Check if deploy script exists in package.json before calling
    try:
        pkg = json.load(open(harness_dir / "package.json"))
        script_name = deploy_script_map[environment]
        if script_name not in pkg.get("scripts", {}):
            return {"action": "deploy_skipped", "detail": f"No '{script_name}' script in package.json. Available: {list(pkg.get('scripts',{}).keys())}"}
    except Exception as e:
        return {"action": "deploy_error", "error": f"Cannot read package.json: {e}"}
    
    cmd = ["npm", "run", script_name]
    log(f"Deploying to {environment}: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=str(harness_dir), capture_output=True, text=True, timeout=600)
    
    deploy_result = {
        "action": "deployed" if result.returncode == 0 else "deploy_failed",
        "environment": environment,
        "exit_code": result.returncode,
        "stdout_hash": hashlib.sha256(result.stdout.encode()).hexdigest()[:16] if result.stdout else None,
        "stderr_hash": hashlib.sha256(result.stderr.encode()).hexdigest()[:16] if result.stderr else None,
        "deployed_at": datetime.datetime.now().isoformat()
    }
    
    # Record in state
    state = load_state()
    state.setdefault("deployments", []).append(deploy_result)
    save_state(state)
    
    log(f"Deploy to {environment}: {deploy_result['action']}")
    return deploy_result


def run_loop(max_iterations=None, idle_sleep_seconds=30, stop_on_blocker=True):
    """[REAL] Automatic scheduling loop.
    
    Continuously processes requirements until:
    - No READY requirements found (all done or blocked)
    - Max iterations reached
    - Open blocker exists (if stop_on_blocker=True)
    - Phase gate fails
    
    Usage:
        python3 controller.py loop                          # Run indefinitely
        python3 controller.py loop --max-iterations 10      # Run 10 cycles
        python3 controller.py loop --idle-sleep 60           # Sleep 60s when idle
    """
    from blocker_service import list_open_blockers
    
    iteration = 0
    idle_count = 0
    
    log(f"=== Factory Loop Started (max={max_iterations}, sleep={idle_sleep_seconds}s) ===")
    
    while max_iterations is None or iteration < max_iterations:
        iteration += 1
        
        # Check for open blockers
        open_blockers = list_open_blockers()
        if open_blockers and stop_on_blocker:
            log(f"Waiting: {len(open_blockers)} open blockers", "WARN")
            for b in open_blockers:
                log(f"  Blocker {b['blocker_id']}: {b['blocker_type']} - {b.get('required_decision','')}", "WARN")
            # 全自动模式: 不停止，轮询等待 blocker 被解决
            # 检查是否所有 blocker 都已解决
            import time
            while True:
                time.sleep(idle_sleep_seconds)
                from blocker_service import list_open_blockers
                remaining = list_open_blockers()
                if not remaining:
                    log("All blockers resolved, resuming...")
                    break
                log(f"Still {len(remaining)} open blockers, waiting...")
        
        # Run one cycle
        result = run_cycle()
        
        if result["action"] == "completed":
            idle_count = 0
            log(f"Iteration {iteration}: completed {result.get('requirement','')} -> {result.get('verification','')}")
            
        elif result["action"] == "no_requirement":
            idle_count += 1
            log(f"Iteration {iteration}: no READY requirements (idle #{idle_count})")
            
            # Try to run phase gate
            try:
                sys.path.insert(0, str(Path(__file__).parent.parent / "phase-gates"))
                from gate_runner import run_phase_gate
                state = load_state()
                current_phase = state.get("current_phase", 0)
                gate = run_phase_gate(current_phase)
                
                if gate["result"] == "PASS":
                    log(f"Phase {current_phase} gate PASSED, advancing...")
                    if not advance_phase():
                        log("Cannot advance, stopping loop", "WARN")
                        return {"action": "stopped_no_advance", "iterations": iteration}
                    # Auto-deploy to staging after phase advance (only if deploy script exists)
                    pkg_path = BASE_DIR / "harness" / "package.json"
                    if pkg_path.exists():
                        try:
                            pkg = json.load(open(pkg_path))
                            if "deploy:staging" in pkg.get("scripts", {}):
                                log("Auto-deploying to staging after phase advance")
                                deploy(environment="staging")
                        except Exception:
                            pass  # No deploy script yet, skip silently
                else:
                    failed_checks = [c["name"] for c in gate["checks"] if not c["passed"]]
                    log(f"Phase {current_phase} gate FAILED: {failed_checks}", "WARN")
                    # Don't stop, just wait and retry
            except Exception as e:
                log(f"Phase gate error: {e}", "ERROR")
            
            # 全自动模式: 不因空闲停止，继续等待
            # 可能有外部变化（blocker 被解决、新需求被添加）
            log(f"Idle #{idle_count}, waiting {idle_sleep_seconds}s for changes...")
            import time
            time.sleep(idle_sleep_seconds)
            
        elif result["action"] == "no_adapter":
            # no_adapter already created a blocker — don't sleep, check blockers immediately
            log(f"Iteration {iteration}: no_adapter (blocker created), checking blockers next cycle")
        elif result["action"] in ("error", "lock_failed"):
            idle_count += 1
            log(f"Iteration {iteration}: {result['action']} for {result.get('requirement','')}", "ERROR")
            import time
            time.sleep(idle_sleep_seconds)
    
    log(f"=== Factory Loop Ended ({iteration} iterations) ===")
    return {"action": "completed_loop", "iterations": iteration}

def run_daemon(idle_sleep_seconds=30):
    """[REAL] Daemon mode: run forever, auto-restart on crash, poll for blockers.
    
    This is the fully automatic mode. The controller:
    1. Runs run_loop() with no max_iterations
    2. If run_loop returns (error/crash), logs and restarts after 10s
    3. Continues until killed by signal
    """
    import signal, time
    
    def handle_signal(signum, frame):
        log(f"Received signal {signum}, shutting down daemon...", "WARN")
        # Save state
        state = load_state()
        state["daemon_running"] = False
        save_state(state)
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    
    state = load_state()
    state["daemon_running"] = True
    state["daemon_started_at"] = datetime.datetime.now().isoformat()
    save_state(state)
    
    log("=== Factory Daemon Started (fully automatic) ===")
    log("Controller will run indefinitely. Polling for READY requirements.")
    log("Blockers will pause execution until resolved.")
    log("Phase Gates will auto-advance when passed.")
    log("Kill with: kill <pid> or ctrl+C")
    
    restart_count = 0
    while True:
        try:
            result = run_loop(max_iterations=None, idle_sleep_seconds=idle_sleep_seconds, stop_on_blocker=True)
            # run_loop only returns on error — log and restart
            restart_count += 1
            log(f"Loop exited (restart #{restart_count}): {result.get('action','unknown')}", "WARN")
            log(f"Restarting in 10 seconds...", "WARN")
            time.sleep(10)
            
            # Recovery before restart
            restart_recovery()
            
        except KeyboardInterrupt:
            log("Daemon stopped by user", "WARN")
            break
        except Exception as e:
            restart_count += 1
            log(f"Daemon crash (restart #{restart_count}): {e}", "ERROR")
            log(f"Restarting in 10 seconds...", "ERROR")
            time.sleep(10)
            restart_recovery()
    
    state = load_state()
    state["daemon_running"] = False
    save_state(state)
    log("=== Factory Daemon Stopped ===")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Agent Harness Factory Controller")
    parser.add_argument("command", choices=["cycle", "loop", "daemon", "recover", "status", "select", "advance", "deploy"])
    parser.add_argument("--max-iterations", type=int, default=None)
    parser.add_argument("--idle-sleep", type=int, default=30)
    args = parser.parse_args()
    
    if args.command == "cycle":
        result = run_cycle()
        print(json.dumps(result, indent=2, default=str))
    elif args.command == "loop":
        result = run_loop(max_iterations=args.max_iterations, idle_sleep_seconds=args.idle_sleep)
        print(json.dumps(result, indent=2, default=str))
    elif args.command == "daemon":
        run_daemon(idle_sleep_seconds=args.idle_sleep)
    elif args.command == "recover":
        restart_recovery()
    elif args.command == "deploy":
        env = sys.argv[2] if len(sys.argv) > 2 else "staging"
        result = deploy(environment=env)
        print(json.dumps(result, indent=2, default=str))
    elif args.command == "status":
        state = load_state()
        print(json.dumps({
            "current_phase": state.get("current_phase"),
            "active_worktrees": len(state.get("active_worktrees", {})),
            "requirement_status_count": len(state.get("requirement_status", {})),
            "restart_count": state.get("restart_count", 0),
            "blockers": len(state.get("blockers", [])),
            "merge_queue": len(state.get("merge_queue", []))
        }, indent=2))
    elif args.command == "select":
        req = select_ready_requirement()
        if req:
            print(f"READY: {req['id']} - {req['title']}")
        else:
            print("No READY requirements")
    elif args.command == "advance":
        if advance_phase():
            print("Phase advanced")
        else:
            print("Cannot advance")
