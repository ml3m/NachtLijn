from __future__ import annotations


class NSApiError(Exception):
    pass


class NSApi:
    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = api_key

    def get_stations(self) -> list[dict]:
        return []
