from __future__ import annotations


class NSClient:
    """Minimal NS client placeholder used by the visualization app."""

    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = api_key

    def get_stations(self) -> list[dict]:
        return []
