"""Real-time Dutch railway tracker – FastAPI backend."""

import asyncio
import gzip
import json
import math
import os
import time
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any

import httpx
import zmq
import zmq.asyncio
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import StreamingResponse

load_dotenv()

API_KEY = os.getenv("NS_API_KEY", "")
BASE = "https://gateway.apiportal.ns.nl"
HEADERS = {"Ocp-Apim-Subscription-Key": API_KEY}
DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
TRACKS_FILE = DATA_DIR / "tracks.geojson"
STATIONS_FILE = DATA_DIR / "stations.json"
BORDER_FILE = DATA_DIR / "netherlands_border.geojson"
POLL_INTERVAL = 5  # seconds (safe 12 req/min, well under 60 req/min limit)

# ── Shared state ─────────────────────────────────────────────────
tracks_cache: dict | None = None
stations_cache: list | None = None
border_cache: dict | None = None

# Preload disk caches immediately so API endpoints never return 503 on first load
try:
    if TRACKS_FILE.exists():
        tracks_cache = json.loads(TRACKS_FILE.read_text(encoding="utf-8"))
    if STATIONS_FILE.exists():
        stations_cache = json.loads(STATIONS_FILE.read_text(encoding="utf-8"))
    if BORDER_FILE.exists():
        border_cache = json.loads(BORDER_FILE.read_text(encoding="utf-8"))
except Exception:
    pass
trains_state: dict = {
    "timestamp": 0,
    "next_update_at": 0,
    "count": 0,
    "counts": {"IC": 0, "SPR": 0, "other": 0},
    "status": "starting",
    "trains": [],
}
disruptions_state: dict = {
    "timestamp": 0,
    "count": 0,
    "disruptions": [],
}
# Short TTL in-memory caches for interactive user requests
journey_cache: Dict[str, tuple[float, dict]] = {}     # cache key -> (timestamp, data)
departures_cache: Dict[str, tuple[float, list]] = {}  # station_code -> (timestamp, data)

_backoff: float = 0
_poll_task: asyncio.Task | None = None
_zmq_task: asyncio.Task | None = None
_listeners: set[asyncio.Queue] = set()
trains_registry: dict[int, dict] = {}


async def _broadcast_trains(data: dict):
    for q in list(_listeners):
        try:
            if q.full():
                try:
                    q.get_nowait()
                except Exception:
                    pass
            q.put_nowait(data)
        except Exception:
            pass


# ── Helpers ──────────────────────────────────────────────────────
def _parse_train(t: dict) -> dict | None:
    try:
        lat = float(t["lat"])
        lng = float(t["lng"])
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return None
        return {
            "id": int(t["treinNummer"]),
            "lat": lat,
            "lng": lng,
            "speed": float(t.get("snelheid", 0)),
            "heading": float(t.get("richting", 0)),
            "type": str(t.get("type", "?")),
            "source": str(t.get("bron", "")),
        }
    except (KeyError, ValueError, TypeError):
        return None


async def _fetch_json(client: httpx.AsyncClient, path: str, params: dict | None = None) -> dict | list | None:
    try:
        r = await client.get(f"{BASE}{path}", headers=HEADERS, params=params, timeout=12)
        if r.status_code == 429:
            return None
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


async def _ensure_tracks(client: httpx.AsyncClient) -> dict | None:
    global tracks_cache
    if TRACKS_FILE.exists():
        tracks_cache = json.loads(TRACKS_FILE.read_text())
        return tracks_cache
    data = await _fetch_json(client, "/spoorkaart-api/api/v1/spoorkaart")
    if data and "payload" in data:
        tracks_cache = data["payload"]
        TRACKS_FILE.write_text(json.dumps(tracks_cache))
        return tracks_cache
    return None


_track_index_cache: dict[str, list[list[float]]] | None = None


def _get_track_index() -> dict[str, list[list[float]]]:
    global _track_index_cache
    if _track_index_cache is not None:
        return _track_index_cache
    _track_index_cache = {}
    if TRACKS_FILE.exists():
        try:
            geo = json.loads(TRACKS_FILE.read_text(encoding="utf-8"))
            for feat in geo.get("features", []):
                props = feat.get("properties", {})
                f = (props.get("from") or "").lower()
                t = (props.get("to") or "").lower()
                geom = feat.get("geometry", {})
                coords = geom.get("coordinates", [])
                if f and t and coords:
                    latlngs = [[c[1], c[0]] for c in coords]
                    _track_index_cache[f"{f}_{t}"] = latlngs
                    _track_index_cache[f"{t}_{f}"] = list(reversed(latlngs))
        except Exception:
            pass
    return _track_index_cache


