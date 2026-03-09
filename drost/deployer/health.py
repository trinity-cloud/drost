from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import UTC, datetime


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


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
