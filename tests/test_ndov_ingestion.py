import time
from datetime import datetime, timezone
import pytest

import app


def _build_trein_xml(train_blocks: list[dict]) -> str:
    """Helper to generate valid NDOV Cognos XML string."""
    xml_parts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<ArrayOfTreinLocation xmlns="http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models">',
    ]
    for t in train_blocks:
        xml_parts.append('<TreinLocation>')
        if "trein_nummer" in t:
            xml_parts.append(f'<TreinNummer>{t["trein_nummer"]}</TreinNummer>')
        for c in t.get("cabs", []):
            xml_parts.append('<TreinMaterieelDelen>')
            if "lat" in c:
                xml_parts.append(f'<Latitude>{c["lat"]}</Latitude>')
            if "lng" in c:
                xml_parts.append(f'<Longitude>{c["lng"]}</Longitude>')
            if "speed" in c:
                xml_parts.append(f'<Snelheid>{c["speed"]}</Snelheid>')
            if "heading" in c:
                xml_parts.append(f'<Richting>{c["heading"]}</Richting>')
            if "gps_time" in c:
                xml_parts.append(f'<GpsDatumTijd>{c["gps_time"]}</GpsDatumTijd>')
            if "volgorde" in c:
                xml_parts.append(f'<MaterieelDeelVolgorde>{c["volgorde"]}</MaterieelDeelVolgorde>')
            if "matnr" in c:
                xml_parts.append(f'<MaterieelNummer>{c["matnr"]}</MaterieelNummer>')
            xml_parts.append('</TreinMaterieelDelen>')
        xml_parts.append('</TreinLocation>')
    xml_parts.append('</ArrayOfTreinLocation>')
    return "".join(xml_parts)


@pytest.fixture(autouse=True)
def clean_registry():
    app.trains_registry.clear()
    app.train_delays.clear()
    app.trains_state = {
        "timestamp": 0,
        "next_update_at": 0,
        "count": 0,
        "counts": {"IC": 0, "SPR": 0, "other": 0},
        "delayed_count": 0,
        "punctuality_pct": 100,
        "status": "starting",
        "trains": [],
    }
    yield
    app.trains_registry.clear()
    app.train_delays.clear()


def test_parse_ndov_xml_valid_single_train():
    """Verify clean ingestion of a valid train."""
    now = 1700000000.0
    now_iso = datetime.fromtimestamp(now, tz=timezone.utc).isoformat()
    xml = _build_trein_xml([
        {
            "trein_nummer": "845",
            "cabs": [{
                "lat": "52.0894",
                "lng": "5.1100",
                "speed": "120.0",
                "heading": "90.0",
                "gps_time": now_iso,
                "volgorde": "1",
                "matnr": "4011",
            }],
        }
    ])

    changed = app._parse_ndov_xml(xml, now)
    assert changed is True
    assert 845 in app.trains_registry
    t = app.trains_registry[845]
    assert t["lat"] == 52.0894
    assert t["lng"] == 5.1100
    assert t["speed"] == 120.0
    assert t["heading"] == 90.0
    assert t["type"] == "IC"


def test_parse_ndov_xml_deterministic_cab_sorting():
    """Cab with volgorde=1 must be selected even if cab 2 appears first in XML."""
    now = 1700000000.0
    now_iso = datetime.fromtimestamp(now, tz=timezone.utc).isoformat()
    xml = _build_trein_xml([
        {
            "trein_nummer": "4020",
            "cabs": [
                {
                    "lat": "52.1000",
                    "lng": "5.2000",
                    "speed": "90.0",
                    "gps_time": now_iso,
                    "volgorde": "2",
                    "matnr": "9502",
                },
                {
                    "lat": "52.1020",
                    "lng": "5.2030",
                    "speed": "90.0",
                    "gps_time": now_iso,
                    "volgorde": "1",
                    "matnr": "9501",
                },
            ],
        }
    ])

    changed = app._parse_ndov_xml(xml, now)
    assert changed is True
    t = app.trains_registry[4020]
    # Chosen cab must be volgorde 1 (52.1020, 5.2030)
    assert t["lat"] == 52.1020
    assert t["lng"] == 5.2030


def test_parse_ndov_xml_drops_corrupt_train_number_without_aborting_batch():
    """Bug probe: a non-integer TreinNummer must not crash XML parsing or abort remaining trains in batch."""
    now = 1700000000.0
    now_iso = datetime.fromtimestamp(now, tz=timezone.utc).isoformat()
    xml = _build_trein_xml([
        {
            "trein_nummer": "BAD_NAN_STRING",  # Corrupt record
            "cabs": [{"lat": "52.0", "lng": "5.0", "gps_time": now_iso}],
        },
        {
            "trein_nummer": "2145",  # Valid record
            "cabs": [{
                "lat": "52.3791",
                "lng": "4.9003",
                "speed": "100.0",
                "gps_time": now_iso,
                "volgorde": "1",
            }],
        },
    ])

    changed = app._parse_ndov_xml(xml, now)
    assert changed is True
    assert 2145 in app.trains_registry
    assert app.trains_registry[2145]["lat"] == 52.3791


