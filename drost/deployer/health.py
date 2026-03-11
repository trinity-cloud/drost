from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


_MAX_JSON_BODY_BYTES = 128 * 1024


@dataclass(slots=True)
class HealthCheckResult:
    ok: bool
    checked_at: str
    duration_ms: int
    status_code: int | None
    body_excerpt: str
    error: str

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(slots=True)
class CanaryCheckResult:
    ok: bool
    checked_at: str
    duration_ms: int
    phase: str
    label: str
    body_excerpt: str
    error: str
    steps: list[dict[str, object]]

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def _probe_json_request(
    url: str,
    *,
    timeout_seconds: float,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> tuple[HealthCheckResult, dict[str, Any] | None]:
    started = time.monotonic()
    body: bytes | None = None
    headers: dict[str, str] = {}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url=url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=max(0.1, timeout_seconds)) as response:
            raw_body = response.read(_MAX_JSON_BODY_BYTES)
            body_text = raw_body.decode("utf-8", errors="replace").strip()
            status_code = int(getattr(response, "status", 200))
    except urllib.error.HTTPError as exc:
        body_text = exc.read(_MAX_JSON_BODY_BYTES).decode("utf-8", errors="replace").strip()
        try:
            payload_obj = json.loads(body_text) if body_text else None
        except json.JSONDecodeError:
            payload_obj = None
        return (
            HealthCheckResult(
                ok=False,
                checked_at=_utc_now(),
                duration_ms=int((time.monotonic() - started) * 1000),
                status_code=int(exc.code),
                body_excerpt=body_text[:300],
                error=f"HTTP {int(exc.code)}",
            ),
            payload_obj if isinstance(payload_obj, dict) else None,
        )
    except urllib.error.URLError as exc:
        return (
            HealthCheckResult(
                ok=False,
                checked_at=_utc_now(),
                duration_ms=int((time.monotonic() - started) * 1000),
                status_code=None,
                body_excerpt="",
                error=str(exc.reason or exc),
            ),
            None,
        )
    except Exception as exc:
        return (
            HealthCheckResult(
                ok=False,
                checked_at=_utc_now(),
                duration_ms=int((time.monotonic() - started) * 1000),
                status_code=None,
                body_excerpt="",
                error=str(exc),
            ),
            None,
        )

    try:
        payload_obj = json.loads(body_text) if body_text else None
    except json.JSONDecodeError:
        payload_obj = None
    ok = 200 <= status_code < 300 and isinstance(payload_obj, dict)
    return (
        HealthCheckResult(
            ok=ok,
            checked_at=_utc_now(),
            duration_ms=int((time.monotonic() - started) * 1000),
            status_code=status_code,
            body_excerpt=body_text[:300],
            error="" if ok else "response was not a valid JSON object",
        ),
        payload_obj if isinstance(payload_obj, dict) else None,
    )


def probe_health(url: str, *, timeout_seconds: float) -> HealthCheckResult:
    started = time.monotonic()
    request = urllib.request.Request(url=url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=max(0.1, timeout_seconds)) as response:
            raw_body = response.read(2048)
            body_text = raw_body.decode("utf-8", errors="replace").strip()
            status_code = int(getattr(response, "status", 200))
    except urllib.error.HTTPError as exc:
        body_text = exc.read(2048).decode("utf-8", errors="replace").strip()
        return HealthCheckResult(
            ok=False,
            checked_at=_utc_now(),
            duration_ms=int((time.monotonic() - started) * 1000),
            status_code=int(exc.code),
            body_excerpt=body_text[:300],
            error=f"HTTP {int(exc.code)}",
        )
    except urllib.error.URLError as exc:
        return HealthCheckResult(
            ok=False,
            checked_at=_utc_now(),
            duration_ms=int((time.monotonic() - started) * 1000),
            status_code=None,
            body_excerpt="",
            error=str(exc.reason or exc),
        )
    except Exception as exc:
        return HealthCheckResult(
            ok=False,
            checked_at=_utc_now(),
            duration_ms=int((time.monotonic() - started) * 1000),
            status_code=None,
            body_excerpt="",
            error=str(exc),
        )

    ok = 200 <= status_code < 300
    if ok and body_text:
        try:
            payload = json.loads(body_text)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict) and "status" in payload:
            ok = str(payload.get("status") or "").strip().lower() == "ok"
    return HealthCheckResult(
        ok=ok,
        checked_at=_utc_now(),
        duration_ms=int((time.monotonic() - started) * 1000),
        status_code=status_code,
        body_excerpt=body_text[:300],
        error="" if ok else "health payload did not validate",
    )


def wait_for_health(
    url: str,
    *,
    startup_grace_seconds: float,
    timeout_seconds: float,
    poll_interval_seconds: float = 0.25,
) -> HealthCheckResult:
    if startup_grace_seconds > 0:
        time.sleep(startup_grace_seconds)

    deadline = time.monotonic() + max(0.1, timeout_seconds)
    last_result = HealthCheckResult(
        ok=False,
        checked_at=_utc_now(),
        duration_ms=0,
        status_code=None,
        body_excerpt="",
        error="health check did not run",
    )
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        last_result = probe_health(url, timeout_seconds=min(max(0.1, remaining), timeout_seconds))
        if last_result.ok:
            return last_result
        if time.monotonic() >= deadline:
            break
        time.sleep(max(0.05, min(poll_interval_seconds, deadline - time.monotonic())))
    return last_result


def run_gateway_canary_suite(health_url: str, *, timeout_seconds: float) -> CanaryCheckResult:
    base_url = str(health_url or "").strip()
    if base_url.endswith("/health"):
        base_url = base_url[: -len("/health")]
    base_url = base_url.rstrip("/")
    started = time.monotonic()
    steps: list[dict[str, object]] = []

    checks: list[tuple[str, str, str]] = [
        ("runtime_surface", "GET", f"{base_url}/v1/loops/status"),
        ("runtime_surface", "GET", f"{base_url}/v1/mind/status"),
        ("runtime_surface", "GET", f"{base_url}/v1/cognition/status"),
        ("provider_and_tool", "POST", f"{base_url}/v1/canary/deploy"),
    ]

    for phase, method, url in checks:
        result, payload = _probe_json_request(url, timeout_seconds=timeout_seconds, method=method)
        step = {
            "phase": phase,
            "method": method,
            "url": url,
            "ok": result.ok,
            "status_code": result.status_code,
            "duration_ms": result.duration_ms,
            "error": result.error,
        }
        if isinstance(payload, dict) and "label" in payload:
            step["label"] = str(payload.get("label") or "")
        steps.append(step)
        if not result.ok:
            label = "runtime_surface_failed" if phase == "runtime_surface" else "tool_canary_failed"
            if isinstance(payload, dict):
                raw_label = str(payload.get("label") or "").strip()
                if raw_label:
                    label = raw_label
            return CanaryCheckResult(
                ok=False,
                checked_at=_utc_now(),
                duration_ms=int((time.monotonic() - started) * 1000),
                phase=phase,
                label=label,
                body_excerpt=result.body_excerpt,
                error=label or result.error,
                steps=steps,
            )

    return CanaryCheckResult(
        ok=True,
        checked_at=_utc_now(),
        duration_ms=int((time.monotonic() - started) * 1000),
        phase="provider_and_tool",
        label="ok",
        body_excerpt="",
        error="",
        steps=steps,
    )