def _build_route_geometry(route_stations: list[dict]) -> list[list[float]]:
    track_idx = _get_track_index()
    geometry: list[list[float]] = []
    for i in range(len(route_stations) - 1):
        s1 = route_stations[i]
        s2 = route_stations[i + 1]
        c1_code = s1.get("code", "")
        c2_code = s2.get("code", "")
        key = f"{c1_code}_{c2_code}"
        seg_coords = track_idx.get(key)
        if seg_coords:
            if geometry:
                geometry.extend(seg_coords[1:])
            else:
                geometry.extend(seg_coords)
        else:
            p1 = [s1["lat"], s1["lng"]] if s1.get("lat") and s1.get("lng") else None
            p2 = [s2["lat"], s2["lng"]] if s2.get("lat") and s2.get("lng") else None
            if p1 and p2:
                if not geometry:
                    geometry.append(p1)
                geometry.append(p2)
    return geometry


async def _ensure_stations(client: httpx.AsyncClient) -> list | None:
    global stations_cache
    if STATIONS_FILE.exists():
        stations_cache = json.loads(STATIONS_FILE.read_text())
        return stations_cache
    data = await _fetch_json(client, "/reisinformatie-api/api/v2/stations")
    if data and "payload" in data:
        raw = data["payload"]
        parsed = []
        for s in raw:
            try:
                parsed.append({
                    "code": s["code"],
                    "name": s.get("namen", {}).get("lang", s.get("code", "")),
                    "lat": float(s["lat"]),
                    "lng": float(s["lng"]),
                    "type": s.get("stationType", ""),
                    "country": s.get("land", ""),
                })
            except (KeyError, ValueError, TypeError):
                continue
        stations_cache = parsed
        STATIONS_FILE.write_text(json.dumps(parsed))
        return stations_cache
    return None


async def _poll_trains(client: httpx.AsyncClient):
    global _backoff, trains_state
    data = await _fetch_json(client, "/virtual-train-api/api/vehicle")
    if data and "payload" in data:
        raw = data["payload"].get("treinen", [])
        parsed = [t for t in ((_parse_train(r)) for r in raw) if t is not None]
        now = time.time()
        
        ic_count = sum(1 for t in parsed if t["type"] in ("IC", "ICE"))
        spr_count = sum(1 for t in parsed if t["type"] == "SPR")
        other_count = len(parsed) - ic_count - spr_count

        trains_state = {
            "timestamp": now,
            "next_update_at": now + POLL_INTERVAL,
            "count": len(parsed),
            "counts": {"IC": ic_count, "SPR": spr_count, "other": other_count},
            "status": "live",
            "feed": "NS REST Gateway (Fallback)",
            "trains": parsed,
        }
        _backoff = 0
        await _broadcast_trains(trains_state)
    else:
        _backoff = min(max(_backoff * 2, 2), 120)
        trains_state["status"] = "stale"
        trains_state["next_update_at"] = time.time() + POLL_INTERVAL + _backoff


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2.0)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2.0)**2
    return 2.0 * R * math.asin(math.sqrt(max(0.0, min(1.0, a))))


def _point_to_segment_dist_and_t(plat: float, plon: float, s1lat: float, s1lon: float, s2lat: float, s2lon: float) -> tuple[float, float]:
    mean_lat = math.radians((s1lat + s2lat) / 2.0)
    cos_lat = math.cos(mean_lat)
    x1, y1 = s1lon * cos_lat, s1lat
    x2, y2 = s2lon * cos_lat, s2lat
    px, py = plon * cos_lat, plat
    dx = x2 - x1
    dy = y2 - y1
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq == 0:
        return _haversine_km(plat, plon, s1lat, s1lon), 0.0
    t = ((px - x1) * dx + (py - y1) * dy) / seg_len_sq
    t_clamped = max(0.0, min(1.0, t))
    proj_lat = y1 + t_clamped * dy
    proj_lon = (x1 + t_clamped * dx) / (cos_lat if cos_lat != 0 else 1.0)
    return _haversine_km(plat, plon, proj_lat, proj_lon), t


