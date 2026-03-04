from __future__ import annotations

from typing import Any


def estimate_tokens_text(text: str) -> int:
    cleaned = str(text or "")
    if not cleaned:
        return 0
    # Lightweight approximation to avoid tokenizer dependency.
    return max(1, (len(cleaned) + 3) // 4)


def estimate_message_tokens(row: dict[str, Any]) -> int:
    role = str(row.get("role") or "")
    content = str(row.get("content") or "")
    return estimate_tokens_text(role) + estimate_tokens_text(content) + 4


def estimate_history_tokens(rows: list[dict[str, Any]]) -> int:
    return sum(estimate_message_tokens(row) for row in rows)


def trim_history_to_budget(rows: list[dict[str, Any]], budget_tokens: int) -> list[dict[str, Any]]:
    budget = max(1, int(budget_tokens))
    if not rows:
        return []

    out: list[dict[str, Any]] = []
    running = 0
    # Keep newest messages first, then reverse.
    for row in reversed(rows):
        tokens = estimate_message_tokens(row)
        if out and (running + tokens) > budget:
            break
        if not out and tokens > budget:
            # Always keep at least one latest message.
            out.append(row)
            break
        out.append(row)
        running += tokens
    out.reverse()
    return out


def should_compact_history(
    rows: list[dict[str, Any]],
    *,
    history_budget_tokens: int,
    trigger_ratio: float,
) -> bool:
    if not rows:
        return False
    threshold = int(max(1, history_budget_tokens) * float(trigger_ratio))
    return estimate_history_tokens(rows) > threshold


def truncate_text_to_budget(text: str, max_tokens: int) -> str:
    if max_tokens < 1:
        return ""
    max_chars = max_tokens * 4
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip()

