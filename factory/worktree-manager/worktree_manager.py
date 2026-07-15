#!/usr/bin/env python3
"""[REAL] Worktree manager.
Creates isolated git worktrees for each requirement.
Executes real git commands, checks return codes, handles errors.
"""
import os, subprocess, json, shutil
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent.parent
WORKTREE_BASE = BASE_DIR.parent / "worktrees"

def create_worktree(requirement_id, base_branch="main"):
    """[REAL] Create an isolated git worktree for a requirement.
    
    Executes: git worktree add <path> -b <branch> <base_branch>
    Returns dict with created=True/False and error details.
    """
    branch_name = f"req/{requirement_id}"
    worktree_path = WORKTREE_BASE / requirement_id
    
    # Ensure parent directory exists
    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    
    # If worktree already exists, remove it first
    if worktree_path.exists():
        shutil.rmtree(worktree_path, ignore_errors=True)
    
    # Execute real git command
    result = subprocess.run(
        ["git", "worktree", "add", str(worktree_path), "-b", branch_name, base_branch],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    
    if result.returncode != 0:
        # Maybe branch already exists, try without -b
        result2 = subprocess.run(
            ["git", "worktree", "add", str(worktree_path), branch_name],
            capture_output=True, text=True, cwd=str(BASE_DIR)
        )
        if result2.returncode != 0:
            return {
                "requirement_id": requirement_id,
                "branch": branch_name,
                "path": str(worktree_path),
                "created": False,
                "error": result.stderr + " | " + result2.stderr
            }
    
    return {
        "requirement_id": requirement_id,
        "branch": branch_name,
        "path": str(worktree_path),
        "base_branch": base_branch,
        "created": True
    }

def remove_worktree(requirement_id):
    """[REAL] Remove worktree after merge.
    
    Executes: git worktree remove <path>
    """
    worktree_path = WORKTREE_BASE / requirement_id
    
    result = subprocess.run(
        ["git", "worktree", "remove", str(worktree_path), "--force"],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    
    # Also delete the branch
    branch_name = f"req/{requirement_id}"
    subprocess.run(
        ["git", "branch", "-D", branch_name],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    
    return {
        "requirement_id": requirement_id,
        "removed": result.returncode == 0,
        "error": result.stderr if result.returncode != 0 else None
    }

def list_worktrees():
    """[REAL] List active worktrees.
    
    Executes: git worktree list --porcelain
    """
    result = subprocess.run(
        ["git", "worktree", "list", "--porcelain"],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    
    if result.returncode != 0:
        return []
    
    worktrees = []
    current = {}
    for line in result.stdout.strip().split("\n"):
        if line.startswith("worktree "):
            if current:
                worktrees.append(current)
            current = {"path": line.replace("worktree ", "")}
        elif line.startswith("branch "):
            current["branch"] = line.replace("branch ", "")
        elif line.startswith("HEAD "):
            current["head"] = line.replace("HEAD ", "")
        elif line == "":
            if current:
                worktrees.append(current)
                current = {}
    if current:
        worktrees.append(current)
    
    return worktrees