def _resolve_journey_station_progress(parsed_stops: list[dict], train_lat: float | None, train_lng: float | None) -> int:
    N = len(parsed_stops)
    if N == 0:
        return 0
    if N == 1:
        parsed_stops[0]["state"] = "next"
        return 0

    # 1. SPATIAL RESOLUTION (Preferred: uses actual physical GPS position)
    if train_lat is not None and train_lng is not None:
        # A. Check if train is directly at/near final destination (within 650m)
        dest_lat, dest_lng = parsed_stops[-1].get("lat"), parsed_stops[-1].get("lng")
        if dest_lat is not None and dest_lng is not None:
            dist_to_dest = _haversine_km(train_lat, train_lng, dest_lat, dest_lng)
            if dist_to_dest <= 0.65:
                for idx in range(N - 1):
                    parsed_stops[idx]["state"] = "passed"
                parsed_stops[-1]["state"] = "next"
                parsed_stops[-1]["at_destination"] = True
                return N - 1

        # B. Check if train is at origin (within 650m of origin and far from destination)
        orig_lat, orig_lng = parsed_stops[0].get("lat"), parsed_stops[0].get("lng")
        if orig_lat is not None and orig_lng is not None:
            dist_to_orig = _haversine_km(train_lat, train_lng, orig_lat, orig_lng)
            if dist_to_orig <= 0.65 and (dest_lat is None or _haversine_km(train_lat, train_lng, dest_lat, dest_lng) > 2.0):
                parsed_stops[0]["state"] = "next"
                parsed_stops[0]["at_origin"] = True
                for idx in range(1, N):
                    parsed_stops[idx]["state"] = "upcoming"
                return 0

        # C. Check if train is dwelling directly at any station (within 450m)
        dwelling_idx = None
        min_dwelling_dist = float("inf")
        for idx, st in enumerate(parsed_stops):
            s_lat, s_lng = st.get("lat"), st.get("lng")
            if s_lat is not None and s_lng is not None:
                d = _haversine_km(train_lat, train_lng, s_lat, s_lng)
                if d < 0.45 and d < min_dwelling_dist:
                    min_dwelling_dist = d
                    dwelling_idx = idx

        if dwelling_idx is not None:
            for idx in range(N):
                if idx < dwelling_idx:
                    parsed_stops[idx]["state"] = "passed"
                elif idx == dwelling_idx:
                    parsed_stops[idx]["state"] = "next"
                    parsed_stops[idx]["at_station"] = True
                else:
                    parsed_stops[idx]["state"] = "upcoming"
            return dwelling_idx

        # D. Match along segment chain S_i -> S_{i+1}
        best_seg_idx = 0
        best_score = float("inf")
        for i in range(N - 1):
            s1, s2 = parsed_stops[i], parsed_stops[i + 1]
            if s1.get("lat") is None or s2.get("lat") is None:
                continue
            dist, t = _point_to_segment_dist_and_t(
                train_lat, train_lng,
                s1["lat"], s1["lng"],
                s2["lat"], s2["lng"]
            )
            # Give priority to valid projections on segment
            penalty = 0.0 if (0.0 <= t <= 1.0) else (dist * 0.6)
            score = dist + penalty
            if score < best_score:
                best_score = score
                best_seg_idx = i

        next_idx = best_seg_idx + 1
        for idx in range(N):
            if idx < next_idx:
                parsed_stops[idx]["state"] = "passed"
            elif idx == next_idx:
                parsed_stops[idx]["state"] = "next"
            else:
                parsed_stops[idx]["state"] = "upcoming"
        return next_idx

    # 2. TEMPORAL UNWRAPPED MINUTES FALLBACK (if GPS is completely absent)
    now_dt = datetime.now()
    now_min = now_dt.hour * 60 + now_dt.minute

    stop_mins = []
    for st in parsed_stops:
        t_str = st.get("time", "")
        if len(t_str) == 5 and t_str[2] == ":":
            try:
                stop_mins.append(int(t_str[:2]) * 60 + int(t_str[3:]))
            except ValueError:
                stop_mins.append(None)
        else:
            stop_mins.append(None)

    unwrapped = []
    last_val = 0
    day_offset = 0
    for m in stop_mins:
        if m is None:
            unwrapped.append(None)
            continue
        if unwrapped and m < last_val - 300:
            day_offset += 1440
        last_val = m
        unwrapped.append(m + day_offset)

    first_valid = next((m for m in unwrapped if m is not None), 0)
    best_offset = 0
    min_delta = float("inf")
    for cand_offset in (-1440, 0, 1440):
        cand_now = now_min + cand_offset
        delta = abs(cand_now - first_valid)
        if delta < min_delta:
            min_delta = delta
            best_offset = cand_offset
    aligned_now = now_min + best_offset

    next_idx = N - 1
    for idx, u in enumerate(unwrapped):
        if u is not None and u >= aligned_now:
            next_idx = idx
            break

    for idx in range(N):
        if idx < next_idx:
            parsed_stops[idx]["state"] = "passed"
        elif idx == next_idx:
            parsed_stops[idx]["state"] = "next"
        else:
            parsed_stops[idx]["state"] = "upcoming"
    return next_idx


last_zmq_msg_time: float = 0.0