def test_parse_ndov_xml_drops_out_of_bounds_fixes():
    """Coordinates outside Netherlands bounding box (50.5-54.0 lat, 2.5-7.5 lng) must be ignored."""
    now = 1700000000.0
    now_iso = datetime.fromtimestamp(now, tz=timezone.utc).isoformat()
    xml = _build_trein_xml([
        {
            "trein_nummer": "999",
            "cabs": [{"lat": "48.8566", "lng": "2.3522", "gps_time": now_iso}],  # Paris
        }
    ])

    changed = app._parse_ndov_xml(xml, now)
    assert changed is False
    assert 999 not in app.trains_registry


def test_parse_ndov_xml_drops_stale_and_future_fixes():
    """Fixes older than 75s or future-skewed > 15s must be rejected."""
    now = 1700000000.0
    # Stale fix: 100 seconds ago
    stale_iso = datetime.fromtimestamp(now - 100, tz=timezone.utc).isoformat()
    # Future fix: 30 seconds into the future
    future_iso = datetime.fromtimestamp(now + 30, tz=timezone.utc).isoformat()

    xml = _build_trein_xml([
        {
            "trein_nummer": "111",
            "cabs": [{"lat": "52.0", "lng": "5.0", "gps_time": stale_iso}],
        },
        {
            "trein_nummer": "222",
            "cabs": [{"lat": "52.0", "lng": "5.0", "gps_time": future_iso}],
        },
    ])

    changed = app._parse_ndov_xml(xml, now)
    assert changed is False
    assert 111 not in app.trains_registry
    assert 222 not in app.trains_registry


def test_parse_ndov_xml_supersonic_teleport_glitch_protection():
    """A train jumping > 3.5km in < 30 seconds must be dropped to prevent trail smearing."""
    t0 = 1700000000.0
    t0_iso = datetime.fromtimestamp(t0, tz=timezone.utc).isoformat()
    xml0 = _build_trein_xml([
        {
            "trein_nummer": "500",
            "cabs": [{"lat": "52.0894", "lng": "5.1100", "gps_time": t0_iso}],
        }
    ])
    app._parse_ndov_xml(xml0, t0)
    assert 500 in app.trains_registry

    # 5 seconds later, glitch fix claims train is in Amsterdam (35km away)
    t1 = t0 + 5.0
    t1_iso = datetime.fromtimestamp(t1, tz=timezone.utc).isoformat()
    xml1 = _build_trein_xml([
        {
            "trein_nummer": "500",
            "cabs": [{"lat": "52.3791", "lng": "4.9003", "gps_time": t1_iso}],
        }
    ])
    app._parse_ndov_xml(xml1, t1)

    # Train must NOT have teleported to Amsterdam
    t = app.trains_registry[500]
    assert t["lat"] == 52.0894
    assert t["lng"] == 5.1100


def test_parse_ndov_xml_stationary_train_speed_zeroing():
    """Train stationary (< 5m in >= 5s) has speed set to 0.0."""
    t0 = 1700000000.0
    t0_iso = datetime.fromtimestamp(t0, tz=timezone.utc).isoformat()
    xml0 = _build_trein_xml([
        {
            "trein_nummer": "600",
            "cabs": [{"lat": "52.0894", "lng": "5.1100", "speed": "15.0", "gps_time": t0_iso}],
        }
    ])
    app._parse_ndov_xml(xml0, t0)

    # 6s later, train moved 1 meter with residual GPS drift speed 2.0 km/h
    t1 = t0 + 6.0
    t1_iso = datetime.fromtimestamp(t1, tz=timezone.utc).isoformat()
    xml1 = _build_trein_xml([
        {
            "trein_nummer": "600",
            "cabs": [{"lat": "52.089405", "lng": "5.110005", "speed": "2.0", "gps_time": t1_iso}],
        }
    ])
    app._parse_ndov_xml(xml1, t1)

    t = app.trains_registry[600]
    assert t["speed"] == 0.0


def test_parse_ndov_xml_category_determination():
    """Verify NS train numbering series categorization."""
    now = 1700000000.0
    now_iso = datetime.fromtimestamp(now, tz=timezone.utc).isoformat()
    series = [
        (800, "IC"),
        (2100, "IC"),
        (3999, "IC"),
        (4000, "SPR"),
        (7000, "SPR"),
        (9999, "SPR"),
        (10001, "other"),
        (11400, "IC"),
        (14001, "other"),
        (20400, "SPR"),
        (30400, "other"),
    ]

    for tid, expected_cat in series:
        xml = _build_trein_xml([
            {"trein_nummer": str(tid), "cabs": [{"lat": "52.0", "lng": "5.0", "gps_time": now_iso}]}
        ])
        app._parse_ndov_xml(xml, now)
        assert app.trains_registry[tid]["type"] == expected_cat


