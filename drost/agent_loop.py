from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from drost.config import Settings
from drost.loop_runner import LoopRunResult, StatusCallback
from drost.providers import BaseProvider, Message, MessageRole, ToolResult
from drost.tools import ToolRegistry

logger = logging.getLogger(__name__)


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
        return datetime.now(timezone.utc).isoformat()

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

        await self._emit_status(status_callback, "Thinking...")

        for iteration in range(max_iterations):
            if (time.monotonic() - started) > run_timeout:
                break
            await self._emit_status(status_callback, f"Thinking... (step {iteration + 1})")

            assistant_text_parts: list[str] = []
            tool_calls = []
            iter_last_usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0}
            try:
                async for delta in self._provider.chat_stream(
                    messages=messages,
                    system=system_prompt,
                    tools=self._tool_registry.to_definitions(),
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
                duration_ms = int((time.monotonic() - started) * 1000)
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
                        "duration_ms": duration_ms,
                        "usage": dict(total_usage),
                    },
                )
                return LoopRunResult(
                    final_text=f"Provider error: {exc}",
                    run_id=run_id,
                    usage=total_usage,
                    iterations=iteration + 1,
                    tool_calls=total_tool_calls,
                    duration_ms=duration_ms,
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
                final_text = assistant_text
                await self._emit_status(status_callback, "Finalizing response...")
                duration_ms = int((time.monotonic() - started) * 1000)
                self._append_trace(
                    "runs.jsonl",
                    {
                        "ts": self._utc_now(),
                        "run_id": run_id,
                        "provider": self._provider.name,
                        "model": self._provider.model,
                        "status": "complete",
                        "iterations": int(iteration + 1),
                        "tool_calls": int(total_tool_calls),
                        "duration_ms": duration_ms,
                        "usage": dict(total_usage),
                    },
                )
                return LoopRunResult(
                    final_text=final_text,
                    run_id=run_id,
                    usage=total_usage,
                    iterations=iteration + 1,
                    tool_calls=total_tool_calls,
                    duration_ms=duration_ms,
                    stopped_by_limit=False,
                )

            await self._emit_status(
                status_callback,
                "Using tools: " + ", ".join(tc.name for tc in tool_calls),
            )
            tool_results: list[ToolResult] = []
            for tool_call in tool_calls:
                total_tool_calls += 1
                if total_tool_calls > max_tool_calls:
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

                await self._emit_status(status_callback, f"Running tool: {tool_call.name}")
                tool_started = time.monotonic()
                try:
                    raw = await asyncio.wait_for(
                        self._tool_registry.dispatch(tool_call.name, tool_call.arguments),
                        timeout=per_tool_timeout,
                    )
                except TimeoutError:
                    raw = f"Error: tool '{tool_call.name}' timed out after {per_tool_timeout:.1f}s"
                except Exception as exc:
                    raw = f"Error: tool '{tool_call.name}' failed: {exc}"

                if self._is_error_result(raw):
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
                        "is_error": bool(self._is_error_result(raw)),
                        "duration_ms": int((time.monotonic() - tool_started) * 1000),
                        "result_preview": str(raw)[:500],
                    },
                )
                tool_results.append(
                    ToolResult(
                        tool_call_id=tool_call.id,
                        content=str(raw),
                        is_error=self._is_error_result(raw),
                    )
                )

            messages.append(Message(role=MessageRole.TOOL, tool_results=tool_results))

        hint = ""
        if last_tool_error:
            trimmed = " ".join(last_tool_error.split())
            if len(trimmed) > 220:
                trimmed = trimmed[:220] + "..."
            hint = f" Last tool error: {trimmed}"

        await self._emit_status(status_callback, "Reached loop limit")
        duration_ms = int((time.monotonic() - started) * 1000)
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
                "duration_ms": duration_ms,
                "usage": dict(total_usage),
                "last_tool_error": last_tool_error,
            },
        )

        return LoopRunResult(
            final_text=(
                f"I reached the loop limit ({max_iterations} iterations) before completing the request.{hint}"
            ),
            run_id=run_id,
            usage=total_usage,
            iterations=max_iterations,
            tool_calls=total_tool_calls,
            duration_ms=duration_ms,
            stopped_by_limit=True,
        )
