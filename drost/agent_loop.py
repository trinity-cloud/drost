from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.config import Settings
from drost.loop_runner import LoopRunResult, StatusCallback
from drost.providers import BaseProvider, Message, MessageRole, ToolDefinition, ToolResult
from drost.tools import ToolRegistry

logger = logging.getLogger(__name__)

LOOP_CHECKLIST_PATCH = "loop_checklist_patch"
LOOP_FINISH = "loop_finish"
LOOP_BLOCKED = "loop_blocked"
_INTERNAL_LOOP_TOOL_NAMES = (LOOP_CHECKLIST_PATCH, LOOP_FINISH, LOOP_BLOCKED)
_CHECKLIST_STATUSES = {"pending", "in_progress", "done", "blocked", "dropped"}
_FINISH_OUTCOMES = {"done", "blocked", "dropped"}


def internal_loop_tool_names() -> list[str]:
    return list(_INTERNAL_LOOP_TOOL_NAMES)


@dataclass
class _ChecklistItem:
    item_id: str
    text: str
    status: str = "pending"
    rationale: str = ""
    evidence_refs: list[str] = field(default_factory=list)


@dataclass
class _LoopControlState:
    checklist: list[_ChecklistItem] = field(default_factory=list)
    finished: bool = False
    blocked: bool = False
    finish_message: str = ""
    blocked_message: str = ""


