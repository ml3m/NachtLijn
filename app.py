"""Real-time Dutch railway tracker – FastAPI backend."""

import asyncio
import gzip
import json
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
journey_cache: Dict[int, tuple[float, dict]] = {}     # train_id -> (timestamp, data)
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
                    changed = False
                    for loc in root.findall(".//{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}TreinLocation"):
                        nr_el = loc.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}TreinNummer")
                        if nr_el is None or not nr_el.text:
                            continue
                        tid = int(nr_el.text)
                        for part in loc.findall(".//{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}TreinMaterieelDelen"):
                            lat_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}Latitude")
                            lng_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}Longitude")
                            spd_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}Snelheid")
                            hdg_el = part.find("{http://schemas.datacontract.org/2004/07/Cognos.Infrastructure.Models}Richting")
                            if lat_el is not None and lng_el is not None and lat_el.text and lng_el.text:
                                try:
                                    lat = float(lat_el.text)
                                    lng = float(lng_el.text)
                                    speed = float(spd_el.text) if spd_el is not None and spd_el.text else 0.0
                                    heading = float(hdg_el.text) if hdg_el is not None and hdg_el.text else 0.0
                                    t_type = "IC" if (tid < 4000 or (11000 <= tid < 14000)) else ("SPR" if (tid < 10000 or (20000 <= tid < 30000)) else "other")
                                    trains_registry[tid] = {
                                        "id": tid,
                                        "lat": lat,
                                        "lng": lng,
                                        "speed": speed,
                                        "heading": heading,
                                        "type": t_type,
                                        "source": "NDOV-ZMQ",
                                        "last_seen": now
                                    }
                                    changed = True
                                except ValueError:
                                    pass
                                break

                    # Prune trains not seen for > 80s
                    cutoff = now - 80
                    for tid in list(trains_registry.keys()):
                        if trains_registry[tid]["last_seen"] < cutoff:
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


@app.get("/api/health")
async def health_check():
    push_active = (time.time() - last_zmq_msg_time) < 15.0 if last_zmq_msg_time > 0 else False
    return {
        "status": "healthy",
        "app": "NachtLijn",
        "trains_tracked": len(trains_state),
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


@app.get("/api/journey/{train_id}")
async def api_journey(train_id: int):
    now = time.time()
    if train_id in journey_cache and (now - journey_cache[train_id][0]) < 30:
        return JSONResponse(journey_cache[train_id][1])

    async with httpx.AsyncClient(http2=False) as client:
        data = await _fetch_json(client, "/reisinformatie-api/api/v2/journey", params={"train": train_id})
        if not data or "payload" not in data:
            return JSONResponse({"error": f"Journey data not found for train {train_id}"}, status_code=404)

        payload = data["payload"]
        raw_stops = payload.get("stops", [])
        parsed_stops = []
        operator_name = ""
        category_name = ""

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
            track = dep.get("actualTrack") or dep.get("plannedTrack") or arr.get("actualTrack") or arr.get("plannedTrack") or ""
            t_iso = actual_dep or planned_dep or actual_arr or planned_arr or ""

            parsed_stops.append({
                "id": s.get("id"),
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
                "cancelled": arr.get("cancelled", False) or dep.get("cancelled", False),
            })

        origin = parsed_stops[0]["name"] if parsed_stops else ""
        destination = parsed_stops[-1]["name"] if parsed_stops else ""

        # Identify next stop where train heads to based on current timestamp
        from datetime import datetime

        next_idx = None
        for idx, st in enumerate(parsed_stops):
            if st["time_iso"]:
                try:
                    dt = datetime.fromisoformat(st["time_iso"])
                    now_tz = datetime.now(dt.tzinfo)
                    if dt >= now_tz:
                        next_idx = idx
                        break
                except Exception:
                    pass

        # If all stops are in the past, train is at or approaching final destination
        if next_idx is None and parsed_stops:
            next_idx = len(parsed_stops) - 1

        for idx, st in enumerate(parsed_stops):
            if next_idx is not None:
                if idx < next_idx:
                    st["state"] = "passed"
                elif idx == next_idx:
                    st["state"] = "next"
                else:
                    st["state"] = "upcoming"
            else:
                st["state"] = "upcoming"

        next_stop = parsed_stops[next_idx] if next_idx is not None and next_idx < len(parsed_stops) else None
        current_delay = next_stop["delay_minutes"] if next_stop else 0

        stock_info = payload.get("actualStock") or payload.get("plannedStock") or {}
        train_parts = stock_info.get("trainParts", [])
        image_url = None
        if train_parts and train_parts[0].get("image"):
            image_url = train_parts[0]["image"].get("uri")

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
            "stops": parsed_stops,
        }
        journey_cache[train_id] = (now, result)
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

            track = d.get("actualTrack") or d.get("plannedTrack") or ""
            
            parsed_deps.append({
                "direction": d.get("direction", ""),
                "category": prod.get("categoryCode", "TRAIN"),
                "category_name": prod.get("shortCategoryName", prod.get("categoryCode", "")),
                "number": prod.get("number", ""),
                "planned_time": planned_hhmm,
                "actual_time": actual_hhmm,
                "delay_minutes": delay_min,
                "track": track,
                "cancelled": d.get("cancelled", False),
                "messages": [m.get("message", "") for m in d.get("messages", []) if m.get("message")]
            })

        result = {"station": code, "departures": parsed_deps}
        departures_cache[code] = (now, result)
        return JSONResponse(result)
