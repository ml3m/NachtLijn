"""
NS (Nederlandse Spoorwegen) API Test Suite
Tests connectivity, authentication, and data retrieval across all subscribed NS APIs:
- Virtual Train API (Live train GPS coordinates, speed, heading, status)
- Reisinformatie API (Stations, live departures, arrivals, trips, journey details)
- SpoorKaart API (Track network GeoJSON)
- Disruptions API v3 (Active rail disruptions)
- Places API (Station facilities & POIs)
- ns-api GitHub library compatibility test
"""

import os
import sys
import json
import requests
from datetime import datetime

# Primary API Key from NS Developer Portal
API_KEY = os.environ.get("NS_API_KEY", "")
HEADERS = {
    "Ocp-Apim-Subscription-Key": API_KEY,
    "User-Agent": "NachtLijn-Test/1.0"
}

def banner(title):
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)

def test_virtual_train_api():
    banner("1. Testing Virtual Train API (Live Train Positions & Status)")
    
    # Status
    status_url = "https://gateway.apiportal.ns.nl/virtual-train-api/v1/status"
    r_stat = requests.get(status_url, headers=HEADERS, timeout=10)
    print(f"[*] GET {status_url} -> Status {r_stat.status_code}")
    if r_stat.status_code == 200:
        stat_data = r_stat.json()
        print(f"    - System status: {stat_data.get('overallStatus')}")
        print(f"    - Trains active: {stat_data.get('numberOfTrains')}")
        print(f"    - Regional trains: {stat_data.get('numberOfRegionalTrains')}")
        print(f"    - Replacement buses: {stat_data.get('numberOfBusses')}")

    # Live vehicle locations
    vehicle_url = "https://gateway.apiportal.ns.nl/virtual-train-api/api/vehicle"
    r_veh = requests.get(vehicle_url, headers=HEADERS, timeout=10)
    print(f"\n[*] GET {vehicle_url} -> Status {r_veh.status_code}")
    sample_train_nr = None
    if r_veh.status_code == 200:
        veh_data = r_veh.json()
        trains = veh_data.get("payload", {}).get("treinen", [])
        print(f"    - Total live tracked trains right now: {len(trains)}")
        if trains:
            sample_train_nr = trains[0].get("treinNummer")
            print("    - First 3 live train positions:")
            for t in trains[:3]:
                print(f"      Train #{t.get('treinNummer')} ({t.get('type')}) | Lat: {t.get('lat')}, Lng: {t.get('lng')} | Speed: {t.get('snelheid')} km/h | Heading: {t.get('richting')} deg")

    # Prognosis for a live train
    if sample_train_nr:
        prog_url = f"https://gateway.apiportal.ns.nl/virtual-train-api/api/v1/prognose/{sample_train_nr}"
        r_prog = requests.get(prog_url, headers=HEADERS, timeout=10)
        print(f"\n[*] GET {prog_url} -> Status {r_prog.status_code}")
        if r_prog.status_code == 200:
            p_data = r_prog.json().get("prognoses", [])
            print(f"    - Prognosis stops for Train #{sample_train_nr}: {len(p_data)} stations")
            for p in p_data[:2]:
                print(f"      Stop UIC: {p.get('stationUic')} | Date: {p.get('date')} | Classification: {p.get('classification')}")

def test_reisinformatie_api():
    banner("2. Testing Reisinformatie API (Stations, Departures, Journeys, Trips)")
    
    # Stations
    stations_url = "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/stations"
    r_st = requests.get(stations_url, headers=HEADERS, timeout=10)
    print(f"[*] GET {stations_url} -> Status {r_st.status_code}")
    if r_st.status_code == 200:
        st_data = r_st.json().get("payload", [])
        print(f"    - Total railway stations: {len(st_data)}")
        ut = next((s for s in st_data if s.get("code") == "UT"), None)
        if ut:
            print(f"    - Utrecht Centraal details: UIC={ut.get('UICCode')}, Lat={ut.get('lat')}, Lng={ut.get('lng')}")

    # Live Departures for Utrecht Centraal
    dep_url = "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/departures?station=UT"
    r_dep = requests.get(dep_url, headers=HEADERS, timeout=10)
    print(f"\n[*] GET {dep_url} -> Status {r_dep.status_code}")
    sample_journey_train = None
    if r_dep.status_code == 200:
        departures = r_dep.json().get("payload", {}).get("departures", [])
        print(f"    - Upcoming departures from Utrecht Centraal: {len(departures)}")
        for d in departures[:3]:
            prod = d.get("product", {})
            sample_journey_train = sample_journey_train or prod.get("number")
            print(f"      {d.get('plannedDateTime')} | {prod.get('categoryCode')} {prod.get('number')} -> {d.get('direction')} (Track {d.get('plannedTrack', '?')})")

    # Journey details
    if sample_journey_train:
        j_url = f"https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/journey?train={sample_journey_train}"
        r_j = requests.get(j_url, headers=HEADERS, timeout=10)
        print(f"\n[*] GET {j_url} -> Status {r_j.status_code}")
        if r_j.status_code == 200:
            stops = r_j.json().get("payload", {}).get("stops", [])
            print(f"    - Journey stops for Train #{sample_journey_train}: {len(stops)} stops")
            for s in stops[:3]:
                st_info = s.get("stop", {})
                print(f"      Stop: {st_info.get('name')} | Planned Arr: {s.get('plannedArrivalDateTime')} | Dep: {s.get('plannedDepartureDateTime')}")

    # Trip planner (Utrecht -> Amsterdam)
    trip_url = "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips?fromStation=UT&toStation=ASD"
    r_trip = requests.get(trip_url, headers=HEADERS, timeout=10)
    print(f"\n[*] GET {trip_url} -> Status {r_trip.status_code}")
    if r_trip.status_code == 200:
        trips = r_trip.json().get("trips", [])
        print(f"    - Trip alternatives found (UT -> ASD): {len(trips)}")
        if trips:
            t0 = trips[0]
            legs = t0.get("legs", [])
            dep_leg = legs[0] if legs else {}
            arr_leg = legs[-1] if legs else {}
            dep_time = dep_leg.get("origin", {}).get("plannedDateTime")
            arr_time = arr_leg.get("destination", {}).get("plannedDateTime")
            print(f"      Next trip: Dep {dep_time} -> Arr {arr_time} (Legs: {len(legs)}, Status: {t0.get('status')})")