async def _ndov_zeromq_consumer():
    global trains_state, trains_registry, last_zmq_msg_time
    while True:
        ctx = zmq.asyncio.Context()
        sock = ctx.socket(zmq.SUB)
        try:
            sock.connect("tcp://pubsub.besteffort.ndovloket.nl:7664")
            sock.setsockopt_string(zmq.SUBSCRIBE, "/RIG/NStreinpositiesInterface5")
            while True:
                try:
                    msg = await asyncio.wait_for(sock.recv_multipart(), timeout=15.0)
                except asyncio.TimeoutError:
                    continue
                if len(msg) < 2:
                    continue
                try:
                    raw_xml = gzip.decompress(msg[1]).decode("utf-8", errors="replace")
                    root = ET.fromstring(raw_xml)
                    now = time.time()
                    last_zmq_msg_time = now
                    now_utc = datetime.now(timezone.utc)
                    changed = False
                    for loc in root.findall(".//{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}TreinLocation"):
                        nr_el = loc.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}TreinNummer")
                        if nr_el is None or not nr_el.text:
                            continue
                        tid = int(nr_el.text)

                        valid_parts = []
                        for part in loc.findall(".//{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}TreinMaterieelDelen"):
                            lat_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}Latitude")
                            lng_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}Longitude")
                            spd_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}Snelheid")
                            hdg_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}Richting")
                            gps_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}GpsDatumTijd")
                            volg_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}MaterieelDeelVolgorde")
                            mat_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}MaterieelNummer")

                            if lat_el is not None and lng_el is not None and lat_el.text and lng_el.text:
                                try:
                                    p_lat = float(lat_el.text)
                                    p_lng = float(lng_el.text)
                                    if not (50.5 <= p_lat <= 54.0 and 2.5 <= p_lng <= 7.5):
                                        continue
                                    p_spd = float(spd_el.text) if spd_el is not None and spd_el.text else 0.0
                                    p_hdg = float(hdg_el.text) if hdg_el is not None and hdg_el.text else 0.0
                                    p_gps_str = gps_el.text.strip() if gps_el is not None and gps_el.text else ""

                                    p_gps_age = 0.0
                                    p_gps_epoch = 0.0
                                    if p_gps_str:
                                        try:
                                            p_dt = datetime.fromisoformat(p_gps_str.replace("Z", "+00:00"))
                                            p_gps_age = (now_utc - p_dt).total_seconds()
                                            p_gps_epoch = p_dt.timestamp()
                                        except Exception:
                                            p_gps_age = 999.0
                                    else:
                                        p_gps_age = 999.0

                                    # Reject fixes older than 75s or future clock-skew fixes > 15s
                                    if p_gps_age > 75.0 or p_gps_age < -15.0:
                                        continue

                                    volg = int(volg_el.text) if volg_el is not None and volg_el.text and volg_el.text.isdigit() else 1
                                    matnr = int(mat_el.text) if mat_el is not None and mat_el.text and mat_el.text.isdigit() else 0

                                    valid_parts.append({
                                        "lat": p_lat,
                                        "lng": p_lng,
                                        "speed": p_spd,
                                        "heading": p_hdg,
                                        "gps_str": p_gps_str,
                                        "gps_age": p_gps_age,
                                        "gps_epoch": p_gps_epoch,
                                        "volgorde": volg,
                                        "matnr": matnr,
                                    })
                                except ValueError:
                                    continue

                        if not valid_parts:
                            continue

                        # Deterministic cab unit selection: sort by volgorde and matnr
                        # This permanently eliminates multi-unit front/rear cab bouncing
                        valid_parts.sort(key=lambda p: (p["volgorde"], p["matnr"]))
                        chosen = valid_parts[0]

                        lat = chosen["lat"]
                        lng = chosen["lng"]
                        speed = chosen["speed"]
                        heading = chosen["heading"]
                        gps_str = chosen["gps_str"]
                        gps_epoch = chosen["gps_epoch"]

                        # Sanity checks against previous fix for this train
                        prev = trains_registry.get(tid)
                        if prev:
                            # Drop out-of-order stale packets
                            if gps_epoch > 0 and prev.get("gps_epoch", 0) > 0 and gps_epoch < prev["gps_epoch"]:
                                continue

                            dist_m = _haversine_km(lat, lng, prev["lat"], prev["lng"]) * 1000.0
                            time_delta = now - prev.get("last_seen", now)

                            # Supersonic teleport check: drop glitches (> 3.5km in < 30s implies > 420 km/h)
                            if time_delta < 30.0 and dist_m > 3500.0:
                                continue

                            # Zero-movement detection: stationary train
                            if dist_m < 5.0 and time_delta >= 5.0:
                                speed = 0.0

                        if speed < 1.5:
                            speed = 0.0

                        t_type = "IC" if (tid < 4000 or (11000 <= tid < 14000)) else ("SPR" if (tid < 10000 or (20000 <= tid < 30000)) else "other")
                        trains_registry[tid] = {
                            "id": tid,
                            "lat": lat,
                            "lng": lng,
                            "speed": speed,
                            "heading": heading,
                            "type": t_type,
                            "source": "NDOV-ZMQ",
                            "gps_time": gps_str,
                            "gps_epoch": gps_epoch,
                            "last_seen": now
                        }
                        changed = True

                    # Prune trains not seen or with stale GPS > 80s
                    cutoff = now - 80
                    for tid in list(trains_registry.keys()):
                        t_item = trains_registry[tid]
                        if t_item["last_seen"] < cutoff:
                            del trains_registry[tid]

                    if changed and trains_registry:
                        t_list = list(trains_registry.values())
                        ic_c = sum(1 for t in t_list if t["type"] in ("IC", "ICE"))
                        spr_c = sum(1 for t in t_list if t["type"] == "SPR")
                        oth_c = len(t_list) - ic_c - spr_c
                        trains_state = {
                            "timestamp": now,
                            "next_update_at": now + 4,
                            "count": len(t_list),
                            "counts": {"IC": ic_c, "SPR": spr_c, "other": oth_c},
                            "status": "live",
                            "feed": "NDOV ZeroMQ Push",
                            "trains": t_list,
                        }
                        await _broadcast_trains(trains_state)
                except Exception:
                    pass
        except Exception:
            await asyncio.sleep(4)
        finally:
            sock.close()
            ctx.term()


