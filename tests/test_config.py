from __future__ import annotations

from pathlib import Path

from drost.config import Settings


def test_exa_api_key_alias_from_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("EXA_API_KEY=test-exa-key\n", encoding="utf-8")

    settings = Settings(_env_file=str(env_file), workspace_dir=tmp_path)
    assert settings.exa_api_key == "test-exa-key"

