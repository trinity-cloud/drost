from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

SEED_DIR = Path(__file__).resolve().parent / "bootstrap" / "workspace"


def _is_safe_workspace_relative(path: Path) -> bool:
    if path.is_absolute():
        return False
    return ".." not in path.parts


def seed_workspace_files(*, workspace_dir: Path, prompt_workspace_files: Iterable[str]) -> list[Path]:
    """Seed missing workspace prompt files from in-repo templates.

    Existing files are never overwritten.
    """
    created: list[Path] = []
    root = Path(workspace_dir).expanduser()
    root.mkdir(parents=True, exist_ok=True)

    for raw_name in prompt_workspace_files:
        rel_text = str(raw_name or "").strip()
        if not rel_text:
            continue
        rel = Path(rel_text)
        if not _is_safe_workspace_relative(rel):
            continue

        destination = (root / rel).resolve()
        if destination.exists():
            continue

        source = (SEED_DIR / rel).resolve()
        if not source.exists() or not source.is_file():
            continue

        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        created.append(destination)

    return created
