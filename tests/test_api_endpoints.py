import asyncio
import json
import time
import pytest
import httpx
from starlette.responses import StreamingResponse

import app


class _DisconnectedRequest:
    async def is_disconnected(self) -> bool:
        return True


class _MockClient:
    def __init__(self, handler):
        self.handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass

    async def get(self, url, **kwargs):
        return self.handler(url, **kwargs)


class _MockResponse:
    def __init__(self, status_code: int, data: dict | list):
        self.status_code = status_code
        self._data = data

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("Error", request=None, response=None)


# ── Tests for api_departures ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_departures_handles_null_actual_datetime(monkeypatch):
    """Bug probe: when actualDateTime is None in API payload, len(actual_dt) must not crash."""
    app.departures_cache.clear()

    raw_payload = {
        "payload": {
            "departures": [
                {
                    "direction": "Amsterdam Centraal",
                    "plannedDateTime": "2026-10-15T14:30:00+0200",
                    "actualDateTime": None,  # Bug trigger!
                    "plannedTrack": "4",
                    "actualTrack": None,
                    "product": {"categoryCode": "IC", "shortCategoryName": "Intercity", "number": "800"},
                    "messages": None,
                }
            ]
        }
    }

    async def fake_fetch_json(client, path, params=None):
        return raw_payload

    monkeypatch.setattr(app, "_fetch_json", fake_fetch_json)

    response = await app.api_departures("UT")
    assert response.status_code == 200
    data = json.loads(response.body)
    assert len(data["departures"]) == 1
    dep = data["departures"][0]
    assert dep["planned_time"] == "14:30"
    assert dep["actual_time"] == ""
    assert dep["delay_minutes"] == 0


@pytest.mark.asyncio
async def test_departures_handles_null_planned_datetime(monkeypatch):
    """Bug probe: plannedDateTime is None or malformed."""
    app.departures_cache.clear()

    raw_payload = {
        "payload": {
            "departures": [
                {
                    "direction": "Rotterdam Centraal",
                    "plannedDateTime": None,  # Bug trigger!
                    "actualDateTime": "2026-10-15T15:00:00+0200",
                    "product": {"categoryCode": "SPR", "number": "4000"},
                }
            ]
        }
    }

    async def fake_fetch_json(client, path, params=None):
        return raw_payload

    monkeypatch.setattr(app, "_fetch_json", fake_fetch_json)

    response = await app.api_departures("ASD")
    assert response.status_code == 200
    data = json.loads(response.body)
    dep = data["departures"][0]
    assert dep["planned_time"] == ""
    assert dep["actual_time"] == "15:00"
    assert dep["delay_minutes"] == 0


@pytest.mark.asyncio
async def test_departures_midnight_delay_calculation(monkeypatch):
    """Test delay computation when departure spans across midnight."""
    app.departures_cache.clear()

    raw_payload = {
        "payload": {
            "departures": [
                {
                    "direction": "Utrecht Centraal",
                    "plannedDateTime": "2026-10-15T23:55:00+0200",
                    "actualDateTime": "2026-10-16T00:07:00+0200",  # +12 min across midnight
                    "product": {"categoryCode": "IC", "number": "1400"},
                }
            ]
        }
    }

    async def fake_fetch_json(client, path, params=None):
        return raw_payload

    monkeypatch.setattr(app, "_fetch_json", fake_fetch_json)

    response = await app.api_departures("GVC")
    assert response.status_code == 200
    data = json.loads(response.body)
    dep = data["departures"][0]
    assert dep["delay_minutes"] == 12


@pytest.mark.asyncio
async def test_departures_handles_null_messages_and_missing_product(monkeypatch):
    """Bug probe: empty product and malformed messages."""
    app.departures_cache.clear()

    raw_payload = {
        "payload": {
            "departures": [
                {
                    "direction": None,
                    "plannedDateTime": "2026-10-15T10:00:00+0200",
                    "product": None,
                    "messages": [{"message": "Spoorwijziging"}, {"message": None}, {}],
                }
            ]
        }
    }

    async def fake_fetch_json(client, path, params=None):
        return raw_payload

    monkeypatch.setattr(app, "_fetch_json", fake_fetch_json)

    response = await app.api_departures("LEDN")
    assert response.status_code == 200
    data = json.loads(response.body)
    dep = data["departures"][0]
    assert dep["category"] == "TRAIN"
    assert dep["messages"] == ["Spoorwijziging"]