async def _poll_disruptions(client: httpx.AsyncClient):
    global disruptions_state
    data = await _fetch_json(client, "/disruptions/v3")
    if isinstance(data, list):
        parsed = []
        for d in data:
            if not d.get("isActive", True):
                continue
            sections = []
            for pub in d.get("publicationSections", []):
                sec = pub.get("section", {})
                st_list = sec.get("stations", [])
                coords = []
                for s in st_list:
                    c = s.get("coordinate", {})
                    if c.get("lat") and c.get("lng"):
                        coords.append({
                            "name": s.get("name"),
                            "code": s.get("stationCode"),
                            "lat": float(c["lat"]),
                            "lng": float(c["lng"])
                        })
                if len(coords) >= 2:
                    sections.append(coords)
            
            ts = d.get("timespans", [{}])[0] if d.get("timespans") else {}
            parsed.append({
                "id": str(d.get("id")),
                "title": d.get("title", ""),
                "type": d.get("type", "DISRUPTION"),
                "cause": ts.get("cause", {}).get("label", ""),
                "situation": ts.get("situation", {}).get("label", ""),
                "period": ts.get("period", ""),
                "delay": d.get("summaryAdditionalTravelTime", {}).get("label", ""),
                "sections": sections
            })
        disruptions_state = {
            "timestamp": time.time(),
            "count": len(parsed),
            "disruptions": parsed
        }


async def _background_poller():
    global _backoff
    disr_ticks = 0
    async with httpx.AsyncClient(http2=False) as client:
        await _ensure_tracks(client)
        await _ensure_stations(client)
        await _poll_disruptions(client)
        while True:
            # Fall back to REST vehicle endpoint only when ZeroMQ has been quiet for > 15s
            if (time.time() - last_zmq_msg_time) >= 15.0:
                await _poll_trains(client)
            disr_ticks += 1
            if disr_ticks >= 12:  # refresh disruptions every ~60s (12 * 5s)
                await _poll_disruptions(client)
                disr_ticks = 0
            await asyncio.sleep(POLL_INTERVAL + _backoff)


# ── Lifespan ─────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _poll_task, _zmq_task
    _poll_task = asyncio.create_task(_background_poller())
    _zmq_task = asyncio.create_task(_ndov_zeromq_consumer())
    yield
    _poll_task.cancel()
    _zmq_task.cancel()
    try:
        await asyncio.gather(_poll_task, _zmq_task, return_exceptions=True)
    except Exception:
        pass


# ── App ──────────────────────────────────────────────────────────
app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=500)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/api/stream")
async def api_stream(request: Request):
    async def event_generator():
        q: asyncio.Queue = asyncio.Queue(maxsize=10)
        _listeners.add(q)
        yield f"data: {json.dumps(trains_state)}\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            _listeners.discard(q)
    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/api/health")
