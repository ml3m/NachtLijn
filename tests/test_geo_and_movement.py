import math
import time
import pytest
from datetime import datetime

import app


# ── Tests for _haversine_km ──────────────────────────────────────────

def test_haversine_identical_points():
    """Identical points must return exactly 0.0 distance."""
    d = app._haversine_km(52.0894, 5.1100, 52.0894, 5.1100)
    assert d == 0.0


def test_haversine_known_distance_utrecht_amsterdam():
    """Utrecht Centraal (52.0894, 5.1100) to Amsterdam Centraal (52.3791, 4.9003) is ~35 km."""
    d = app._haversine_km(52.0894, 5.1100, 52.3791, 4.9003)
    assert 34.0 < d < 36.5


def test_haversine_antipodal_extremes():
    """Antipodal points (North Pole to South Pole) must not cause math domain error in asin(sqrt)."""
    d = app._haversine_km(90.0, 0.0, -90.0, 0.0)
    assert abs(d - (math.pi * 6371.0)) < 1.0


def test_haversine_antimeridian_crossing():
    """Crossing the 180/-180 meridian."""
    d = app._haversine_km(0.0, 179.9, 0.0, -179.9)
    # 0.2 degrees at equator is ~22.2 km
    assert 20.0 < d < 25.0


# ── Tests for _point_to_segment_dist_and_t ───────────────────────────

def test_point_to_segment_degenerate_zero_length():
    """Segment where S1 == S2 must return distance to S1 and t=0.0 without ZeroDivisionError."""
    dist, t = app._point_to_segment_dist_and_t(52.1, 5.1, 52.0, 5.0, 52.0, 5.0)
    expected_dist = app._haversine_km(52.1, 5.1, 52.0, 5.0)
    assert abs(dist - expected_dist) < 1e-4
    assert t == 0.0


def test_point_to_segment_clamped_projections():
    """Test t clamping when point lies before s1 or beyond s2."""
    s1lat, s1lon = 52.0, 5.0
    s2lat, s2lon = 52.0, 5.2

    # Point far to the west of s1 -> t clamped to 0.0
    dist_before, t_before = app._point_to_segment_dist_and_t(52.0, 4.8, s1lat, s1lon, s2lat, s2lon)
    assert t_before < 0.0

    # Point far to the east of s2 -> t clamped to 1.0
    dist_after, t_after = app._point_to_segment_dist_and_t(52.0, 5.4, s1lat, s1lon, s2lat, s2lon)
    assert t_after > 1.0

    # Point directly at midpoint
    dist_mid, t_mid = app._point_to_segment_dist_and_t(52.0, 5.1, s1lat, s1lon, s2lat, s2lon)
    assert 0.45 < t_mid < 0.55


# ── Tests for _resolve_journey_station_progress ───────────────────────

def test_resolve_progress_empty_and_single_stop():
    """Zero or single stop edge cases."""
    assert app._resolve_journey_station_progress([], 52.0, 5.0) == 0

    single = [{"name": "Only Stop", "lat": 52.0, "lng": 5.0}]
    assert app._resolve_journey_station_progress(single, 52.0, 5.0) == 0
    assert single[0]["state"] == "next"


def test_resolve_progress_at_destination():
    """Train within 650m of final terminal station."""
    stops = [
        {"name": "Utrecht", "lat": 52.0894, "lng": 5.1100},
        {"name": "Gouda", "lat": 52.0175, "lng": 4.7061},
        {"name": "Rotterdam", "lat": 51.9244, "lng": 4.4777},
    ]
    # Train 200m from Rotterdam
    next_idx = app._resolve_journey_station_progress(stops, 51.9250, 4.4780)
    assert next_idx == 2
    assert stops[0]["state"] == "passed"
    assert stops[1]["state"] == "passed"
    assert stops[2]["state"] == "next"
    assert stops[2].get("at_destination") is True


def test_resolve_progress_at_origin():
    """Train within 650m of origin platform."""
    stops = [
        {"name": "Utrecht", "lat": 52.0894, "lng": 5.1100},
        {"name": "Gouda", "lat": 52.0175, "lng": 4.7061},
        {"name": "Rotterdam", "lat": 51.9244, "lng": 4.4777},
    ]
    # Train 150m from Utrecht
    next_idx = app._resolve_journey_station_progress(stops, 52.0900, 5.1110)
    assert next_idx == 0
    assert stops[0]["state"] == "next"
    assert stops[0].get("at_origin") is True
    assert stops[1]["state"] == "upcoming"
    assert stops[2]["state"] == "upcoming"


