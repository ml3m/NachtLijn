import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Setup minimal mock browser DOM & Leaflet before loading app.js
const mockElement = () => ({
  addEventListener: () => {},
  classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
  style: {},
  appendChild: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
});

globalThis.window = {
  __TEST_ENV__: true,
  location: { search: "" },
  history: { replaceState: () => {} },
  addEventListener: () => {},
};

globalThis.document = {
  getElementById: () => mockElement(),
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