# ── Tests for api_journey ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_journey_handles_null_id_and_station_code(monkeypatch):
    """Bug probe: s.get('id') is None, causing s.get('id', '').split('_') to crash with AttributeError."""
    app.journey_cache.clear()

    raw_payload = {
        "payload": {
            "stops": [
                {
                    "id": None,  # Bug trigger!
                    "stop": {"name": "Arnhem Centraal", "stationCode": None, "lat": 51.985, "lng": 5.900},
                    "departures": [
                        {
                            "plannedTime": "2026-10-15T12:00:00+0200",
                            "product": {"operatorName": "NS", "shortCategoryName": "IC"},
                        }
                    ],
                },
                {
                    "id": "UT_1",
                    "stop": {"name": "Utrecht Centraal", "stationCode": "UT", "lat": 52.089, "lng": 5.110},
                    "arrivals": [
                        {
                            "plannedTime": "2026-10-15T12:35:00+0200",
                            "product": {"operatorName": "NS", "shortCategoryName": "IC"},
                        }
                    ],
                },
            ]
        }
    }

    async def fake_fetch_json(client, path, params=None):
        return raw_payload

    monkeypatch.setattr(app, "_fetch_json", fake_fetch_json)

    response = await app.api_journey(3000, lat=51.985, lng=5.900)
    assert response.status_code == 200
    data = json.loads(response.body)
    assert len(data["stops"]) == 2
    assert data["origin"] == "Arnhem Centraal"
    assert data["destination"] == "Utrecht Centraal"


@pytest.mark.asyncio
async def test_journey_handles_none_delay_in_seconds(monkeypatch):
    """Bug probe: arrivals or departures have delayInSeconds explicitly set to None."""
    app.journey_cache.clear()

    raw_payload = {
        "payload": {
            "stops": [
                {
                    "id": "ASD_0",
                    "stop": {"name": "Amsterdam Centraal", "lat": 52.379, "lng": 4.900},
                    "departures": [{"plannedTime": "2026-10-15T08:00:00+0200", "delayInSeconds": None}],
                    "arrivals": [{"delayInSeconds": None}],
                },
                {
                    "id": "RTD_1",
                    "stop": {"name": "Rotterdam Centraal", "lat": 51.924, "lng": 4.470},
                    "arrivals": [{"plannedTime": "2026-10-15T08:40:00+0200", "delayInSeconds": None}],
                },
            ]
        }
    }

    async def fake_fetch_json(client, path, params=None):
        return raw_payload

    monkeypatch.setattr(app, "_fetch_json", fake_fetch_json)

    response = await app.api_journey(900, lat=52.379, lng=4.900)
    assert response.status_code == 200
    data = json.loads(response.body)
    assert data["stops"][0]["delay_minutes"] == 0
    assert data["stops"][1]["delay_minutes"] == 0


@pytest.mark.asyncio
async def test_journey_handles_train_parts_with_null_image(monkeypatch):
    """Bug probe: actualStock has trainParts with image: None or missing uri."""
    app.journey_cache.clear()

    raw_payload = {
        "payload": {
            "actualStock": {
                "trainType": "VIRM",
                "numberOfSeats": 420,
                "numberOfParts": 4,
                "trainParts": [
                    {"stockIdentifier": "9501", "image": None},
                    {"stockIdentifier": "9502", "image": {}},
                ],
            },
            "stops": [
                {
                    "id": "ZL_0",
                    "stop": {"name": "Zwolle", "lat": 52.505, "lng": 6.091},
                    "departures": [{"plannedTime": "2026-10-15T09:00:00+0200"}],
                },
                {
                    "id": "GN_1",
                    "stop": {"name": "Groningen", "lat": 53.211, "lng": 6.564},
                    "arrivals": [{"plannedTime": "2026-10-15T10:00:00+0200"}],
                },
            ],
        }
    }

    async def fake_fetch_json(client, path, params=None):
        return raw_payload

    monkeypatch.setattr(app, "_fetch_json", fake_fetch_json)

    response = await app.api_journey(700, lat=52.505, lng=6.091)
    assert response.status_code == 200
    data = json.loads(response.body)
    assert data["image_url"] is None
    assert len(data["composition"]) == 2
    assert data["composition"][0]["image"] is None


