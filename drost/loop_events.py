from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict, deque
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any


@dataclass(slots=True, frozen=True)
class LoopEvent:
    event_id: str
    type: str
    timestamp: str
    scope: dict[str, Any]
    payload: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "type": self.type,
            "timestamp": self.timestamp,
            "scope": dict(self.scope),
            "payload": dict(self.payload),
        }


@dataclass(slots=True)
class EventSubscription:
    name: str
    queue: asyncio.Queue[LoopEvent]
    event_types: frozenset[str]
    delivered_count: int = 0
    dropped_count: int = 0
    active: bool = True

    def matches(self, event_type: str) -> bool:
        return not self.event_types or event_type in self.event_types

    async def get(self) -> LoopEvent:
        return await self.queue.get()

    def close(self) -> None:
        self.active = False

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "event_types": sorted(self.event_types),
            "queue_size": self.queue.qsize(),
            "delivered_count": int(self.delivered_count),
            "dropped_count": int(self.dropped_count),
            "active": bool(self.active),
        }


class LoopEventBus:
    def __init__(self, *, recent_limit: int = 50, default_queue_size: int = 64) -> None:
        self._recent: deque[LoopEvent] = deque(maxlen=max(1, int(recent_limit)))
        self._default_queue_size = max(1, int(default_queue_size))
        self._subscriptions: dict[str, EventSubscription] = {}
        self._event_counts: dict[str, int] = defaultdict(int)
        self._total_emitted = 0

    def subscribe(
        self,
        *,
        name: str,
        event_types: set[str] | list[str] | tuple[str, ...] | None = None,
        max_queue_size: int | None = None,
    ) -> EventSubscription:
        cleaned_name = str(name or "").strip()
        if not cleaned_name:
            raise ValueError("subscription name is required")
        if cleaned_name in self._subscriptions:
            raise ValueError(f"subscription '{cleaned_name}' already exists")
        queue_size = self._default_queue_size if max_queue_size is None else max(1, int(max_queue_size))
        cleaned_types = frozenset(
            str(item).strip()
            for item in (event_types or [])
            if str(item).strip()
        )
        subscription = EventSubscription(
            name=cleaned_name,
            queue=asyncio.Queue(maxsize=queue_size),
            event_types=cleaned_types,
        )
        self._subscriptions[cleaned_name] = subscription
        return subscription

    def unsubscribe(self, name: str) -> None:
        subscription = self._subscriptions.pop(str(name or "").strip(), None)
        if subscription is not None:
            subscription.close()

    def emit(
        self,
        event_type: str,
        *,
        scope: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> LoopEvent:
        cleaned_type = str(event_type or "").strip()
        if not cleaned_type:
            raise ValueError("event_type is required")

        event = LoopEvent(
            event_id=f"evt_{uuid.uuid4().hex[:12]}",
            type=cleaned_type,
            timestamp=datetime.now(UTC).isoformat(),
            scope=dict(scope or {}),
            payload=dict(payload or {}),
        )
        self._recent.append(event)
        self._event_counts[cleaned_type] += 1
        self._total_emitted += 1

        for subscription in list(self._subscriptions.values()):
            if not subscription.active or not subscription.matches(cleaned_type):
                continue
            self._deliver(subscription, event)

        return event

    def status(self) -> dict[str, Any]:
        return {
            "total_emitted": int(self._total_emitted),
            "event_counts": dict(sorted(self._event_counts.items())),
            "subscriber_count": len(self._subscriptions),
            "subscriptions": {
                name: subscription.status()
                for name, subscription in sorted(self._subscriptions.items())
            },
            "recent_events": [event.as_dict() for event in self._recent],
        }

    @staticmethod
    def _deliver(subscription: EventSubscription, event: LoopEvent) -> None:
        try:
            subscription.queue.put_nowait(event)
        except asyncio.QueueFull:
            with suppress(asyncio.QueueEmpty):
                subscription.queue.get_nowait()
            try:
                subscription.queue.put_nowait(event)
            except asyncio.QueueFull:
                subscription.dropped_count += 1
                return
            subscription.dropped_count += 1
        subscription.delivered_count += 1