async def health_check():
    push_active = (time.time() - last_zmq_msg_time) < 15.0 if last_zmq_msg_time > 0 else False
    return {
        "status": "healthy",
        "app": "NachtLijn",
        "trains_tracked": len(trains_state.get("trains", [])),
        "feed_mode": "zeromq_push" if push_active else "ns_polling",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/")
async def index():
    return FileResponse("templates/index.html", media_type="text/html")


@app.get("/api/tracks")
async def api_tracks():
    if tracks_cache is None:
        return JSONResponse({"error": "tracks not loaded yet"}, status_code=503)
    return JSONResponse(tracks_cache)


@app.get("/api/trains")
async def api_trains():
    return JSONResponse(trains_state)


@app.get("/api/stations")
async def api_stations():
    if stations_cache is None:
        return JSONResponse({"error": "stations not loaded yet"}, status_code=503)
    return JSONResponse(stations_cache)


def _load_border():
    global border_cache
    if BORDER_FILE.exists():
        try:
            border_cache = json.loads(BORDER_FILE.read_text(encoding="utf-8"))
            return border_cache
        except Exception:
            pass
    return None


@app.get("/api/border")
async def api_border():
    global border_cache
    if border_cache is None:
        _load_border()
    if border_cache is None:
        return JSONResponse({"error": "border data not found"}, status_code=404)
    return JSONResponse(border_cache)


@app.get("/api/disruptions")
async def api_disruptions():
    return JSONResponse(disruptions_state)


# ── Rail Weather & Wind Corridor Monitoring ────────────────────────
weather_cache: dict | None = None
weather_cache_time: float = 0.0

WEATHER_CORRIDORS = [
    {"id": "ut", "name": "Utrecht Knooppunt", "corridor": "Centraal Netwerk", "lat": 52.09, "lng": 5.12},
    {"id": "ams", "name": "Schiphol & Amsterdam", "corridor": "Kust & Schiphollijn", "lat": 52.37, "lng": 4.90},
    {"id": "hsl", "name": "HSL-Zuid & Moerdijkbrug", "corridor": "Hogesnelheidslijn", "lat": 51.70, "lng": 4.63},
    {"id": "zee", "name": "Zeeland & Westerschelde", "corridor": "Kust & Vlissingenlijn", "lat": 51.50, "lng": 3.61},
    {"id": "arn", "name": "Arnhem & Betuweroute", "corridor": "Oost Corridor & ICE", "lat": 51.98, "lng": 5.91},
    {"id": "ein", "name": "Eindhoven & Brabant", "corridor": "Zuidelijke As", "lat": 51.44, "lng": 5.48},
    {"id": "zwo", "name": "Zwolle & Noord-Nederland", "corridor": "Noordelijke Spoorlijnen", "lat": 53.00, "lng": 6.55},
]


def _wmo_to_condition(code: int) -> tuple[str, str]:
    if code == 0:
        return "Helder", "☀️"
    elif code in (1, 2):
        return "Licht bewolkt", "⛅"
    elif code == 3:
        return "Bewolkt", "☁️"
    elif code in (45, 48):
        return "Mist / Nevel", "🌫️"
    elif code in (51, 53, 55, 61, 63, 65, 80, 81, 82):
        return "Regen", "🌧️"
    elif code in (71, 73, 75, 77, 85, 86):
        return "Sneeuwval", "❄️"
    elif code in (95, 96, 99):
        return "Onweer & Bliksem", "⛈️"
    return "Wisselvallig", "🌤️"


@app.get("/api/weather")
async def api_weather():
    global weather_cache, weather_cache_time
    now = time.time()
    if weather_cache and (now - weather_cache_time) < 600:
        return JSONResponse(weather_cache)

    try:
        lats = ",".join(str(c["lat"]) for c in WEATHER_CORRIDORS)
        lngs = ",".join(str(c["lng"]) for c in WEATHER_CORRIDORS)
        url = (
            f"https://api.open-meteo.com/v1/forecast"
            f"?latitude={lats}&longitude={lngs}"
            f"&current=temperature_2m,wind_speed_10m,wind_gusts_10m,weather_code"
        )
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(url)
            if r.status_code == 200:
                raw = r.json()
                if not isinstance(raw, list):
                    raw = [raw]
                corridors = []
                for i, meta in enumerate(WEATHER_CORRIDORS):
                    curr = raw[i].get("current", {}) if i < len(raw) else {}
                    t = float(curr.get("temperature_2m", 10.0))
                    ws = float(curr.get("wind_speed_10m", 15.0))
                    wg = float(curr.get("wind_gusts_10m", ws * 1.3))
                    code = int(curr.get("weather_code", 1))
                    cond_name, cond_icon = _wmo_to_condition(code)

                    if wg >= 75:
                        impact = "⚠️ Stormwindstoten: snelheidsbeperking mogelijk op viaducten & HSL"
                        risk = "high"
                    elif wg >= 55:
                        impact = "🌬️ Krachtige wind: verhoogde waakzaamheid bovenleiding"
                        risk = "medium"
                    elif t <= 0:
                        impact = "❄️ Vorst & Rijp: risico op wisselstoringen en rijdraadijsafzetting"
                        risk = "medium"
                    else:
                        impact = "🟢 Gunstige spoor- & weercondities"
                        risk = "low"

                    corridors.append({
                        "id": meta["id"],
                        "name": meta["name"],
                        "corridor": meta["corridor"],
                        "lat": meta["lat"],
                        "lng": meta["lng"],
                        "temp_c": round(t, 1),
                        "wind_kmh": round(ws, 0),
                        "wind_gusts_kmh": round(wg, 0),
                        "condition": cond_name,
                        "icon": cond_icon,
                        "advisory": impact,
                        "risk_level": risk
                    })

                weather_cache = {
                    "timestamp": now,
                    "count": len(corridors),
                    "corridors": corridors
                }
                weather_cache_time = now
                return JSONResponse(weather_cache)
    except Exception:
        pass

    if weather_cache:
        return JSONResponse(weather_cache)
    return JSONResponse({"timestamp": now, "count": 0, "corridors": []})


@app.get("/api/journey/{train_id}")
async def api_journey(train_id: int, lat: float | None = None, lng: float | None = None):
    # Lookup live GPS position from active registry if not provided in query
    if (lat is None or lng is None) and train_id in trains_registry:
        live_t = trains_registry[train_id]
        lat = live_t.get("lat")
        lng = live_t.get("lng")

    now = time.time()
    cache_key = f"{train_id}_{round(lat or 0, 3)}_{round(lng or 0, 3)}"
    if cache_key in journey_cache and (now - journey_cache[cache_key][0]) < 12:
        return JSONResponse(journey_cache[cache_key][1])

    async with httpx.AsyncClient(http2=False) as client:
        data = await _fetch_json(client, "/reisinformatie-api/api/v2/journey", params={"train": train_id})
        if not data or "payload" not in data:
            return JSONResponse({"error": f"Journey data not found for train {train_id}"}, status_code=404)

        payload = data["payload"]
        raw_stops = payload.get("stops", [])
        parsed_stops = []
        operator_name = ""
        category_name = ""

        route_stations = []
        for s in raw_stops:
            st_info = s.get("stop", {})
            code = (s.get("id", "").split("_")[0] or st_info.get("stationCode", "")).lower()
            lat_val = st_info.get("lat")
            lng_val = st_info.get("lng")
            if code:
                route_stations.append({
                    "code": code,
                    "name": st_info.get("name", ""),
                    "lat": float(lat_val) if lat_val is not None else None,
                    "lng": float(lng_val) if lng_val is not None else None,
                    "status": s.get("status", ""),
                })

        route_geometry = _build_route_geometry(route_stations)

        for s in raw_stops:
            st_info = s.get("stop", {})
            arr = s.get("arrivals", [{}])[0] if s.get("arrivals") else {}
            dep = s.get("departures", [{}])[0] if s.get("departures") else {}
            prod = dep.get("product") or arr.get("product") or {}
            if prod:
                operator_name = operator_name or prod.get("operatorName", "")
                category_name = category_name or prod.get("longCategoryName") or prod.get("shortCategoryName") or ""

            planned_arr = arr.get("plannedTime")
            actual_arr = arr.get("actualTime")
            planned_dep = dep.get("plannedTime")
            actual_dep = dep.get("actualTime")

            # Remove all stations where the train does not stop (skipped stations)
            if not (planned_arr or planned_dep):
                continue

            delay = dep.get("delayInSeconds") if dep.get("delayInSeconds") is not None else arr.get("delayInSeconds", 0)
            planned_track = dep.get("plannedTrack") or arr.get("plannedTrack") or ""
            actual_track = dep.get("actualTrack") or arr.get("actualTrack") or planned_track
            track_changed = bool(actual_track and planned_track and actual_track != planned_track)
            track = actual_track or planned_track or ""
            t_iso = actual_dep or planned_dep or actual_arr or planned_arr or ""
            st_code = (s.get("id", "").split("_")[0] or st_info.get("stationCode", "")).lower()

            parsed_stops.append({
                "id": s.get("id"),
                "code": st_code,
                "name": st_info.get("name", ""),
                "lat": st_info.get("lat"),
                "lng": st_info.get("lng"),
                "status": "STOP",
                "planned_arrival": planned_arr,
                "actual_arrival": actual_arr,
                "planned_departure": planned_dep,
                "actual_departure": actual_dep,
                "time_iso": t_iso,
                "time": t_iso[11:16] if len(t_iso) >= 16 else "",
                "delay_minutes": round((delay or 0) / 60),
                "track": track,
                "planned_track": planned_track,
                "actual_track": actual_track,
                "track_changed": track_changed,
                "cancelled": arr.get("cancelled", False) or dep.get("cancelled", False),
            })

        origin = parsed_stops[0]["name"] if parsed_stops else ""
        destination = parsed_stops[-1]["name"] if parsed_stops else ""

        # Robust spatial & timeline progress resolution
        next_idx = _resolve_journey_station_progress(parsed_stops, lat, lng)
        next_stop = parsed_stops[next_idx] if next_idx is not None and next_idx < len(parsed_stops) else None
        current_delay = next_stop["delay_minutes"] if next_stop else 0

        stock_info = payload.get("actualStock") or payload.get("plannedStock") or {}
        train_parts = stock_info.get("trainParts", [])
        image_url = None
        if train_parts and train_parts[0].get("image"):
            image_url = train_parts[0]["image"].get("uri")

        composition = []
        for p in train_parts:
            composition.append({
                "identifier": p.get("stockIdentifier", ""),
                "type": p.get("stockType", stock_info.get("trainType", "")),
                "facilities": p.get("facilities", []),
                "image": p.get("image", {}).get("uri") if p.get("image") else None,
            })

        result = {
            "train_id": train_id,
            "origin": origin,
            "destination": destination,
            "next_stop": next_stop,
            "current_delay": current_delay,
            "operator": operator_name or "NS",
            "category_name": category_name,
            "train_type": stock_info.get("trainType", ""),
            "seats": stock_info.get("numberOfSeats", 0),
            "parts": stock_info.get("numberOfParts", 0),
            "image_url": image_url,
            "composition": composition,
            "stops": parsed_stops,
            "route_stations": route_stations,
            "route_geometry": route_geometry,
        }
        journey_cache[cache_key] = (now, result)
        return JSONResponse(result)


@app.get("/api/departures/{station_code}")
async def api_departures(station_code: str):
    code = station_code.upper()
    now = time.time()
    if code in departures_cache and (now - departures_cache[code][0]) < 20:
        return JSONResponse(departures_cache[code][1])

    async with httpx.AsyncClient(http2=False) as client:
        data = await _fetch_json(client, "/reisinformatie-api/api/v2/departures", params={"station": code, "maxJourneys": 15})
        if not data or "payload" not in data:
            return JSONResponse({"station": code, "departures": []})

        deps_raw = data["payload"].get("departures", [])
        parsed_deps = []
        for d in deps_raw:
            prod = d.get("product", {})
            planned_dt = d.get("plannedDateTime", "")
            actual_dt = d.get("actualDateTime", "")
            
            # Extract simple time string HH:MM
            planned_hhmm = planned_dt[11:16] if len(planned_dt) >= 16 else ""
            actual_hhmm = actual_dt[11:16] if len(actual_dt) >= 16 else ""
            
            delay_min = 0
            if planned_hhmm and actual_hhmm and planned_hhmm != actual_hhmm:
                try:
                    p_min = int(planned_hhmm[:2]) * 60 + int(planned_hhmm[3:5])
                    a_min = int(actual_hhmm[:2]) * 60 + int(actual_hhmm[3:5])
                    diff = a_min - p_min
                    if diff < -700:  # midnight wrap
                        diff += 1440
                    delay_min = max(0, diff)
                except Exception:
                    pass

            planned_track = d.get("plannedTrack") or ""
            actual_track = d.get("actualTrack") or planned_track
            track_changed = bool(actual_track and planned_track and actual_track != planned_track)
            track = actual_track or planned_track or ""
            
            parsed_deps.append({
                "direction": d.get("direction", ""),
                "category": prod.get("categoryCode", "TRAIN"),
                "category_name": prod.get("shortCategoryName", prod.get("categoryCode", "")),
                "number": prod.get("number", ""),
                "planned_time": planned_hhmm,
                "actual_time": actual_hhmm,
                "delay_minutes": delay_min,
                "track": track,
                "planned_track": planned_track,
                "actual_track": actual_track,
                "track_changed": track_changed,
                "cancelled": d.get("cancelled", False),
                "messages": [m.get("message", "") for m in d.get("messages", []) if m.get("message")]
            })

        result = {"station": code, "departures": parsed_deps}
        departures_cache[code] = (now, result)
        return JSONResponse(result)