@pytest.mark.asyncio
async def test_journey_handles_zero_stops(monkeypatch):
    """Bug probe: API returns empty stops list."""
    app.journey_cache.clear()

    raw_payload = {"payload": {"stops": []}}

    async def fake_fetch_json(client, path, params=None):
        return raw_payload

    monkeypatch.setattr(app, "_fetch_json", fake_fetch_json)

    response = await app.api_journey(9999)
    assert response.status_code == 200
    data = json.loads(response.body)
    assert data["stops"] == []
    assert data["origin"] == ""
    assert data["destination"] == ""
    assert data["next_stop"] is None


# ── Tests for api_weather ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_weather_handles_api_failure_and_fallback(monkeypatch):
    """Bug probe: Open-Meteo returns non-200 or raises exception."""
    app.weather_cache = None
    app.weather_cache_time = 0.0

    class FailingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        async def get(self, url, **kwargs):
            return _MockResponse(500, {"error": "Server error"})

    monkeypatch.setattr(httpx, "AsyncClient", lambda *args, **kwargs: FailingClient())

    response = await app.api_weather()
    assert response.status_code == 200
    data = json.loads(response.body)
    assert data["count"] == 0
    assert data["corridors"] == []


@pytest.mark.asyncio
async def test_weather_wmo_code_coverage():
    """Verify all WMO codes produce human-readable Dutch condition and icon."""
    for code in (0, 1, 2, 3, 45, 48, 51, 61, 71, 95, 999):
        name, icon = app._wmo_to_condition(code)
        assert isinstance(name, str) and len(name) > 0
        assert isinstance(icon, str) and len(icon) > 0


# ── Tests for api_disruptions ────────────────────────────────────────

@pytest.mark.asyncio
async def test_disruptions_handles_null_sections_and_coordinates(monkeypatch):
    """Bug probe: disruptions with null coordinates or empty stations."""
    app.disruptions_state = {"timestamp": 0, "count": 0, "disruptions": []}

    raw_payload = [
        {
            "id": "12345",
            "title": "Wisselstoring bij Gouda",
            "isActive": True,
            "publicationSections": [
                {
                    "section": {
                        "stations": [
                            {"name": "Gouda", "stationCode": "GD", "coordinate": None},  # Bug trigger!
                            {"name": "Woerden", "stationCode": "WD", "coordinate": {"lat": "52.086", "lng": "4.890"}},
                        ]
                    }
                }
            ],
            "timespans": [{"cause": {"label": "Wisselstoring"}, "situation": {"label": "Geen treinen"}}],
        }
    ]

    async def fake_fetch_json(client, path, params=None):
        return raw_payload

    monkeypatch.setattr(app, "_fetch_json", fake_fetch_json)

    await app._poll_disruptions(None)
    assert app.disruptions_state["count"] == 1
    disr = app.disruptions_state["disruptions"][0]
    assert disr["title"] == "Wisselstoring bij Gouda"
    # Because only 1 coordinate was valid, sections (< 2 coords) should be empty
    assert disr["sections"] == []


# ── Tests for api_stream ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stream_disconnect_cleans_up_listeners():
    """Verify that when a client disconnects, its queue is purged from _listeners."""
    initial_listener_count = len(app._listeners)
    req = _DisconnectedRequest()

    response = await app.api_stream(req)
    assert isinstance(response, StreamingResponse)

    # Consume the stream generator until completion
    async for _ in response.body_iterator:
        pass

    assert len(app._listeners) == initial_listener_count


