import httpx

from planner.config import Settings
from planner.google_client import GoogleClient


async def test_event_updates_are_partial():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return httpx.Response(200, json={"id": "abc", "etag": '"2"'})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    async with http, GoogleClient(Settings(llm_required=False), http) as client:
        await client.update_event("token", "primary", "abc", {"summary": "Новое"})

    # PUT would replace the whole event and drop attendees, Meet links and colors.
    assert seen == [("PATCH", "/calendar/v3/calendars/primary/events/abc")]