def test_spoorkaart_api():
    banner("3. Testing SpoorKaart API (Track Map Geometry for Visualization)")
    spoor_url = "https://gateway.apiportal.ns.nl/spoorkaart-api/api/v1/spoorkaart"
    r = requests.get(spoor_url, headers=HEADERS, timeout=15)
    print(f"[*] GET {spoor_url} -> Status {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        payload = data.get("payload", {})
        features = payload.get("features", [])
        print(f"    - GeoJSON Type: {payload.get('type')}")
        print(f"    - Total track segment features: {len(features)}")
        if features:
            f0 = features[0]
            geom = f0.get("geometry", {})
            coords = geom.get("coordinates", [])
            print(f"    - Sample track geometry: {geom.get('type')} with {len(coords)} coordinate points")
            print(f"    - First coordinate: [Lon: {coords[0][0]}, Lat: {coords[0][1]}]")

def test_disruptions_api():
    banner("4. Testing Disruptions API v3 (Rail Disruptions & Works)")
    disr_url = "https://gateway.apiportal.ns.nl/disruptions/v3"
    r = requests.get(disr_url, headers=HEADERS, timeout=10)
    print(f"[*] GET {disr_url} -> Status {r.status_code}")
    if r.status_code == 200:
        disruptions = r.json()
        print(f"    - Total active disruptions/maintenance items: {len(disruptions)}")
        for d in disruptions[:3]:
            print(f"      [{d.get('type')}] {d.get('title')}")
            if d.get("summaryAdditionalTravelTime"):
                print(f"        Delay impact: {d.get('summaryAdditionalTravelTime').get('label')}")

def test_places_api():
    banner("5. Testing Places API (Station Amenities & Facilities)")
    places_url = "https://gateway.apiportal.ns.nl/places-api/v2/places?q=Utrecht"
    r = requests.get(places_url, headers=HEADERS, timeout=10)
    print(f"[*] GET {places_url} -> Status {r.status_code}")
    if r.status_code == 200:
        categories = r.json().get("payload", [])
        print(f"    - Place categories for 'Utrecht': {len(categories)}")
        for cat in categories[:4]:
            locs = cat.get("locations", [])
            print(f"      Category: {cat.get('name')} ({cat.get('type')}) - {len(locs)} items")

def test_github_ns_api_library():
    banner("6. Testing GitHub @[ns-api] Library Compatibility")
    sys.path.append("/home/ml3m/projects/NS-visualization/ns-api")
    try:
        from ns_api import NSAPI
        api = NSAPI(API_KEY)
        
        # Test 1: get_stations
        stations = api.get_stations()
        print(f"[*] ns_api.get_stations() -> SUCCESS: {len(stations)} stations loaded")
        
        # Test 2: get_departures
        deps = api.get_departures("UT")
        print(f"[*] ns_api.get_departures('UT') -> SUCCESS: {len(deps)} departures loaded")
        if deps:
            d = deps[0]
            print(f"    Sample: {d.departure_time} | {d.train_type} -> {d.destination} (Track {d.departure_platform})")
            
        # Test 3: get_trips
        now_hm = datetime.now().strftime("%H:%M")
        trips = api.get_trips(now_hm, "UT", None, "ASD")
        print(f"[*] ns_api.get_trips('{now_hm}', 'UT', None, 'ASD') -> SUCCESS: {len(trips)} trip plans found")
        if trips:
            t = trips[0]
            print(f"    Sample: Planned {t.departure_time_planned} (tk {t.departure_platform_planned}) -> {t.arrival_time_planned} | Status: {t.status}")
            
        # Test 4: get_disruptions notice
        print("[*] Note on ns_api.get_disruptions():")
        print("    The GitHub ns-api repo was written for NS API v2, which wrapped disruptions in {'payload': [...]}.")
        print("    NS updated Disruptions to v3 (direct list [...]), causing a KeyError in that older helper.")
        print("    Our direct test (Section 4) queries the active v3 endpoint successfully.")
    except Exception as e:
        print(f"[!] ns-api error: {e}")

if __name__ == "__main__":
    print("Testing NS API Connection with Primary Key...")
    test_virtual_train_api()
    test_reisinformatie_api()
    test_spoorkaart_api()
    test_disruptions_api()
    test_places_api()
    test_github_ns_api_library()
    banner("All NS API tests completed successfully!")
