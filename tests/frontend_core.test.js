import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Setup minimal mock browser DOM & Leaflet before loading app.js
const mockElement = (initialClasses = []) => {
  const classes = new Set(initialClasses);
  return {
    addEventListener: () => {},
    classList: {
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c); else classes.add(c);
        } else if (force) classes.add(c); else classes.delete(c);
      },
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    style: {},
    appendChild: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
};

const domElements = new Map();
function getOrCreateElement(id) {
  if (!domElements.has(id)) {
    const initialClasses = (id === "journey-drawer") ? ["drawer-closed"] : (id === "train-dock" ? ["closed"] : []);
    domElements.set(id, mockElement(initialClasses));
  }
  return domElements.get(id);
}

const storageMap = new Map();
globalThis.sessionStorage = {
  getItem: (k) => storageMap.get(k) || null,
  setItem: (k, v) => storageMap.set(k, String(v)),
  removeItem: (k) => storageMap.delete(k),
  clear: () => storageMap.clear(),
};

globalThis.window = {
  __TEST_ENV__: true,
  location: { search: "" },
  history: { replaceState: () => {} },
  addEventListener: () => {},
  sessionStorage: globalThis.sessionStorage,
};

globalThis.document = {
  getElementById: (id) => getOrCreateElement(id),
  querySelector: () => mockElement(),
  querySelectorAll: () => [],
  createElement: () => mockElement(),
  addEventListener: () => {},
  body: mockElement(),
};

globalThis.L = {
  map: () => ({
    getZoom: () => 8,
    on: () => {},
    addLayer: () => {},
    removeLayer: () => {},
    hasLayer: () => false,
    panTo: () => {},
    flyTo: () => {},
  }),
  canvas: () => ({}),
  tileLayer: () => ({ addTo: () => ({}) }),
  layerGroup: () => ({ addTo: () => ({ clearLayers: () => {} }) }),
  control: { layers: () => ({ addTo: () => ({}) }) },
  divIcon: () => ({}),
  marker: () => ({ addTo: () => ({}), bindTooltip: () => ({}), on: () => {} }),
  polyline: () => ({ addTo: () => ({}) }),
  circleMarker: () => ({ addTo: () => ({}) }),
  DomEvent: { stopPropagation: () => {} },
};

globalThis.EventSource = class {};
globalThis.requestAnimationFrame = () => {};

// Evaluate static/app.js in Node
const code = fs.readFileSync("static/app.js", "utf8");
const exportsHolder = {};
const moduleMock = { exports: exportsHolder };

const runFn = new Function("module", "exports", code);
runFn(moduleMock, exportsHolder);

const core = moduleMock.exports;

// ── Tests for distanceMeters ─────────────────────────────────────────

test("distanceMeters returns 0 for identical points", () => {
  const d = core.distanceMeters(52.0894, 5.1100, 52.0894, 5.1100);
  assert.equal(d, 0);
});

test("distanceMeters computes accurate distance between Utrecht and Amsterdam", () => {
  const d = core.distanceMeters(52.0894, 5.1100, 52.3791, 4.9003);
  // ~35 km = 35000m
  assert.ok(d > 34000 && d < 37000, `Expected ~35km, got ${d}m`);
});

// ── Tests for headingToCompass ───────────────────────────────────────

test("headingToCompass handles cardinal directions", () => {
  assert.equal(core.headingToCompass(0), "N");
  assert.equal(core.headingToCompass(90), "O");
  assert.equal(core.headingToCompass(180), "Z");
  assert.equal(core.headingToCompass(270), "W");
  assert.equal(core.headingToCompass(360), "N");
});

test("headingToCompass handles negative degrees without returning empty or undefined", () => {
  // Bug probe: negative headings like -90 or -30 must normalize to valid compass points
  assert.equal(core.headingToCompass(-90), "W");
  assert.equal(core.headingToCompass(-180), "Z");
  assert.equal(core.headingToCompass(-270), "O");
  assert.equal(core.headingToCompass(-30), "NNW");
});

test("headingToCompass handles values > 360", () => {
  assert.equal(core.headingToCompass(450), "O"); // 450 - 360 = 90 (O)
  assert.equal(core.headingToCompass(720), "N"); // 720 = 2 * 360 (N)
});

