from __future__ import annotations

from drost.context_budget import (
    estimate_history_tokens,
    should_compact_history,
    trim_history_to_budget,
)


def test_trim_history_to_budget_keeps_latest() -> None:
    rows = [
        {"role": "user", "content": "one " * 100},
        {"role": "assistant", "content": "two " * 100},
        {"role": "user", "content": "three " * 100},
    ]
    trimmed = trim_history_to_budget(rows, budget_tokens=120)
    assert trimmed
    assert trimmed[-1]["content"] == rows[-1]["content"]
    assert len(trimmed) < len(rows)


def test_should_compact_history() -> None:
    rows = [{"role": "user", "content": "x " * 400}]
    assert estimate_history_tokens(rows) > 0
    assert should_compact_history(rows, history_budget_tokens=50, trigger_ratio=0.7)

