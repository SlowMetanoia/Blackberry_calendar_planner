from planner.main import app


def test_async_message_endpoints_exist() -> None:
    routes = {(route.path, tuple(route.methods or ())) for route in app.routes}
    assert ("/agent/messages", ("POST",)) in routes
    assert ("/agent/messages/audio", ("POST",)) in routes
    assert ("/agent/messages/{message_id}", ("GET",)) in routes


def test_crud_endpoints_exist() -> None:
    paths = {route.path for route in app.routes}
    assert {"/tasks", "/tasks/{task_id}", "/events", "/events/{event_id}"} <= paths


def test_calendar_history_endpoints_replace_plans() -> None:
    routes = {(route.path, method) for route in app.routes for method in (route.methods or ())}
    assert {
        ("/calendar/history", "GET"),
        ("/calendar/history/{operation_id}/undo", "POST"),
    } <= routes
    assert not any(path.startswith("/agent/plans") for path, _method in routes)


def test_timezone_endpoint_exists() -> None:
    routes = {(route.path, method) for route in app.routes for method in (route.methods or ())}
    assert ("/users/me/timezone", "PUT") in routes


def test_conversation_list_endpoint_exists() -> None:
    routes = {(route.path, method) for route in app.routes for method in (route.methods or ())}
    assert ("/agent/conversations", "GET") in routes