def test_parse_ndov_xml_pruning_stale_trains():
    """Trains not updated for > 80s are pruned from registry."""
    t0 = 1700000000.0
    t0_iso = datetime.fromtimestamp(t0, tz=timezone.utc).isoformat()
    xml0 = _build_trein_xml([
        {"trein_nummer": "777", "cabs": [{"lat": "52.0", "lng": "5.0", "gps_time": t0_iso}]}
    ])
    app._parse_ndov_xml(xml0, t0)
    assert 777 in app.trains_registry

    # 90s later, another train updates
    t1 = t0 + 90.0
    t1_iso = datetime.fromtimestamp(t1, tz=timezone.utc).isoformat()
    xml1 = _build_trein_xml([
        {"trein_nummer": "888", "cabs": [{"lat": "52.1", "lng": "5.1", "gps_time": t1_iso}]}
    ])
    app._parse_ndov_xml(xml1, t1)

    # 777 must have been pruned (> 80s stale), 888 must be present
    assert 777 not in app.trains_registry
    assert 888 in app.trains_registry


# ── Tests for DVS Ingestion & Delay Tracking ────────────────────────

def test_parse_iso_duration_seconds_all_variants():
    """Verify ISO duration parser accurately parses seconds, minutes, hours, and negative delays."""
    assert app._parse_iso_duration_seconds("PT3M8S") == 188
    assert app._parse_iso_duration_seconds("PT44S") == 44
    assert app._parse_iso_duration_seconds("PT0S") == 0
    assert app._parse_iso_duration_seconds("PT1H2M3S") == 3723
    assert app._parse_iso_duration_seconds("-PT30S") == -30
    assert app._parse_iso_duration_seconds("None") == 0
    assert app._parse_iso_duration_seconds("") == 0
    assert app._parse_iso_duration_seconds(None) == 0
    assert app._parse_iso_duration_seconds("MALFORMED") == 0


def test_parse_dvs_xml_populates_delays_and_updates_registry():
    """Verify DVS XML message updates train_delays and trains_registry."""
    now = 1700000000.0
    now_iso = datetime.fromtimestamp(now, tz=timezone.utc).isoformat()

    # Pre-register train 6089 on radar
    gps_xml = _build_trein_xml([
        {"trein_nummer": "6089", "cabs": [{"lat": "52.0", "lng": "5.0", "gps_time": now_iso}]}
    ])
    app._parse_ndov_xml(gps_xml, now)
    assert 6089 in app.trains_registry
    assert app.trains_registry[6089]["delay"] == 0

    # Ingest DVS update: 6089 is delayed by PT4M30S (4.5 min -> 5 min)
    dvs_xml = """<?xml version="1.0" encoding="UTF-8"?>
<PutReisInformatieBoodschapIn xmlns="urn:ndov:cdm:trein:reisinformatie:messages:5">
  <ReisInformatieProductDVS xmlns="urn:ndov:cdm:trein:reisinformatie:data:4">
    <DynamischeVertrekStaat>
      <Trein>
        <TreinNummer>6089</TreinNummer>
      </Trein>
      <ExacteVertrekVertraging>PT4M30S</ExacteVertrekVertraging>
    </DynamischeVertrekStaat>
  </ReisInformatieProductDVS>
</PutReisInformatieBoodschapIn>"""

    changed = app._parse_dvs_xml(dvs_xml, now)
    assert changed is True
    assert 6089 in app.train_delays
    assert app.train_delays[6089]["delay"] == 5
    assert app.train_delays[6089]["delay_seconds"] == 270
    assert app.trains_registry[6089]["delay"] == 5


def test_fleet_punctuality_calculation_with_mixed_delays():
    """Verify delayed_count and punctuality_pct calculation across fleet."""
    now = 1700000000.0
    now_iso = datetime.fromtimestamp(now, tz=timezone.utc).isoformat()

    # Pre-seed delays: train 100 has 0 delay, 101 has 3m delay, 102 has 0 delay, 103 has 6m delay
    app.train_delays[101] = {"delay": 3, "delay_seconds": 180, "updated_at": now}
    app.train_delays[103] = {"delay": 6, "delay_seconds": 360, "updated_at": now}

    gps_xml = _build_trein_xml([
        {"trein_nummer": "100", "cabs": [{"lat": "52.0", "lng": "5.0", "gps_time": now_iso}]},
        {"trein_nummer": "101", "cabs": [{"lat": "52.1", "lng": "5.1", "gps_time": now_iso}]},
        {"trein_nummer": "102", "cabs": [{"lat": "52.2", "lng": "5.2", "gps_time": now_iso}]},
        {"trein_nummer": "103", "cabs": [{"lat": "52.3", "lng": "5.3", "gps_time": now_iso}]},
    ])

    app._parse_ndov_xml(gps_xml, now)
    assert app.trains_state["count"] == 4
    # 2 out of 4 trains are delayed
    assert app.trains_state["delayed_count"] == 2
    assert app.trains_state["punctuality_pct"] == 50
    assert app.trains_registry[101]["delay"] == 3
    assert app.trains_registry[103]["delay"] == 6
    assert app.trains_registry[100]["delay"] == 0
    assert app.trains_registry[102]["delay"] == 0