test("headingToCompass handles null and NaN gracefully", () => {
  assert.equal(core.headingToCompass(null), "");
  assert.equal(core.headingToCompass(undefined), "");
  assert.equal(core.headingToCompass(NaN), "");
});

// ── Tests for trainCategory & trainColor ──────────────────────────────

test("trainCategory maps IC and ICE to IC", () => {
  assert.equal(core.trainCategory("IC"), "IC");
  assert.equal(core.trainCategory("ICE"), "IC");
});

test("trainCategory handles lowercase and case variations", () => {
  // Bug probe: lowercase "ic" and "spr" from external feeds
  assert.equal(core.trainCategory("ic"), "IC");
  assert.equal(core.trainCategory("spr"), "SPR");
});

test("trainCategory maps SPR to SPR and other types to other", () => {
  assert.equal(core.trainCategory("SPR"), "SPR");
  assert.equal(core.trainCategory("Thalys"), "other");
  assert.equal(core.trainCategory("Eurostar"), "other");
  assert.equal(core.trainCategory(null), "other");
  assert.equal(core.trainCategory(""), "other");
});

test("trainColor matches official NS branding", () => {
  assert.equal(core.trainColor("IC"), "#FFC917");
  assert.equal(core.trainColor("SPR"), "#00AEEF");
  assert.equal(core.trainColor("spr"), "#00AEEF");
  assert.equal(core.trainColor("other"), "#FF6B35");
});

test("categoryLabel provides human-friendly Dutch labels", () => {
  assert.equal(core.categoryLabel("IC"), "Intercity");
  assert.equal(core.categoryLabel("SPR"), "Sprinter");
  assert.equal(core.categoryLabel("Stoptrein"), "Stoptrein");
  assert.equal(core.categoryLabel(null), "Trein");
});

// ── Tests for buildTrackGeometryFromStations ─────────────────────────

test("buildTrackGeometryFromStations handles empty or single station", () => {
  assert.deepEqual(core.buildTrackGeometryFromStations([]), []);
  assert.deepEqual(core.buildTrackGeometryFromStations([{ code: "ut", lat: 52.0, lng: 5.0 }]), []);
});

test("buildTrackGeometryFromStations straight fallback when tracks not in index", () => {
  const stops = [
    { code: "aaa", lat: 52.0, lng: 5.0 },
    { code: "bbb", lat: 52.1, lng: 5.1 },
    { code: "ccc", lat: 52.2, lng: 5.2 },
  ];
  const geom = core.buildTrackGeometryFromStations(stops);
  assert.equal(geom.length, 3);
  assert.deepEqual(geom[0], [52.0, 5.0]);
  assert.deepEqual(geom[1], [52.1, 5.1]);
  assert.deepEqual(geom[2], [52.2, 5.2]);
});

test("buildTrackGeometryFromStations uses pre-indexed curved tracks when available", () => {
  core.trackIndex["ams_ut"] = [
    [52.3791, 4.9003],
    [52.2500, 5.0000],
    [52.0894, 5.1100],
  ];

  const stops = [
    { code: "AMS", lat: 52.3791, lng: 4.9003 },
    { code: "UT", lat: 52.0894, lng: 5.1100 },
  ];
  const geom = core.buildTrackGeometryFromStations(stops);
  assert.equal(geom.length, 3);
  assert.deepEqual(geom[1], [52.2500, 5.0000]);
});

// ── Tests for chevronSVG ─────────────────────────────────────────────

test("chevronSVG generates unselected compact SVG", () => {
  const svg = core.chevronSVG("#FFC917", 90, false, null);
  assert.ok(svg.includes("<svg"), "Must contain svg tag");
  assert.ok(svg.includes("transform:rotate(90deg)"), "Must include 90deg rotation");
  assert.ok(svg.includes('fill="#FFC917"'), "Must fill with train color");
});

