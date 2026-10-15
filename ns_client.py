"""
NS API Client for Python
A modern, unified wrapper for the Nederlandse Spoorwegen (NS) APIs:
- Virtual Train API (Live GPS train tracking, speeds, headings)
- SpoorKaart API (Track network GeoJSON geometry)
- Reisinformatie API (Stations, live departures, journey details, trip planning)
- Disruptions API v3 (Real-time disruptions and engineering works)
- Places API (Station amenities & POIs)
"""

import os
from typing import Dict, Any, List, Optional
import requests

DEFAULT_GATEWAY = "https://gateway.apiportal.ns.nl"

class NSClient:
    def __init__(self, subscription_key: Optional[str] = None):
        """
        Initialize the NS Client with an API subscription key.
        If not provided, attempts to read from NS_PRIMARY_KEY or NS_API_KEY environment variable,
        or falls back to the .env file in the same directory.
        """
        self.key = subscription_key or os.environ.get("NS_PRIMARY_KEY") or os.environ.get("NS_API_KEY")
        if not self.key:
            env_path = os.path.join(os.path.dirname(__file__), ".env")
            if os.path.exists(env_path):
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("NS_PRIMARY_KEY="):
                            self.key = line.split("=", 1)[1].strip()
                            break

        if not self.key:
            raise ValueError("NS API Subscription Key required. Set NS_PRIMARY_KEY or pass it to NSClient(key).")

        self.session = requests.Session()
        self.session.headers.update({
            "Ocp-Apim-Subscription-Key": self.key,
            "User-Agent": "NS-Visualization-Client/1.0"
        })

    def _get(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{DEFAULT_GATEWAY}{endpoint}"
        resp = self.session.get(url, params=params, timeout=15)
        resp.raise_for_status()
        return resp.json()

    # -------------------------------------------------------------
    # Virtual Train API (Live GPS positions & Telemetry)
    # -------------------------------------------------------------
    def get_system_status(self) -> Dict[str, Any]:
        """Fetch tracking system status and active train counts."""
        return self._get("/virtual-train-api/v1/status")

    def get_live_trains(self) -> List[Dict[str, Any]]:
        """
        Fetch real-time coordinates, speed, and heading of all active trains in the Netherlands.
        Each item contains:
            - treinNummer (int): Train number (e.g., 3583)
            - lat (float): Current latitude
            - lng (float): Current longitude
            - snelheid (float): Speed in km/h
            - richting (float): Compass heading in degrees (0-360)
            - type (str): 'IC', 'SPR', etc.
            - bron (str): Telemetry source ('OBIS')
        """
        data = self._get("/virtual-train-api/api/vehicle")
        return data.get("payload", {}).get("treinen", [])

    def get_train_prognosis(self, train_number: int) -> List[Dict[str, Any]]:
        """Fetch arrival/delay prognosis classifications for a specific train."""
        data = self._get(f"/virtual-train-api/api/v1/prognose/{train_number}")
        return data.get("prognoses", [])

    # -------------------------------------------------------------
    # SpoorKaart API (Track Geometry GeoJSON)
    # -------------------------------------------------------------
    def get_track_geojson(self) -> Dict[str, Any]:
        """
        Fetch the complete rail network map as a GeoJSON FeatureCollection.
        Perfect for rendering on Leaflet, Mapbox, Deck.gl, or Kepler.gl.
        """
        data = self._get("/spoorkaart-api/api/v1/spoorkaart")
        return data.get("payload", {})

    # -------------------------------------------------------------
    # Reisinformatie API (Stations, Departures, Journeys, Trips)
    # -------------------------------------------------------------
    def get_stations(self) -> List[Dict[str, Any]]:
        """Fetch all railway stations with geo-coordinates, UIC codes, and station types."""
        data = self._get("/reisinformatie-api/api/v2/stations")
        return data.get("payload", [])

    def get_departures(self, station_code: str = "UT", max_journeys: int = 40) -> List[Dict[str, Any]]:
        """
        Fetch upcoming live departures for a station code (e.g., 'UT', 'ASD', 'RSD').
        """
        data = self._get("/reisinformatie-api/api/v2/departures", params={"station": station_code, "maxJourneys": max_journeys})
        return data.get("payload", {}).get("departures", [])

    def get_arrivals(self, station_code: str = "UT") -> List[Dict[str, Any]]:
        """Fetch upcoming live arrivals for a station code."""
        data = self._get("/reisinformatie-api/api/v2/arrivals", params={"station": station_code})
        return data.get("payload", {}).get("arrivals", [])

    def get_journey(self, train_number: int) -> Dict[str, Any]:
        """
        Fetch the complete journey details and all intermediate stops for a train.
        """
        data = self._get("/reisinformatie-api/api/v2/journey", params={"train": train_number})
        return data.get("payload", {})

    def plan_trip(self, from_station: str, to_station: str, date_time: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Plan trips between two station codes (e.g. 'UT' -> 'ASD').
        """
        params = {"fromStation": from_station, "toStation": to_station}
        if date_time:
            params["dateTime"] = date_time
        data = self._get("/reisinformatie-api/api/v3/trips", params=params)
        return data.get("trips", [])

    # -------------------------------------------------------------
    # Disruptions API v3
    # -------------------------------------------------------------
    def get_disruptions(self) -> List[Dict[str, Any]]:
        """Fetch all current disruptions and planned engineering works."""
        return self._get("/disruptions/v3")

    # -------------------------------------------------------------
    # Places API (Station amenities & POIs)
    # -------------------------------------------------------------
    def get_places(self, query: str = "Utrecht") -> List[Dict[str, Any]]:
        """Fetch places, facilities, bike rentals, and amenities near a station."""
        data = self._get("/places-api/v2/places", params={"q": query})
        return data.get("payload", [])
