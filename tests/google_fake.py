"""In-memory stand-in for the Google Calendar events API used by sync tests."""

import copy
import itertools
import uuid
from datetime import UTC, datetime
from typing import Any

from planner.google_client import GoogleApiError, GoogleEventMissing, GoogleSyncTokenExpired

# Fields Google lets clients patch on restricted event types.
RESTRICTED_FIELDS = {
    "birthday": {"summary", "reminders", "colorId"},
    "fromGmail": {"reminders", "colorId", "visibility", "transparency", "extendedProperties"},
}


class FakeGoogleCalendar:
    def __init__(self):
        self.items: dict[str, dict[str, Any]] = {}
        self._changed: dict[str, int] = {}
        self._clock = itertools.count(1)
        self.version = 0
        self.calls: list[tuple[str, str]] = []
        self.expire_tokens = False
        self.bodies: list[tuple[str, dict[str, Any]]] = []
        self.reject_updates: set[str] = set()

    # -- helpers to simulate edits made directly in Google ----------------------------

    def _touch(self, item: dict[str, Any], updated: datetime | None = None) -> dict[str, Any]:
        self.version = next(self._clock)
        item["etag"] = f'"{self.version}"'
        item["updated"] = (updated or datetime.now(UTC)).isoformat().replace("+00:00", "Z")
        self.items[item["id"]] = item
        self._changed[item["id"]] = self.version
        return copy.deepcopy(item)

    def g_create(self, **fields) -> dict[str, Any]:
        item = {"id": uuid.uuid4().hex, "status": "confirmed", **fields}
        return self._touch(item)

    def g_update(self, event_id: str, updated: datetime | None = None, **fields):
        item = {**self.items[event_id], **fields}
        return self._touch(item, updated)

    def g_cancel(self, event_id: str):
        return self.g_update(event_id, status="cancelled")

    def g_instance(self, master_id: str, original: dict[str, str], **fields):
        suffix = original.get("dateTime", original.get("date", ""))
        instance = {
            "id": f"{master_id}_{suffix}",
            "status": "confirmed",
            "recurringEventId": master_id,
            "originalStartTime": original,
            **fields,
        }
        return self._touch(instance)

    def masters(self) -> list[dict[str, Any]]:
        return [
            item
            for item in self.items.values()
            if not item.get("recurringEventId") and item.get("status") != "cancelled"
        ]

    # -- GoogleClient surface ---------------------------------------------------------

    async def list_events(
        self,
        _access_token: str,
        _calendar_id: str,
        *,
        sync_token: str | None = None,
        time_min: str | None = None,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        self.calls.append(("list", sync_token or "full"))
        if sync_token and self.expire_tokens:
            self.expire_tokens = False
            raise GoogleSyncTokenExpired(410, "expired")
        since = int(sync_token) if sync_token else 0
        items = [
            copy.deepcopy(item)
            for event_id, item in self.items.items()
            if self._changed[event_id] > since
        ]
        return {"items": items, "nextSyncToken": str(self.version), "timeZone": "Europe/Moscow"}

    async def insert_event(self, _access_token, _calendar_id, body):
        self.calls.append(("insert", body.get("summary", "")))
        item = {"id": uuid.uuid4().hex, "status": "confirmed", **copy.deepcopy(body)}
        return self._touch(item)

    async def update_event(self, _access_token, _calendar_id, event_id, body):
        self.calls.append(("update", event_id))
        self.bodies.append((event_id, copy.deepcopy(body)))
        if event_id in self.reject_updates:
            raise GoogleApiError(400, "rejected by test")
        allowed = RESTRICTED_FIELDS.get(self.items.get(event_id, {}).get("eventType", ""))
        if allowed is not None and set(body) - allowed:
            raise GoogleApiError(400, f"cannot change {sorted(set(body) - allowed)}")
        if event_id in self.items:
            if self.items[event_id].get("status") == "cancelled" and not body.get(
                "recurringEventId"
            ):
                raise GoogleEventMissing(410, event_id)
            item = {**self.items[event_id], **copy.deepcopy(body)}
        elif "_" in event_id and event_id.split("_", 1)[0] in self.items:
            item = {"id": event_id, **copy.deepcopy(body)}
        else:
            raise GoogleEventMissing(404, event_id)
        if not body.get("recurringEventId"):
            item.pop("status", None)
            item["status"] = "confirmed"
        return self._touch(item)

    async def delete_event(self, _access_token, _calendar_id, event_id):
        self.calls.append(("delete", event_id))
        if event_id in self.items:
            self._touch({**self.items[event_id], "status": "cancelled"})
        elif "_" in event_id and event_id.split("_", 1)[0] in self.items:
            master_id, suffix = event_id.split("_", 1)
            original = (
                {"dateTime": datetime.strptime(suffix, "%Y%m%dT%H%M%SZ").isoformat() + "Z"}
                if "T" in suffix
                else {"date": datetime.strptime(suffix, "%Y%m%d").date().isoformat()}
            )
            self._touch(
                {
                    "id": event_id,
                    "status": "cancelled",
                    "recurringEventId": master_id,
                    "originalStartTime": original,
                }
            )

    def writes(self) -> list[tuple[str, str]]:
        return [call for call in self.calls if call[0] != "list"]