test("chevronSVG generates selected halo with matching color variables", () => {
  const trainObj = { id: 2145, type: "SPR" };
  const svg = core.chevronSVG("#00AEEF", 180, true, trainObj);
  assert.ok(svg.includes("train-selected-halo"), "Must include selected halo");
  assert.ok(svg.includes("--train-color:#00AEEF"), "Must scope train color variable");
  assert.ok(svg.includes("selected-pulse-ring"), "Must include radar pulse rings");
  assert.ok(svg.includes("2145"), "Must include train ID badge");
});

// ── Tests for snapToTrack ────────────────────────────────────────────

test("snapToTrack snaps coordinates within 95m tolerance onto centerline", () => {
  // Populate spatial grid with a horizontal segment at lat 52.0 between lng 5.0 and 5.02
  const lat1 = 52.0, lng1 = 5.0, lat2 = 52.0, lng2 = 5.02;
  const seg = [lat1, lng1, lat2, lng2, 0, 0];
  const gx = Math.floor(5.01 / core.GRID_CELL_SIZE);
  const gy = Math.floor(52.0 / core.GRID_CELL_SIZE);
  core.trackSpatialGrid[`${gx}_${gy}`] = [seg];

  // Train is 15m north of the track (lat = 52.0 + 15 / 110540)
  const offsetLat = 52.0 + (15.0 / 110540);
  const snap = core.snapToTrack(offsetLat, 5.01, 90);

  assert.equal(snap.snapped, true);
  assert.ok(Math.abs(snap.lat - 52.0) < 1e-5, `Expected lat ~52.0, got ${snap.lat}`);
  assert.ok(Math.abs(snap.dist - 15.0) < 1.0, `Expected dist ~15m, got ${snap.dist}`);
});

test("snapToTrack preserves raw coordinates when farther than 95m tolerance", () => {
  // Train is 200m north of track
  const offsetLat = 52.0 + (200.0 / 110540);
  const snap = core.snapToTrack(offsetLat, 5.01, 90);

  assert.equal(snap.snapped, false);
  assert.equal(snap.lat, offsetLat);
  assert.equal(snap.lng, 5.01);
});

// ── Tests for advanceAlongTrack ──────────────────────────────────────

test("advanceAlongTrack advances distance along track polyline", () => {
  const line = [
    [52.0, 5.0],
    [52.0, 5.01],
  ];
  // Total line length in meters
  const totalMeters = core.distanceMeters(52.0, 5.0, 52.0, 5.01);
  // Advance half the distance
  const p = core.advanceAlongTrack(line, 0, 0.0, totalMeters / 2, true);
  assert.ok(Math.abs(p.lng - 5.005) < 1e-4, `Expected lng ~5.005, got ${p.lng}`);
});

test("advanceAlongTrack clamps to endpoint when distance exceeds segment", () => {
  const line = [
    [52.0, 5.0],
    [52.0, 5.01],
  ];
  const p = core.advanceAlongTrack(line, 0, 0.0, 999999, true);
  assert.equal(p.lat, 52.0);
  assert.equal(p.lng, 5.01);
});

// ── Tests for PROVINCE_COLORS and getProvinceColor ────────────────────