# ── Tests for api_provinces ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_api_provinces_returns_12_provinces_with_exact_schema():
    """Verify that /api/provinces returns all 12 Dutch provinces with colors and metadata."""
    app.provinces_cache = None  # Ensure fresh load from disk
    response = await app.api_provinces()
    assert response.status_code == 200

    payload = json.loads(response.body.decode("utf-8"))
    assert payload.get("type") == "FeatureCollection"
    features = payload.get("features", [])
    assert len(features) == 12

    expected_provinces = {
        "Groningen", "Fryslân", "Drenthe", "Overijssel", "Flevoland",
        "Gelderland", "Utrecht", "Noord-Holland", "Zuid-Holland",
        "Zeeland", "Noord-Brabant", "Limburg"
    }

    found_names = set()
    for feat in features:
        props = feat.get("properties", {})
        name = props.get("name")
        found_names.add(name)

        assert props.get("name_en") is not None
        assert props.get("code") is not None
        assert props.get("iso_code", "").startswith("NL-")
        assert props.get("color", "").startswith("#") and len(props["color"]) == 7
        assert props.get("capital") is not None

        label_pt = props.get("label_point")
        assert isinstance(label_pt, list) and len(label_pt) == 2
        # Check within Netherlands coordinates
        assert 3.0 <= label_pt[0] <= 7.5
        assert 50.5 <= label_pt[1] <= 53.8

        geom = feat.get("geometry", {})
        assert geom.get("type") in ("Polygon", "MultiPolygon")
        assert len(geom.get("coordinates", [])) > 0

    assert found_names == expected_provinces


@pytest.mark.asyncio
async def test_api_provinces_file_missing_returns_404(monkeypatch, tmp_path):
    """Verify error handling when provinces.geojson is missing."""
    app.provinces_cache = None
    missing_file = tmp_path / "non_existent_provinces.geojson"
    monkeypatch.setattr(app, "PROVINCES_FILE", missing_file)

    response = await app.api_provinces()
    assert response.status_code == 404
    data = json.loads(response.body.decode("utf-8"))
    assert "error" in data


@pytest.mark.asyncio
async def test_api_provinces_corrupted_file_handles_gracefully(monkeypatch, tmp_path):
    """Verify error handling when provinces.geojson contains corrupted JSON."""
    app.provinces_cache = None
    corrupt_file = tmp_path / "corrupt_provinces.geojson"
    corrupt_file.write_text("{{corrupted json invalid", encoding="utf-8")
    monkeypatch.setattr(app, "PROVINCES_FILE", corrupt_file)

    response = await app.api_provinces()
    assert response.status_code == 404
    data = json.loads(response.body.decode("utf-8"))
    assert "error" in data


@pytest.mark.asyncio
async def test_api_delays_bulk_fleet_payload():
    """Verify /api/delays returns delays for all active trains in one single bulk payload."""
    app.trains_registry.clear()
    app.train_delays.clear()

    # Register trains: 200 (on time), 201 (+4 min), 202 (+7 min)
    app.trains_registry[200] = {"id": 200, "lat": 52.0, "lng": 5.0, "type": "IC", "delay": 0}
    app.trains_registry[201] = {"id": 201, "lat": 52.1, "lng": 5.1, "type": "SPR", "delay": 4}
    app.trains_registry[202] = {"id": 202, "lat": 52.2, "lng": 5.2, "type": "IC", "delay": 7}

    response = await app.api_delays()
    assert response.status_code == 200
    data = json.loads(response.body.decode("utf-8"))

    assert data["total_trains"] == 3
    assert data["delayed_count"] == 2
    assert data["punctuality_pct"] == 33  # (1 / 3) * 100 = 33%
    assert data["delays"]["200"] == 0
    assert data["delays"]["201"] == 4
    assert data["delays"]["202"] == 7

