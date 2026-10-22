from typing import Any, Literal

from pydantic import BaseModel, Field


class CollisionPair(BaseModel):
    first: dict[str, Any]
    second: dict[str, Any]
    kind: Literal["interval", "point"]


class CollisionGroup(BaseModel):
    id: str
    occurrences: list[CollisionPair]


class CollisionReport(BaseModel):
    checked_from: str | None = None
    checked_to: str | None = None
    groups: list[CollisionGroup] = Field(default_factory=list)


class CollisionNotice(BaseModel):
    collision_id: str
    text: str = Field(min_length=1, max_length=1000)
