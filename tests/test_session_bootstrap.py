from __future__ import annotations

from pathlib import Path

from drost.storage import SQLiteStore


def test_create_session_generates_timestamp_style_id(tmp_path: Path) -> None:
    store = SQLiteStore(db_path=tmp_path / "drost.sqlite3")
    sid = store.create_session(12345)
    assert sid.startswith("s_")
    assert "__" not in sid
    store.close()

