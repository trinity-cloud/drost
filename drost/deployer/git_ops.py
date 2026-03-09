from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


class GitOperationError(RuntimeError):
    pass


@dataclass(slots=True)
class GitCheckoutResult:
    ref: str
    commit: str


def _run_git(repo_root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "-C", str(repo_root), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if check and result.returncode != 0:
        message = (result.stderr or result.stdout or "git command failed").strip()
        raise GitOperationError(message)
    return result


def resolve_head_commit(repo_root: Path) -> str:
    return _run_git(repo_root, "rev-parse", "HEAD").stdout.strip()


def resolve_ref(repo_root: Path, ref: str) -> str:
    trimmed = str(ref or "").strip()
    if not trimmed:
        raise GitOperationError("candidate ref is required")
    return _run_git(repo_root, "rev-parse", trimmed).stdout.strip()


def is_worktree_clean(repo_root: Path) -> bool:
    result = _run_git(repo_root, "status", "--porcelain", check=False)
    return result.returncode == 0 and not (result.stdout or "").strip()


def checkout_ref(repo_root: Path, ref: str) -> GitCheckoutResult:
    trimmed = str(ref or "").strip()
    if not trimmed:
        raise GitOperationError("checkout ref is required")
    _run_git(repo_root, "checkout", "--force", trimmed)
    return GitCheckoutResult(ref=trimmed, commit=resolve_head_commit(repo_root))


def normalize_ref_name(name: str) -> str:
    trimmed = str(name or "").strip()
    if not trimmed:
        raise GitOperationError("known-good ref name is required")
    if trimmed.startswith("refs/"):
        return trimmed
    return f"refs/drost/{trimmed}"


def update_ref(repo_root: Path, ref_name: str, commit: str) -> str:
    resolved_ref = normalize_ref_name(ref_name)
    resolved_commit = resolve_ref(repo_root, commit)
    _run_git(repo_root, "update-ref", resolved_ref, resolved_commit)
    return resolved_ref