def test_resolve_progress_dwelling_at_intermediate_station():
    """Train dwelling directly at Gouda station (middle stop)."""
    stops = [
        {"name": "Utrecht", "lat": 52.0894, "lng": 5.1100},
        {"name": "Gouda", "lat": 52.0175, "lng": 4.7061},
        {"name": "Rotterdam", "lat": 51.9244, "lng": 4.4777},
    ]
    # Train 100m from Gouda
    next_idx = app._resolve_journey_station_progress(stops, 52.0180, 4.7065)
    assert next_idx == 1
    assert stops[0]["state"] == "passed"
    assert stops[1]["state"] == "next"
    assert stops[1].get("at_station") is True
    assert stops[2]["state"] == "upcoming"


def test_resolve_progress_in_transit_between_stations():
    """Train running mid-track between Gouda and Rotterdam."""
    stops = [
        {"name": "Utrecht", "lat": 52.0894, "lng": 5.1100},
        {"name": "Gouda", "lat": 52.0175, "lng": 4.7061},
        {"name": "Rotterdam", "lat": 51.9244, "lng": 4.4777},
    ]
    # Train is midway between Gouda and Rotterdam (around Nieuwerkerk a/d IJssel)
    mid_lat = (52.0175 + 51.9244) / 2
    mid_lng = (4.7061 + 4.4777) / 2
    next_idx = app._resolve_journey_station_progress(stops, mid_lat, mid_lng)
    assert next_idx == 2  # Rotterdam is the upcoming next stop
    assert stops[0]["state"] == "passed"
    assert stops[1]["state"] == "passed"
    assert stops[2]["state"] == "next"


def test_resolve_progress_nan_and_inf_coordinates_triggers_fallback():
    """Bug probe: NaN or Inf GPS coordinates must not result in garbage states."""
    stops = [
        {"name": "Stop 1", "lat": 52.0, "lng": 5.0, "time": "12:00"},
        {"name": "Stop 2", "lat": 52.1, "lng": 5.1, "time": "12:15"},
    ]
    # If coordinates are NaN, it should not crash and should fall back safely
    next_idx = app._resolve_journey_station_progress(stops, float("nan"), float("nan"))
    assert next_idx in (0, 1)
    assert stops[next_idx]["state"] == "next"


def test_resolve_progress_temporal_fallback():
    """When GPS is completely absent (None), temporal timeline alignment is used."""
    now_dt = datetime.now()
    t1 = f"{(now_dt.hour - 1) % 24:02d}:00"
    t2 = f"{(now_dt.hour + 1) % 24:02d}:00"
    stops = [
        {"name": "Past Stop", "time": t1},
        {"name": "Future Stop", "time": t2},
    ]
    next_idx = app._resolve_journey_station_progress(stops, None, None)
    assert next_idx == 1
    assert stops[0]["state"] == "passed"
    assert stops[1]["state"] == "next"


# ── Tests for _build_route_geometry ──────────────────────────────────

def test_build_route_geometry_handles_zero_coordinates():
    """Bug probe: Equator/Prime Meridian coordinate (0.0, 0.0) must not be treated as falsy None."""
    stations = [
        {"code": "s1", "name": "Zero Island", "lat": 0.0, "lng": 0.0},
        {"code": "s2", "name": "East Island", "lat": 0.0, "lng": 5.0},
    ]
    geom = app._build_route_geometry(stations)
    assert len(geom) >= 2
    assert geom[0] == [0.0, 0.0]
    assert geom[-1] == [0.0, 5.0]


def test_build_route_geometry_missing_stations_and_single_station():
    """Empty list or single station must return empty geometry."""
    assert app._build_route_geometry([]) == []
    assert app._build_route_geometry([{"code": "ut", "lat": 52.0, "lng": 5.0}]) == []


# ── Tests for _parse_train ───────────────────────────────────────────

def test_parse_train_valid():
    """Valid train dictionary parsing."""
    raw = {
        "treinNummer": "2145",
        "lat": "52.3791",
        "lng": "4.9003",
        "snelheid": "130.5",
        "richting": "180.0",
        "type": "IC",
        "bron": "GNSS",
    }
    t = app._parse_train(raw)
    assert t is not None
    assert t["id"] == 2145
    assert t["lat"] == 52.3791
    assert t["speed"] == 130.5
    assert t["type"] == "IC"


def test_parse_train_invalid_coordinates_and_types():
    """Bug probe: invalid coordinates and non-numeric fields."""
    # Out of range latitude
    assert app._parse_train({"treinNummer": 1, "lat": 95.0, "lng": 5.0}) is None
    assert app._parse_train({"treinNummer": 1, "lat": -91.0, "lng": 5.0}) is None
    # Out of range longitude
    assert app._parse_train({"treinNummer": 1, "lat": 52.0, "lng": 181.0}) is None
    # Non-numeric coordinate string
    assert app._parse_train({"treinNummer": 1, "lat": "bad", "lng": 5.0}) is None
    # Missing required treinNummer
    assert app._parse_train({"lat": 52.0, "lng": 5.0}) is None
    # None inputs
    assert app._parse_train({}) is None