class DefaultSingleLoopRunner:
    def __init__(
        self,
        *,
        provider: BaseProvider,
        tool_registry: ToolRegistry,
        settings: Settings,
    ) -> None:
        self._provider = provider
        self._tool_registry = tool_registry
        self._settings = settings
        self._trace_enabled = bool(settings.trace_enabled)
        self._trace_dir = Path(settings.trace_dir).expanduser()

    @staticmethod
    def _is_error_result(text: str) -> bool:
        return str(text or "").lstrip().lower().startswith("error:")

    @staticmethod
    async def _emit_status(status_callback: StatusCallback | None, text: str) -> None:
        if status_callback is None:
            return
        try:
            await status_callback(text)
        except Exception:
            logger.debug("Status callback failed", exc_info=True)

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(UTC).isoformat()

    @staticmethod
    def _is_internal_tool_name(name: str) -> bool:
        return str(name or "").strip() in _INTERNAL_LOOP_TOOL_NAMES

    @staticmethod
    def _slugify_item_id(value: str) -> str:
        cleaned = re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")
        return cleaned[:48]

    @classmethod
    def _ensure_item_id(cls, requested: str, text: str, taken: set[str]) -> str:
        base = cls._slugify_item_id(requested or text) or f"item_{uuid.uuid4().hex[:8]}"
        candidate = base
        suffix = 2
        while candidate in taken:
            candidate = f"{base}_{suffix}"
            suffix += 1
        return candidate

    @staticmethod
    def _normalize_status(value: str) -> str | None:
        status = str(value or "").strip().lower()
        if status in _CHECKLIST_STATUSES:
            return status
        return None

    @staticmethod
    def _evidence_refs(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        refs: list[str] = []
        for item in value:
            cleaned = str(item or "").strip()
            if cleaned:
                refs.append(cleaned[:200])
        return refs[:12]

    @staticmethod
    def _find_item_index(state: _LoopControlState, item_id: str) -> int:
        target = str(item_id or "").strip()
        for idx, item in enumerate(state.checklist):
            if item.item_id == target:
                return idx
        return -1

    @staticmethod
    def _checklist_lines(state: _LoopControlState) -> list[str]:
        if not state.checklist:
            return ["- (empty)"]
        lines: list[str] = []
        for item in state.checklist[:20]:
            line = f"- {item.item_id} [{item.status}] {item.text}"
            if item.rationale:
                line += f" | rationale: {item.rationale[:160]}"
            if item.evidence_refs:
                refs = ", ".join(item.evidence_refs[:3])
                line += f" | refs: {refs}"
            lines.append(line)
        if len(state.checklist) > 20:
            lines.append(f"- ... ({len(state.checklist) - 20} more item(s))")
        return lines

    def _checklist_snapshot(self, state: _LoopControlState) -> str:
        return "\n".join(self._checklist_lines(state))

    def _loop_control_prompt(self, state: _LoopControlState, notice: str | None = None) -> str:
        available = [*self._tool_registry.names(), *internal_loop_tool_names()]
        available_text = ", ".join(available) if available else "(none)"
        lines = [
            "[Loop Control Contract]",
            f"- Tools available: {available_text}.",
            "- Update checklist any time as the plan evolves with new information.",
            (
                f"- Call `{LOOP_FINISH}` when you are ready to return the final user-facing answer. "
                "If checklist is non-empty, include completion_check mapped to current checklist item IDs."
            ),
            f"- Call `{LOOP_BLOCKED}` when you cannot proceed without user input/resources.",
            "- For agentic/tool runs, plain assistant text alone does not end the loop.",
            "",
            "[Current Checklist]",
            *self._checklist_lines(state),
        ]
        trimmed_notice = str(notice or "").strip()
        if trimmed_notice:
            lines.extend(["", "[Controller Notice]", trimmed_notice])
        return "\n".join(lines)

    def _iteration_system_prompt(
        self,
        base_prompt: str,
        state: _LoopControlState,
        *,
        notice: str | None = None,
    ) -> str:
        contract = self._loop_control_prompt(state, notice=notice)
        if not str(base_prompt or "").strip():
            return contract
        return f"{base_prompt}\n\n{contract}"

    @staticmethod
    def _control_tool_definitions() -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name=LOOP_CHECKLIST_PATCH,
                description=(
                    "Patch the mutable checklist for this run. "
                    "Use operations to add/update/remove/clear checklist items as new information appears."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "operations": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "op": {
                                        "type": "string",
                                        "enum": ["add", "update", "remove", "set_status", "clear"],
                                    },
                                    "id": {"type": "string"},
                                    "text": {"type": "string"},
                                    "status": {
                                        "type": "string",
                                        "enum": sorted(_CHECKLIST_STATUSES),
                                    },
                                    "rationale": {"type": "string"},
                                    "evidence_refs": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                    },
                                },
                                "required": ["op"],
                                "additionalProperties": False,
                            },
                            "minItems": 1,
                        }
                    },
                    "required": ["operations"],
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                name=LOOP_FINISH,
                description=(
                    "Mark the run complete and provide the exact final response. "
                    "When checklist is non-empty, include completion_check for each checklist item id."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "final_response": {"type": "string"},
                        "completion_check": {
                            "type": "object",
                            "properties": {
                                "items": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "id": {"type": "string"},
                                            "outcome": {
                                                "type": "string",
                                                "enum": sorted(_FINISH_OUTCOMES),
                                            },
                                            "note": {"type": "string"},
                                        },
                                        "required": ["id", "outcome"],
                                        "additionalProperties": False,
                                    },
                                    "minItems": 1,
                                }
                            },
                            "required": ["items"],
                            "additionalProperties": False,
                        },
                    },
                    "required": ["final_response"],
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                name=LOOP_BLOCKED,
                description="Stop the run as blocked with reason and optional user follow-up ask.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "reason": {"type": "string"},
                        "ask_user": {"type": "string"},
                        "partial_response": {"type": "string"},
                    },
                    "required": ["reason"],
                    "additionalProperties": False,
                },
            ),
        ]

    def _all_tool_definitions(self) -> list[ToolDefinition]:
        return [*self._tool_registry.to_definitions(), *self._control_tool_definitions()]

    def _run_result(
        self,
        *,
        run_id: str,
        total_usage: dict[str, int],
        iterations: int,
        tool_calls: int,
        started: float,
        final_text: str,
        stopped_by_limit: bool,
        provider_error: str = "",
    ) -> LoopRunResult:
        return LoopRunResult(
            final_text=final_text,
            run_id=run_id,
            usage=total_usage,
            iterations=iterations,
            tool_calls=tool_calls,
            duration_ms=int((time.monotonic() - started) * 1000),
            provider_error=provider_error,
            stopped_by_limit=stopped_by_limit,
        )

    def _apply_checklist_patch(
        self,
        *,
        args: dict[str, Any],
        state: _LoopControlState,
    ) -> tuple[str, bool]:
        operations = args.get("operations")
        if not isinstance(operations, list) or not operations:
            return "Error: loop_checklist_patch requires a non-empty operations array", True

        changed = 0
        errors: list[str] = []
        for raw_op in operations:
            if not isinstance(raw_op, dict):
                errors.append("operation must be an object")
                continue
            op = str(raw_op.get("op") or "").strip().lower()

            if op == "clear":
                if state.checklist:
                    state.checklist.clear()
                    changed += 1
                continue

            if op == "add":
                text = str(raw_op.get("text") or "").strip()
                if not text:
                    errors.append("add requires text")
                    continue
                requested_id = str(raw_op.get("id") or "").strip()
                taken = {item.item_id for item in state.checklist}
                item_id = self._ensure_item_id(requested_id, text, taken)
                normalized = self._normalize_status(str(raw_op.get("status") or "")) or "pending"
                state.checklist.append(
                    _ChecklistItem(
                        item_id=item_id,
                        text=text,
                        status=normalized,
                        rationale=str(raw_op.get("rationale") or "").strip(),
                        evidence_refs=self._evidence_refs(raw_op.get("evidence_refs")),
                    )
                )
                changed += 1
                continue

            target_id = str(raw_op.get("id") or "").strip()
            idx = self._find_item_index(state, target_id)
            if idx < 0:
                errors.append(f"{op} missing/unknown id={target_id!r}")
                continue
            item = state.checklist[idx]

            if op == "remove":
                state.checklist.pop(idx)
                changed += 1
                continue

            if op == "set_status":
                normalized = self._normalize_status(str(raw_op.get("status") or ""))
                if not normalized:
                    errors.append(f"set_status requires valid status for id={target_id!r}")
                    continue
                item.status = normalized
                rationale = str(raw_op.get("rationale") or "").strip()
                if rationale:
                    item.rationale = rationale
                refs = self._evidence_refs(raw_op.get("evidence_refs"))
                if refs:
                    item.evidence_refs = refs
                changed += 1
                continue

            if op == "update":
                text = str(raw_op.get("text") or "").strip()
                if text:
                    item.text = text
                status_value = str(raw_op.get("status") or "").strip()
                if status_value:
                    normalized = self._normalize_status(status_value)
                    if not normalized:
                        errors.append(f"update has invalid status for id={target_id!r}")
                    else:
                        item.status = normalized
                rationale = str(raw_op.get("rationale") or "").strip()
                if rationale:
                    item.rationale = rationale
                refs = self._evidence_refs(raw_op.get("evidence_refs"))
                if refs:
                    item.evidence_refs = refs
                changed += 1
                continue

            errors.append(f"unknown operation {op!r}")

        if changed == 0 and errors:
            return f"Error: checklist patch failed ({'; '.join(errors[:6])})", True

        summary = self._checklist_snapshot(state)
        if errors:
            return (
                "Checklist updated with warnings: "
                + "; ".join(errors[:6])
                + "\n\nCurrent checklist:\n"
                + summary,
                False,
            )
        return "Checklist updated.\n\nCurrent checklist:\n" + summary, False

    def _apply_finish(
        self,
        *,
        args: dict[str, Any],
        state: _LoopControlState,
        has_non_internal_tools: bool,
    ) -> tuple[str, bool]:
        if has_non_internal_tools:
            return (
                f"Error: {LOOP_FINISH} must be called in a dedicated step without external tools",
                True,
            )
        final_response = str(args.get("final_response") or "").strip()
        if not final_response:
            return "Error: loop_finish requires final_response", True

        if state.checklist:
            completion_check = args.get("completion_check")
            if not isinstance(completion_check, dict):
                return (
                    "Error: loop_finish requires completion_check when checklist is non-empty",
                    True,
                )
            raw_items = completion_check.get("items")
            if not isinstance(raw_items, list) or not raw_items:
                return "Error: completion_check.items must be a non-empty array", True

            outcomes_by_id: dict[str, tuple[str, str]] = {}
            parse_errors: list[str] = []
            for raw_item in raw_items:
                if not isinstance(raw_item, dict):
                    parse_errors.append("completion_check item must be an object")
                    continue
                item_id = str(raw_item.get("id") or "").strip()
                outcome = str(raw_item.get("outcome") or "").strip().lower()
                note = str(raw_item.get("note") or "").strip()
                if not item_id:
                    parse_errors.append("completion_check item missing id")
                    continue
                if outcome not in _FINISH_OUTCOMES:
                    parse_errors.append(f"completion_check[{item_id}] invalid outcome={outcome!r}")
                    continue
                outcomes_by_id[item_id] = (outcome, note)

            if parse_errors:
                return f"Error: invalid completion_check ({'; '.join(parse_errors[:6])})", True

            known_ids = {item.item_id for item in state.checklist}
            unknown_ids = [item_id for item_id in outcomes_by_id if item_id not in known_ids]
            if unknown_ids:
                return (
                    "Error: completion_check contains unknown checklist id(s): "
                    + ", ".join(sorted(unknown_ids)[:8]),
                    True,
                )
            missing_ids = [item.item_id for item in state.checklist if item.item_id not in outcomes_by_id]
            if missing_ids:
                return (
                    "Error: completion_check missing checklist id(s): "
                    + ", ".join(missing_ids[:8]),
                    True,
                )

            for item in state.checklist:
                outcome, note = outcomes_by_id[item.item_id]
                item.status = outcome
                if note:
                    item.rationale = note

        unresolved = [item.item_id for item in state.checklist if item.status in {"pending", "in_progress"}]
        if unresolved:
            return "Error: unresolved checklist items remain: " + ", ".join(unresolved[:8]), True

        state.finished = True
        state.finish_message = final_response
        return "Run marked finished.", False

    def _apply_blocked(
        self,
        *,
        args: dict[str, Any],
        state: _LoopControlState,
        has_non_internal_tools: bool,
    ) -> tuple[str, bool]:
        if has_non_internal_tools:
            return (
                f"Error: {LOOP_BLOCKED} must be called in a dedicated step without external tools",
                True,
            )
        reason = str(args.get("reason") or "").strip()
        if not reason:
            return "Error: loop_blocked requires reason", True
        ask_user = str(args.get("ask_user") or "").strip()
        partial = str(args.get("partial_response") or "").strip()
        lines: list[str] = []
        if partial:
            lines.append(partial)
        lines.append(f"Blocked: {reason}")
        if ask_user:
            lines.append(f"Need from you: {ask_user}")
        state.blocked = True
        state.blocked_message = "\n\n".join(lines)
        return "Run marked blocked.", False

    def _dispatch_internal_tool(
        self,
        *,
        tool_name: str,
        args: dict[str, Any],
        state: _LoopControlState,
        has_non_internal_tools: bool,
    ) -> tuple[str, bool]:
        if tool_name == LOOP_CHECKLIST_PATCH:
            return self._apply_checklist_patch(args=args, state=state)
        if tool_name == LOOP_FINISH:
            return self._apply_finish(
                args=args,
                state=state,
                has_non_internal_tools=has_non_internal_tools,
            )
        if tool_name == LOOP_BLOCKED:
            return self._apply_blocked(
                args=args,
                state=state,
                has_non_internal_tools=has_non_internal_tools,
            )
        return f"Error: unknown internal loop tool '{tool_name}'", True

    def _append_trace(self, filename: str, payload: dict[str, Any]) -> None:
        if not self._trace_enabled:
            return
        try:
            self._trace_dir.mkdir(parents=True, exist_ok=True)
            target = self._trace_dir / filename
            with target.open("a", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except Exception:
            logger.debug("Failed to append trace", exc_info=True)

    @staticmethod
    def _add_usage_delta(
        *,
        total_usage: dict[str, int],
        iter_last_usage: dict[str, int],
        current_usage: dict[str, int],
    ) -> None:
        current_in = int(current_usage.get("input_tokens") or 0)
        current_out = int(current_usage.get("output_tokens") or 0)
        last_in = int(iter_last_usage.get("input_tokens") or 0)
        last_out = int(iter_last_usage.get("output_tokens") or 0)
        delta_in = max(0, current_in - last_in)
        delta_out = max(0, current_out - last_out)
        total_usage["input_tokens"] = int(total_usage.get("input_tokens", 0) + delta_in)
        total_usage["output_tokens"] = int(total_usage.get("output_tokens", 0) + delta_out)
        total_usage["total_tokens"] = int(total_usage["input_tokens"] + total_usage["output_tokens"])
        iter_last_usage["input_tokens"] = max(last_in, current_in)
        iter_last_usage["output_tokens"] = max(last_out, current_out)

    async def run_turn(
        self,
        *,
        messages: list[Message],
        system_prompt: str,
        status_callback: StatusCallback | None = None,
    ) -> LoopRunResult:
        run_id = uuid.uuid4().hex
        total_usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        total_tool_calls = 0
        last_tool_error = ""
        max_iterations = int(self._settings.agent_max_iterations)
        max_tool_calls = int(self._settings.agent_max_tool_calls_per_run)
        run_timeout = float(self._settings.agent_run_timeout_seconds)
        per_tool_timeout = float(self._settings.agent_tool_timeout_seconds)
        started = time.monotonic()
        final_text = ""
        all_tool_definitions = self._all_tool_definitions()
        loop_state = _LoopControlState()
        external_tool_calls = 0
        controller_notice = ""

        await self._emit_status(status_callback, "Thinking...")

        for iteration in range(max_iterations):
            if (time.monotonic() - started) > run_timeout:
                break
            await self._emit_status(status_callback, f"Thinking... (step {iteration + 1})")

            assistant_text_parts: list[str] = []
            tool_calls = []
            iter_last_usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0}
            provider_messages = messages
            if (
                controller_notice
                and self._provider.requires_user_followup_turn
                and messages
                and messages[-1].role == MessageRole.ASSISTANT
            ):
                provider_messages = [
                    *messages,
                    Message(
                        role=MessageRole.USER,
                        content=(
                            "Controller: Continue the current run and follow the loop contract "
                            "in the system prompt. This is not a new user request."
                        ),
                    ),
                ]
            try:
                async for delta in self._provider.chat_stream(
                    messages=provider_messages,
                    system=self._iteration_system_prompt(
                        system_prompt,
                        loop_state,
                        notice=controller_notice,
                    ),
                    tools=all_tool_definitions,
                ):
                    if delta.usage:
                        self._add_usage_delta(
                            total_usage=total_usage,
                            iter_last_usage=iter_last_usage,
                            current_usage=delta.usage,
                        )
                    if delta.content:
                        assistant_text_parts.append(delta.content)
                    if delta.tool_call:
                        tool_calls.append(delta.tool_call)
            except Exception as exc:
                logger.exception("Provider streaming failed during agent loop")
                await self._emit_status(status_callback, "Provider error")
                self._append_trace(
                    "runs.jsonl",
                    {
                        "ts": self._utc_now(),
                        "run_id": run_id,
                        "provider": self._provider.name,
                        "model": self._provider.model,
                        "status": "error",
                        "error": str(exc),
                        "iterations": int(iteration + 1),
                        "tool_calls": int(total_tool_calls),
                        "duration_ms": int((time.monotonic() - started) * 1000),
                        "usage": dict(total_usage),
                    },
                )
                return self._run_result(
                    run_id=run_id,
                    total_usage=total_usage,
                    iterations=iteration + 1,
                    tool_calls=total_tool_calls,
                    started=started,
                    final_text=f"Provider error: {exc}",
                    provider_error=str(exc),
                    stopped_by_limit=False,
                )

            assistant_text = "".join(assistant_text_parts).strip()
            messages.append(
                Message(
                    role=MessageRole.ASSISTANT,
                    content=assistant_text if assistant_text else None,
                    tool_calls=tool_calls,
                )
            )

            if not tool_calls:
                if loop_state.finished:
                    final_text = loop_state.finish_message or assistant_text
                    await self._emit_status(status_callback, "Finalizing response...")
                    self._append_trace(
                        "runs.jsonl",
                        {
                            "ts": self._utc_now(),
                            "run_id": run_id,
                            "provider": self._provider.name,
                            "model": self._provider.model,
                            "status": "complete",
                            "stop_reason": "loop_finish",
                            "iterations": int(iteration + 1),
                            "tool_calls": int(total_tool_calls),
                            "duration_ms": int((time.monotonic() - started) * 1000),
                            "usage": dict(total_usage),
                        },
                    )
                    return self._run_result(
                        run_id=run_id,
                        total_usage=total_usage,
                        iterations=iteration + 1,
                        tool_calls=total_tool_calls,
                        started=started,
                        final_text=final_text,
                        stopped_by_limit=False,
                    )

                if loop_state.blocked:
                    final_text = loop_state.blocked_message or assistant_text or "Blocked: unable to continue."
                    await self._emit_status(status_callback, "Run blocked")
                    self._append_trace(
                        "runs.jsonl",
                        {
                            "ts": self._utc_now(),
                            "run_id": run_id,
                            "provider": self._provider.name,
                            "model": self._provider.model,
                            "status": "blocked",
                            "stop_reason": "loop_blocked",
                            "iterations": int(iteration + 1),
                            "tool_calls": int(total_tool_calls),
                            "duration_ms": int((time.monotonic() - started) * 1000),
                            "usage": dict(total_usage),
                        },
                    )
                    return self._run_result(
                        run_id=run_id,
                        total_usage=total_usage,
                        iterations=iteration + 1,
                        tool_calls=total_tool_calls,
                        started=started,
                        final_text=final_text,
                        stopped_by_limit=False,
                    )

                # Backward compatibility: allow direct answers when no tool loop happened.
                if total_tool_calls == 0 and not loop_state.checklist:
                    final_text = assistant_text
                    await self._emit_status(status_callback, "Finalizing response...")
                    self._append_trace(
                        "runs.jsonl",
                        {
                            "ts": self._utc_now(),
                            "run_id": run_id,
                            "provider": self._provider.name,
                            "model": self._provider.model,
                            "status": "complete",
                            "stop_reason": "plain_text_no_tools",
                            "iterations": int(iteration + 1),
                            "tool_calls": int(total_tool_calls),
                            "duration_ms": int((time.monotonic() - started) * 1000),
                            "usage": dict(total_usage),
                        },
                    )
                    return self._run_result(
                        run_id=run_id,
                        total_usage=total_usage,
                        iterations=iteration + 1,
                        tool_calls=total_tool_calls,
                        started=started,
                        final_text=final_text,
                        stopped_by_limit=False,
                    )

                reminder = (
                    "Error: missing explicit run-stop signal. "
                    f"Call `{LOOP_FINISH}` with `final_response` "
                    "(and completion_check when checklist is non-empty), "
                    f"or call `{LOOP_BLOCKED}` with reason/ask_user."
                )
                controller_notice = reminder
                await self._emit_status(status_callback, "Awaiting explicit run stop signal...")
                continue

            await self._emit_status(
                status_callback,
                "Using tools: " + ", ".join(tc.name for tc in tool_calls),
            )
            controller_notice = ""
            tool_results: list[ToolResult] = []
            has_non_internal_tools = any(
                not self._is_internal_tool_name(tc.name) for tc in tool_calls
            )
            for tool_call in tool_calls:
                total_tool_calls += 1
                is_internal = self._is_internal_tool_name(tool_call.name)
                if not is_internal:
                    external_tool_calls += 1
                    if external_tool_calls > max_tool_calls:
                        error_text = f"Error: tool call limit reached ({max_tool_calls})"
                        last_tool_error = error_text
                        tool_results.append(
                            ToolResult(
                                tool_call_id=tool_call.id,
                                content=error_text,
                                is_error=True,
                            )
                        )
                        continue
                    if (time.monotonic() - started) > run_timeout:
                        error_text = f"Error: run timeout reached ({run_timeout:.1f}s)"
                        last_tool_error = error_text
                        tool_results.append(
                            ToolResult(
                                tool_call_id=tool_call.id,
                                content=error_text,
                                is_error=True,
                            )
                        )
                        continue

                tool_label = "control tool" if is_internal else "tool"
                await self._emit_status(status_callback, f"Running {tool_label}: {tool_call.name}")
                tool_started = time.monotonic()
                if is_internal:
                    raw, is_error = self._dispatch_internal_tool(
                        tool_name=tool_call.name,
                        args=dict(tool_call.arguments or {}),
                        state=loop_state,
                        has_non_internal_tools=has_non_internal_tools,
                    )
                else:
                    try:
                        raw = await asyncio.wait_for(
                            self._tool_registry.dispatch(tool_call.name, tool_call.arguments),
                            timeout=per_tool_timeout,
                        )
                    except TimeoutError:
                        raw = f"Error: tool '{tool_call.name}' timed out after {per_tool_timeout:.1f}s"
                    except Exception as exc:
                        raw = f"Error: tool '{tool_call.name}' failed: {exc}"
                    is_error = self._is_error_result(raw)

                if is_error:
                    last_tool_error = raw
                    await self._emit_status(status_callback, f"Tool failed: {tool_call.name}")
                else:
                    await self._emit_status(status_callback, f"Tool completed: {tool_call.name}")
                self._append_trace(
                    "tools.jsonl",
                    {
                        "ts": self._utc_now(),
                        "run_id": run_id,
                        "iteration": int(iteration + 1),
                        "tool_call_id": str(tool_call.id),
                        "tool_name": str(tool_call.name),
                        "args": dict(tool_call.arguments or {}),
                        "is_internal": bool(is_internal),
                        "is_error": bool(is_error),
                        "duration_ms": int((time.monotonic() - tool_started) * 1000),
                        "result_preview": str(raw)[:500],
                    },
                )
                tool_results.append(
                    ToolResult(
                        tool_call_id=tool_call.id,
                        content=str(raw),
                        is_error=bool(is_error),
                    )
                )

            messages.append(Message(role=MessageRole.TOOL, tool_results=tool_results))
            if loop_state.finished:
                final_text = loop_state.finish_message or assistant_text
                await self._emit_status(status_callback, "Finalizing response...")
                self._append_trace(
                    "runs.jsonl",
                    {
                        "ts": self._utc_now(),
                        "run_id": run_id,
                        "provider": self._provider.name,
                        "model": self._provider.model,
                        "status": "complete",
                        "stop_reason": "loop_finish",
                        "iterations": int(iteration + 1),
                        "tool_calls": int(total_tool_calls),
                        "duration_ms": int((time.monotonic() - started) * 1000),
                        "usage": dict(total_usage),
                    },
                )
                return self._run_result(
                    run_id=run_id,
                    total_usage=total_usage,
                    iterations=iteration + 1,
                    tool_calls=total_tool_calls,
                    started=started,
                    final_text=final_text,
                    stopped_by_limit=False,
                )

            if loop_state.blocked:
                final_text = loop_state.blocked_message or "Blocked: unable to continue."
                await self._emit_status(status_callback, "Run blocked")
                self._append_trace(
                    "runs.jsonl",
                    {
                        "ts": self._utc_now(),
                        "run_id": run_id,
                        "provider": self._provider.name,
                        "model": self._provider.model,
                        "status": "blocked",
                        "stop_reason": "loop_blocked",
                        "iterations": int(iteration + 1),
                        "tool_calls": int(total_tool_calls),
                        "duration_ms": int((time.monotonic() - started) * 1000),
                        "usage": dict(total_usage),
                    },
                )
                return self._run_result(
                    run_id=run_id,
                    total_usage=total_usage,
                    iterations=iteration + 1,
                    tool_calls=total_tool_calls,
                    started=started,
                    final_text=final_text,
                    stopped_by_limit=False,
                )

        hint = ""
        if last_tool_error:
            trimmed = " ".join(last_tool_error.split())
            if len(trimmed) > 220:
                trimmed = trimmed[:220] + "..."
            hint = f" Last tool error: {trimmed}"

        await self._emit_status(status_callback, "Reached loop limit")
        self._append_trace(
            "runs.jsonl",
            {
                "ts": self._utc_now(),
                "run_id": run_id,
                "provider": self._provider.name,
                "model": self._provider.model,
                "status": "limit_stop",
                "iterations": int(max_iterations),
                "tool_calls": int(total_tool_calls),
                "duration_ms": int((time.monotonic() - started) * 1000),
                "usage": dict(total_usage),
                "last_tool_error": last_tool_error,
                "checklist": [
                    {
                        "id": item.item_id,
                        "text": item.text,
                        "status": item.status,
                    }
                    for item in loop_state.checklist
                ],
            },
        )

        return self._run_result(
            run_id=run_id,
            total_usage=total_usage,
            iterations=max_iterations,
            tool_calls=total_tool_calls,
            started=started,
            final_text=(
                f"I reached the loop limit ({max_iterations} iterations) before completing the request.{hint}"
            ),
            stopped_by_limit=True,
        )
