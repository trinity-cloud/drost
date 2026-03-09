from __future__ import annotations

from pathlib import Path

from drost.config import Settings


def test_exa_api_key_alias_from_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("EXA_API_KEY=test-exa-key\n", encoding="utf-8")

    settings = Settings(_env_file=str(env_file), workspace_dir=tmp_path)
    assert settings.exa_api_key == "test-exa-key"


def test_gemini_api_key_alias_from_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("GEMINI_API_KEY=test-gemini-key\n", encoding="utf-8")

    settings = Settings(_env_file=str(env_file), workspace_dir=tmp_path)
    assert settings.gemini_api_key == "test-gemini-key"
    assert settings.memory_embedding_provider == "gemini"
    assert settings.memory_embedding_model == "gemini-embedding-001"
    assert settings.memory_embedding_dimensions == 3072


def test_gateway_health_url_defaults_to_local_loopback(tmp_path: Path) -> None:
    settings = Settings(
        workspace_dir=tmp_path,
        gateway_host="0.0.0.0",
        gateway_port=8766,
    )

    assert settings.gateway_health_url == "http://127.0.0.1:8766/health"


def test_repo_root_resolves_and_runtime_defaults_are_set(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()

    settings = Settings(
        workspace_dir=tmp_path / "workspace",
        repo_root=repo_root,
    )

    assert settings.repo_root == repo_root.resolve()
    assert settings.runtime_launch_mode == "uv-run"
    assert settings.runtime_start_command == "uv run drost"
