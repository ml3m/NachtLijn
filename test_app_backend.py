import json
import time
import unittest

from starlette.responses import StreamingResponse

import app


class _DisconnectedRequest:
    async def is_disconnected(self) -> bool:
        return True


class AppBackendTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_stream_returns_streaming_response(self):
        response = await app.api_stream(_DisconnectedRequest())
        self.assertIsInstance(response, StreamingResponse)

    async def test_health_reports_tracked_train_count(self):
        original_state = app.trains_state
        app.trains_state = {"trains": [{"id": 1}, {"id": 2}, {"id": 3}]}
        try:
            payload = await app.health_check()
        finally:
            app.trains_state = original_state
        self.assertEqual(payload["trains_tracked"], 3)

    async def test_journey_uses_cache_key_consistently(self):
        cache_key = "123_0_0"
        cached_payload = {"train_id": 123, "stops": []}
        app.journey_cache = {cache_key: (time.time(), cached_payload)}
        response = await app.api_journey(123, lat=0.0, lng=0.0)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), cached_payload)

    async def test_journey_stores_response_by_cache_key(self):
        async def fake_fetch_json(_client, path, params=None):
            self.assertEqual(path, "/reisinformatie-api/api/v2/journey")
            self.assertEqual(params, {"train": 456})
            return {
                "payload": {
                    "stops": [
                        {
                            "id": "UT_0",
                            "stop": {"name": "Utrecht Centraal", "stationCode": "UT", "lat": 52.0894, "lng": 5.1100},
                            "departures": [
                                {
                                    "plannedTime": "2026-10-15T10:00:00+00:00",
                                    "product": {"operatorName": "NS", "shortCategoryName": "IC"},
                                }
                            ],
                        }
                    ]
                }
            }

        original_fetch = app._fetch_json
        original_cache = app.journey_cache
        app._fetch_json = fake_fetch_json
        app.journey_cache = {}
        try:
            response = await app.api_journey(456, lat=52.0, lng=5.0)
        finally:
            app._fetch_json = original_fetch
            cache_after = app.journey_cache
            app.journey_cache = original_cache

        self.assertEqual(response.status_code, 200)
        self.assertIn("456_52.0_5.0", cache_after)


if __name__ == "__main__":
    unittest.main()