test("PROVINCE_COLORS contains valid hex codes for all 12 provinces", () => {
  const expectedProvinces = [
    "Groningen", "Fryslân", "Friesland", "Drenthe", "Overijssel", "Flevoland",
    "Gelderland", "Utrecht", "Noord-Holland", "North Holland", "Zuid-Holland",
    "South Holland", "Zeeland", "Noord-Brabant", "North Brabant", "Limburg"
  ];
  for (const prov of expectedProvinces) {
    const col = core.getProvinceColor(prov);
    assert.match(col, /^#[0-9a-fA-F]{6}$/, `Color for ${prov} must be a valid 6-char hex`);
  }
});

test("getProvinceColor maps exact palette colors from reference map", () => {
  assert.equal(core.getProvinceColor("Groningen"), "#53b35a");
  assert.equal(core.getProvinceColor("Fryslân"), "#f7bc17");
  assert.equal(core.getProvinceColor("Friesland"), "#f7bc17");
  assert.equal(core.getProvinceColor("Drenthe"), "#a3ce65");
  assert.equal(core.getProvinceColor("Overijssel"), "#917c71");
  assert.equal(core.getProvinceColor("Flevoland"), "#256cb6");
  assert.equal(core.getProvinceColor("Gelderland"), "#432670");
  assert.equal(core.getProvinceColor("Utrecht"), "#f7bc17");
  assert.equal(core.getProvinceColor("Noord-Holland"), "#1aa9a8");
  assert.equal(core.getProvinceColor("North Holland"), "#1aa9a8");
  assert.equal(core.getProvinceColor("Zuid-Holland"), "#eb565b");
  assert.equal(core.getProvinceColor("South Holland"), "#eb565b");
  assert.equal(core.getProvinceColor("Zeeland"), "#a3ce65");
  assert.equal(core.getProvinceColor("Noord-Brabant"), "#aeacad");
  assert.equal(core.getProvinceColor("North Brabant"), "#aeacad");
  assert.equal(core.getProvinceColor("Limburg"), "#ef6328");
});

test("getProvinceColor gracefully handles edge cases and unknown provinces", () => {
  assert.equal(core.getProvinceColor(null), "#38bdf8");
  assert.equal(core.getProvinceColor(undefined), "#38bdf8");
  assert.equal(core.getProvinceColor(""), "#38bdf8");
  assert.equal(core.getProvinceColor(123), "#38bdf8");
  assert.equal(core.getProvinceColor("UnknownProvince"), "#38bdf8");
  assert.equal(core.getProvinceColor("  Utrecht  "), "#f7bc17");
});

// ── Tests for On-Demand Journey Fetching ────────────────────────────

test("fetchJourneyForCache fetches and caches train journey on demand", async () => {
  const originalFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(url);
    const m = url.match(/\/api\/journey\/(\d+)/);
    const tid = m ? parseInt(m[1], 10) : 0;
    return {
      ok: true,
      json: async () => ({
        train_number: tid,
        origin: "Utrecht Centraal",
        destination: "Amsterdam Centraal",
        current_delay: 3,
        stops: []
      })
    };
  };

  try {
    await core.fetchJourneyForCache(88881, { lat: 52.0894, lng: 5.1098 });
    assert.ok(core.journeyCache[88881], "Journey cache must contain 88881");
    assert.equal(core.journeyCache[88881].origin, "Utrecht Centraal");
    assert.equal(core.journeyCache[88881].current_delay, 3);
    assert.ok(fetchedUrls.some(u => u.includes("88881")), "Must fetch train 88881");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Tests for Track Tangent Angle Locking ───────────────────────────

test("snapToTrack computes tangent bearing and respects heading direction", () => {
  // Populate spatial grid with an East-West rail line
  const p1 = [52.0, 5.0];
  const p2 = [52.0, 5.2];
  core.trackFeatures.push([p1, p2]);
  const fIdx = core.trackFeatures.length - 1;
  const sIdx = 0;

  const seg = [p1[0], p1[1], p2[0], p2[1], fIdx, sIdx];
  const gx = Math.floor(5.1 / core.GRID_CELL_SIZE);
  const gy = Math.floor(52.0 / core.GRID_CELL_SIZE);
  core.trackSpatialGrid[`${gx}_${gy}`] = [seg];

  // 1. Train moving East (~85° heading)
  const snapEast = core.snapToTrack(52.0001, 5.1, 85);
  assert.equal(snapEast.snapped, true);
  assert.equal(snapEast.forward, true);
  assert.ok(Math.abs(snapEast.bearing - 90) < 3, `Expected ~90° bearing, got ${snapEast.bearing}`);

  // 2. Train moving West (~265° heading) along the same track
  const snapWest = core.snapToTrack(52.0001, 5.1, 265);
  assert.equal(snapWest.snapped, true);
  assert.equal(snapWest.forward, false);
  assert.ok(Math.abs(snapWest.bearing - 270) < 3, `Expected ~270° bearing, got ${snapWest.bearing}`);
});

test("advanceAlongTrack computes instantaneous tangent angle along polyline", () => {
  // L-shaped track: segment 1 goes East, segment 2 turns North
  const coords = [
    [52.0, 5.0],
    [52.0, 5.1], // East
    [52.1, 5.1]  // North
  ];

  // Moving along segment 0 (East)
  const advEast = core.advanceAlongTrack(coords, 0, 0.2, 500, true);
  assert.ok(advEast.bearing !== undefined);
  assert.ok(Math.abs(advEast.bearing - 90) < 3, `Expected East (~90°), got ${advEast.bearing}`);

  // Moving along segment 1 (North)
  const advNorth = core.advanceAlongTrack(coords, 1, 0.2, 500, true);
  assert.ok(advNorth.bearing !== undefined);
  assert.ok(Math.abs(advNorth.bearing - 0) < 3 || Math.abs(advNorth.bearing - 360) < 3, `Expected North (~0°), got ${advNorth.bearing}`);
});

// ── Tests for Dynamic Mid-Track Delay Estimation ────────────────────

test("estimateMidTrackDelay accurately detects ETA vs timetable delays", () => {
  const nowMs = Date.now();

  // 1. Train running on time or ahead: distance 10km, speed 120km/h => travel time 5 min.
  // Planned arrival is 10 min in the future => delay = 0
  const plannedFutureIso = new Date(nowMs + 10 * 60 * 1000).toISOString();
  const delayAhead = core.estimateMidTrackDelay(10000, 120, plannedFutureIso);
  assert.equal(delayAhead, 0);

  // 2. Train running late mid-track: distance 20km, speed 100km/h => travel time 12 min.
  // Planned arrival is only 5 min in the future => delay = 7 min
  const plannedNearIso = new Date(nowMs + 5 * 60 * 1000).toISOString();
  const delayLate = core.estimateMidTrackDelay(20000, 100, plannedNearIso);
  assert.ok(delayLate >= 6 && delayLate <= 8, `Expected ~7m delay, got ${delayLate}`);

  // 3. Stationary or crawling train (<10 km/h) does not trigger spurious dynamic delays
  const delayStopped = core.estimateMidTrackDelay(20000, 4, plannedNearIso);
  assert.equal(delayStopped, 0);

  // 4. Invalid or null planned times return 0 safely
  assert.equal(core.estimateMidTrackDelay(20000, 100, null), 0);
  assert.equal(core.estimateMidTrackDelay(20000, 100, "non-date"), 0);
  assert.equal(core.estimateMidTrackDelay(20, 100, plannedNearIso), 0); // distance < 50m
});

// ── Tests for SessionStorage Journey Caching & TTL ──────────────────

test("getCachedJourney and setCachedJourney respect TTL and restore across sessions", () => {
  const testJourney = {
    train_id: 77771,
    origin: "Eindhoven Centraal",
    destination: "Utrecht Centraal",
    current_delay: 2,
    stops: []
  };

  // 1. Cache item
  core.setCachedJourney(77771, testJourney);
  assert.equal(core.getCachedJourney(77771).origin, "Eindhoven Centraal");

  // 2. Simulate page reload / in-memory cache clear
  delete core.journeyCache[77771];
  const restored = core.getCachedJourney(77771);
  assert.ok(restored, "Must restore journey from sessionStorage");
  assert.equal(restored.origin, "Eindhoven Centraal");

  // 3. Simulate expired TTL (> 25 minutes)
  globalThis.sessionStorage.setItem("nachtlijn_journey_77771", JSON.stringify({
    timestamp: Date.now() - 30 * 60 * 1000,
    data: testJourney
  }));
  delete core.journeyCache[77771];
  assert.equal(core.getCachedJourney(77771), null, "Expired TTL must return null");
});

// ── Tests for Disruption Zone Intersection ──────────────────────────

test("checkTrainDisruption detects upcoming route intersections and proximity", () => {
  // Test with no disruptions loaded
  assert.equal(core.checkTrainDisruption({ stops: [] }, null), null);

  // Mock disruption data in global scope
  const mockDisruption = {
    id: "disr-901",
    title: "Seinstoring tussen Utrecht en Amsterdam",
    cause: "Defect spoor",
    sections: [
      [
        { code: "ut", name: "Utrecht Centraal", lat: 52.0894, lng: 5.1100 },
        { code: "asd", name: "Amsterdam Centraal", lat: 52.3791, lng: 4.9003 }
      ]
    ]
  };

  // When disruptions list is empty
  assert.equal(core.checkTrainDisruption({ stops: [{ code: "asd", state: "next" }] }, null), null);

  // Set active disruption data
  core.setDisruptionsDataForTest({
    timestamp: Date.now() / 1000,
    count: 1,
    disruptions: [mockDisruption]
  });

  // 1. Train scheduled to stop at 'asd' next (matching disruption corridor)
  const journeyUpcoming = {
    stops: [
      { code: "ut", state: "passed" },
      { code: "asd", state: "next" }
    ]
  };
  const matched = core.checkTrainDisruption(journeyUpcoming, null);
  assert.ok(matched, "Must detect train heading into disruption corridor");
  assert.equal(matched.id, "disr-901");

  // 2. Train has already passed all disrupted stations
  const journeyPassed = {
    stops: [
      { code: "ut", state: "passed" },
      { code: "asd", state: "passed" },
      { code: "hfd", state: "next" }
    ]
  };
  assert.equal(core.checkTrainDisruption(journeyPassed, null), null, "Passed disruption must not trigger alert");

  // 3. Match by coordinate proximity (< 2500m to disruption section)
  // 500m from Utrecht Centraal (52.0894, 5.1100)
  const posNearDisruption = { lat: 52.0910, lng: 5.1120 };
  const matchedProx = core.checkTrainDisruption(null, posNearDisruption);
  assert.ok(matchedProx, "Must match disruption when within 2500m");
  assert.equal(matchedProx.id, "disr-901");

  // 4. Far away coordinates with empty journey
  const posFarAway = { lat: 51.4416, lng: 5.4697 }; // Eindhoven
  assert.equal(core.checkTrainDisruption(null, posFarAway), null, "Unrelated coordinates must not match");

  // Cleanup test disruption state
  core.setDisruptionsDataForTest(null);
});

// ── Tests for ProRail 3-Minute Punctuality Norm & formatDelayStatus ───

test("DELAY_THRESHOLD_MIN adheres strictly to official ProRail 3-minute norm", () => {
  assert.equal(core.DELAY_THRESHOLD_MIN, 3);
});

test("formatDelayStatus categorizes 0 min delay as on time", () => {
  const res = core.formatDelayStatus(0, false);
  assert.equal(res.cssClass, "ontime");
  assert.equal(res.text, "Op tijd");
  assert.equal(res.isDelayed, false);
  assert.equal(res.isBuffer, false);
});

test("formatDelayStatus categorizes 1-2 min delay as on time within norm buffer", () => {
  const res1 = core.formatDelayStatus(1, false);
  assert.equal(res1.cssClass, "ontime buffer");
  assert.equal(res1.text, "+1 min (binnen norm)");
  assert.equal(res1.isDelayed, false);
  assert.equal(res1.isBuffer, true);

  const res2 = core.formatDelayStatus(2, false);
  assert.equal(res2.cssClass, "ontime buffer");
  assert.equal(res2.text, "+2 min (binnen norm)");
  assert.equal(res2.isDelayed, false);
  assert.equal(res2.isBuffer, true);
});

test("formatDelayStatus categorizes >= 3 min delay as delayed", () => {
  const res3 = core.formatDelayStatus(3, false);
  assert.equal(res3.cssClass, "delayed");
  assert.equal(res3.text, "+3 min vertraging");
  assert.equal(res3.isDelayed, true);
  assert.equal(res3.isBuffer, false);

  const res15 = core.formatDelayStatus(15, false);
  assert.equal(res15.cssClass, "delayed");
  assert.equal(res15.text, "+15 min vertraging");
  assert.equal(res15.isDelayed, true);
  assert.equal(res15.isBuffer, false);
});

test("formatDelayStatus handles cancelled journeys", () => {
  const res = core.formatDelayStatus(10, true);
  assert.equal(res.cssClass, "cancelled");
  assert.equal(res.text, "🚫 Uitgevallen");
  assert.equal(res.isDelayed, false);
});

// ── Tests for Follow Train Persistence across Map Interactions ───────

test("follow mode persists when user moves the map until STOP is pressed", () => {
  // 1. Start following train 2972
  core.toggleFollowTrain(2972);
  assert.equal(core.getFollowedTrainId(), 2972, "Train 2972 must be followed");
  assert.equal(core.isCameraTracking(), true, "Camera tracking must be active initially");

  // 2. User moves / drags the map (pausing auto-pan)
  core.setCameraTracking(false);
  assert.equal(core.getFollowedTrainId(), 2972, "Followed train card must NOT disappear when moving map");
  assert.equal(core.isCameraTracking(), false, "Camera auto-pan paused during manual pan");

  // 3. User re-centers camera
  core.setCameraTracking(true);
  assert.equal(core.getFollowedTrainId(), 2972, "Followed train must remain active");
  assert.equal(core.isCameraTracking(), true, "Camera tracking resumed");

  // 4. User presses STOP
  core.toggleFollowTrain(2972);
  assert.equal(core.getFollowedTrainId(), null, "Follow mode must only exit when user presses STOP");
  assert.equal(core.isCameraTracking(), false);
});

test("centerTrainOnMap re-centers camera and restores tracking as firstly volg does", () => {
  core.toggleFollowTrain(3086);
  assert.equal(core.getFollowedTrainId(), 3086);

  // User drags map away
  core.setCameraTracking(false);
  assert.equal(core.isCameraTracking(), false);

  // User clicks Centreer button on train card
  core.centerTrainOnMap(3086);
  assert.equal(core.isCameraTracking(), true, "centerTrainOnMap must restore camera tracking");
  assert.equal(core.getFollowedTrainId(), 3086);

  // Stop follow mode
  core.toggleFollowTrain(3086);
  assert.equal(core.getFollowedTrainId(), null);
});

test("pressing center on followed train deselects other clicked train and selects followed train", () => {
  // 1. Follow train 2972
  core.toggleFollowTrain(2972);
  assert.equal(core.getFollowedTrainId(), 2972);
  assert.equal(core.getActiveSelectedTrainId(), 2972);

  // 2. User clicks a different train 3086 (opening 3086's card dock)
  core.openTrainPopup(3086);
  assert.equal(core.getActiveSelectedTrainId(), 3086, "Clicked train 3086 is now selected");
  assert.equal(core.getActiveDockTrainId(), 3086, "Dock card now displays 3086");
  assert.equal(core.getFollowedTrainId(), 2972, "Train 2972 is still followed in background");

  // 3. User presses Center on the volg train (2972)
  core.centerTrainOnMap(2972);
  assert.equal(core.getActiveSelectedTrainId(), 2972, "Must deselect train 3086 and select followed train 2972");
  assert.equal(core.getActiveDockTrainId(), 2972, "Dock card must switch back to followed train 2972");
  assert.equal(core.getFollowedTrainId(), 2972);
  assert.equal(core.isCameraTracking(), true, "Camera tracking must be restored on 2972");

  // Cleanup
  core.toggleFollowTrain(2972);
});

test("switchRadarTab toggles active tab and element display without error", () => {
  const tabSpeed = globalThis.document.getElementById("tab-btn-speed");
  const tabDisruptions = globalThis.document.getElementById("tab-btn-disruptions");
  const leaderboardList = globalThis.document.getElementById("leaderboard-list");
  const disruptionsList = globalThis.document.getElementById("disruptions-list");

  // Switch to disruptions tab
  core.switchRadarTab("disruptions");
  assert.equal(core.getActiveRadarTab(), "disruptions");
  assert.equal(tabDisruptions.classList.contains("active"), true);
  assert.equal(tabSpeed.classList.contains("active"), false);
  assert.equal(leaderboardList.style.display, "none");
  assert.equal(disruptionsList.style.display, "flex");

  // Switch back to speed tab
  core.switchRadarTab("speed");
  assert.equal(core.getActiveRadarTab(), "speed");
  assert.equal(tabSpeed.classList.contains("active"), true);
  assert.equal(tabDisruptions.classList.contains("active"), false);
  assert.equal(leaderboardList.style.display, "flex");
  assert.equal(disruptionsList.style.display, "none");
});
