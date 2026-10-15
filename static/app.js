/* ═══════════════════════════════════════════════════════════════════
   NS Live Rail Radar & Operations – Frontend
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // ── Constants ────────────────────────────────────────────────────
  const COLORS = { IC: "#FFC917", ICE: "#FFC917", SPR: "#00AEEF" };
  const COLOR_OTHER = "#FF6B35";
  const INTERPOLATION_DURATION = 5000; // ms smooth interpolation matching 5s poll
  const CIRC = 97.389;               // 2·π·15.5  (SVG ring circumference)
  const DEG2RAD = Math.PI / 180;
  const EARTH_R = 6371000;           // metres
  const MAX_TRAIL_POINTS = 8;        // maximum coordinates in a motion trail

  // ── Map setup ────────────────────────────────────────────────────
  const map = L.map("map", {
    center: [52.1326, 5.2913],
    zoom: 8,
    preferCanvas: true,
    zoomControl: true,
  });

  // Base layers
  const cartoApiKey = "cb1_4kvq_1_6316e1fed1845a6f3132c255";
  
  // Carto Dark Matter using official ?key= query param (no watermark)
  const darkMatter = L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${cartoApiKey}`,
    {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://osm.org/copyright">OSM</a>',
      subdomains: "abcd",
      maxZoom: 19,
    }
  ).addTo(map);

  const pdokGrijs = L.tileLayer(
    "https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png",
    {
      attribution: 'Kaart &copy; <a href="https://www.kadaster.nl" target="_blank">Kadaster / PDOK</a>',
      maxZoom: 19,
    }
  );

  const pdokStandaard = L.tileLayer(
    "https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/{z}/{x}/{y}.png",
    {
      attribution: 'Kaart &copy; <a href="https://www.kadaster.nl" target="_blank">Kadaster / PDOK</a>',
      maxZoom: 19,
    }
  );

  // PDOK Luchtfoto (official high-res aerial photography)
  const pdokLuchtfoto = L.tileLayer(
    "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_ortho25/EPSG:3857/{z}/{x}/{y}.jpeg",
    {
      attribution: 'Luchtfoto &copy; <a href="https://www.pdok.nl" target="_blank">PDOK</a>',
      maxZoom: 19,
    }
  );

  const baseMaps = {
    "🌑 Dark Matter (Carto)": darkMatter,
    "🗺️ PDOK BRT Grijs": pdokGrijs,
    "🇳🇱 PDOK BRT Standaard": pdokStandaard,
    "🛰️ PDOK Luchtfoto (Satelliet)": pdokLuchtfoto,
  };

  L.control.layers(baseMaps, null, { position: "topright" }).addTo(map);

  map.on("dragstart", () => {
    if (followedTrainId !== null) {
      followedTrainId = null;
      updateFollowButtons();
    }
  });

  // ── DOM refs ─────────────────────────────────────────────────────
  const $count        = document.getElementById("train-count");
  const $countIc      = document.getElementById("count-ic");
  const $countSpr     = document.getElementById("count-spr");
  const $countOther   = document.getElementById("count-other");
  const $statusDot    = document.getElementById("status-dot");
  const $ringFg       = document.getElementById("ring-fg");
  const $cdText       = document.getElementById("countdown-text");
  const $search       = document.getElementById("search-input");
  const $feedback     = document.getElementById("search-feedback");
  const $searchDropdown = document.getElementById("search-dropdown");
  const $searchClear  = document.getElementById("search-clear-btn");
  const $borderCb     = document.getElementById("border-cb");
  const $trailsCb     = document.getElementById("trails-cb");
  const $stationCb    = document.getElementById("stations-cb");
  const $disruptionsCb= document.getElementById("disruptions-cb");
  const $disruptionsLbl = document.getElementById("disruptions-label");
  const $feedBadge    = document.getElementById("feed-badge");

  // Drawer elements
  const $drawer       = document.getElementById("journey-drawer");
  const $drawerClose  = document.getElementById("drawer-close-btn");
  const $drawerBadge  = document.getElementById("drawer-badge");
  const $drawerTitle  = document.getElementById("drawer-title");
  const $drawerSub    = document.getElementById("drawer-sub");
  const $drawerStock  = document.getElementById("drawer-stock");
  const $drawerTimeline = document.getElementById("drawer-timeline");
  const $drawerFollow   = document.getElementById("drawer-follow-btn");

  // Cockpit Telemetry HUD elements
  const $cockpitHud       = document.getElementById("cockpit-hud");
  const $cockpitBadge     = document.getElementById("cockpit-badge");
  const $cockpitTrainNum  = document.getElementById("cockpit-train-num");
  const $cockpitRoute     = document.getElementById("cockpit-route");
  const $cockpitSpeedNum  = document.getElementById("cockpit-speed-num");
  const $cockpitHeading   = document.getElementById("cockpit-heading");
  const $cockpitNextName  = document.getElementById("cockpit-next-name");
  const $cockpitDistance  = document.getElementById("cockpit-distance");
  const $cockpitStopBtn   = document.getElementById("cockpit-stop-btn");
  const $cockpitJourneyBtn= document.getElementById("cockpit-journey-btn");
  const $cockpitInfoClick = document.getElementById("cockpit-info-click");
  const $audioBtn         = document.getElementById("audio-toggle-btn");

  // ── State ────────────────────────────────────────────────────────
  let audioCtx = null;
  let audioEnabled = false;
  try {
    audioEnabled = localStorage.getItem("nachtlijn_audio_enabled") === "true";
  } catch (_) {}
  let lastAnnouncedStopKey = null;

  const activeRouteLayer = L.layerGroup().addTo(map);
  let followedTrainId = null;
  let activeSelectedTrainId = null;
  const markers = {};                // id -> { marker, polyline, history:[], displayed:{lat,lng}, target:{lat,lng}, prev:{lat,lng}, ... }
  const visibleTypes = { IC: true, SPR: true, other: true };
  const trackIndex = {};             // "f_code_t_code" -> [[lat, lng], [lat, lng], ...]
  const trackSpatialGrid = {};       // "gx_gy" -> [ [lat1, lng1, lat2, lng2, fIdx, sIdx], ... ]
  const trackFeatures = [];          // fIdx -> [ [lat, lng], ... ]
  const GRID_CELL_SIZE = 0.02;       // ~1.5 - 2.2 km 2D spatial grid cell size
  const journeyCache = {};           // trainId -> { origin, destination, next_stop, current_delay, train_type, stops }
  let lastServerTimestamp = 0;       // tracks server freshness to prevent back-and-forth jitter
  let eventSource = null;            // SSE push connection
  let isSSEActive = false;
  let fetchTimer = null;
  let nextUpdateAt = 0;
  let pollInterval = 5;
  let fetchBackoff = 0;
  let connectionStatus = "offline";
  let openPopupId = null;
  let borderLayer = null;
  let borderGlowLayer = null;
  let borderVisible = true;
  let tracksLayer = null;
  let stationsLayer = null;
  let stationsData = null;
  let stationsVisible = true;
  let disruptionsLayer = null;
  let disruptionsData = null;
  let disruptionsVisible = true;
  let showTrails = true;
  const stationMarkers = {};
  let pendingUrlTrainId = null;
  let pendingUrlStationCode = null;

  function updateUrlParam(key, val) {
    try {
      const url = new URL(window.location);
      if (val) {
        url.searchParams.set(key, val);
        if (key === "train") url.searchParams.delete("station");
        if (key === "station") url.searchParams.delete("train");
      } else {
        url.searchParams.delete(key);
      }
      window.history.replaceState({}, "", url);
    } catch (_) {}
  }

  function checkUrlParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const trainParam = params.get("train");
      const stationParam = params.get("station");

      if (trainParam) {
        const tid = parseInt(trainParam, 10);
        if (markers[tid]) {
          const m = markers[tid];
          map.flyTo([m.displayed.lat, m.displayed.lng], Math.max(map.getZoom(), 12), { duration: 1.2 });
          followedTrainId = tid;
          updateFollowButtons();
          window.openJourney(tid);
        } else {
          pendingUrlTrainId = tid;
          window.openJourney(tid);
        }
      } else if (stationParam) {
        const code = stationParam.toUpperCase();
        if (stationMarkers[code]) {
          const entry = stationMarkers[code];
          map.flyTo([entry.station.lat, entry.station.lng], Math.max(map.getZoom(), 13), { duration: 1.2 });
          entry.marker.openPopup();
          fetchStationDepartures(entry.station, entry.marker);
        } else {
          pendingUrlStationCode = code;
        }
      }
    } catch (_) {}
  }

  // Force all 4 checkboxes to checked by default on site load
  if ($borderCb) $borderCb.checked = true;
  if ($trailsCb) $trailsCb.checked = true;
  if ($stationCb) $stationCb.checked = true;
  if ($disruptionsCb) $disruptionsCb.checked = true;

  function syncToggleLayers() {
    borderVisible = $borderCb ? $borderCb.checked : true;
    showTrails = $trailsCb ? $trailsCb.checked : true;
    stationsVisible = $stationCb ? $stationCb.checked : true;
    disruptionsVisible = $disruptionsCb ? $disruptionsCb.checked : true;

    // 1. National border outline & aura glow
    if (borderLayer && borderGlowLayer) {
      if (borderVisible) {
        if (!map.hasLayer(borderGlowLayer)) map.addLayer(borderGlowLayer);
        if (!map.hasLayer(borderLayer)) map.addLayer(borderLayer);
      } else {
        if (map.hasLayer(borderGlowLayer)) map.removeLayer(borderGlowLayer);
        if (map.hasLayer(borderLayer)) map.removeLayer(borderLayer);
      }
    }

    // 2. Motion trails for live trains
    for (const id in markers) {
      const m = markers[id];
      if (m && m.polyline) {
        const cat = trainCategory(m.type);
        if (showTrails && visibleTypes[cat]) {
          if (!map.hasLayer(m.polyline)) map.addLayer(m.polyline);
        } else {
          if (map.hasLayer(m.polyline)) map.removeLayer(m.polyline);
        }
      }
    }

    // 3. Stations & live departure boards
    if (stationsVisible && map.getZoom() >= 7) {
      showStations();
    } else {
      hideStations();
    }

    // 4. Rail disruptions
    if (disruptionsLayer) {
      if (disruptionsVisible) {
        if (!map.hasLayer(disruptionsLayer)) disruptionsLayer.addTo(map);
      } else {
        map.removeLayer(disruptionsLayer);
      }
    } else if (disruptionsVisible && disruptionsData && disruptionsData.disruptions) {
      renderDisruptions(disruptionsData.disruptions);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function headingToCompass(deg) {
    const directions = ["N", "NNO", "NO", "ONO", "O", "OZO", "ZO", "ZZO", "Z", "ZZW", "ZW", "WZW", "W", "WNW", "NW", "NNW"];
    const val = Math.floor((deg / 22.5) + 0.5);
    return directions[val % 16] || "";
  }

  function trainColor(type) {
    return COLORS[type] || COLOR_OTHER;
  }

  function trainCategory(type) {
    if (type === "IC" || type === "ICE") return "IC";
    if (type === "SPR") return "SPR";
    return "other";
  }

  function categoryLabel(type) {
    if (type === "IC" || type === "ICE") return "Intercity";
    if (type === "SPR") return "Sprinter";
    return type || "Trein";
  }

  // SVG chevron builder with enlarged click hit-area
  function chevronSVG(color, heading) {
    return `<div class="train-chevron-wrap" style="transform:rotate(${heading}deg);width:100%;height:100%;display:flex;align-items:center;justify-content:center;pointer-events:auto;">` +
      `<svg viewBox="0 0 24 24" width="20" height="20" style="filter:drop-shadow(0 0 4px rgba(0,0,0,0.9));pointer-events:none;">` +
      `<path d="M12 2 L20 18 L12 14 L4 18 Z" fill="${color}" stroke="#000000" stroke-width="1.2" stroke-linejoin="round"/>` +
      `</svg></div>`;
  }

  // ── Rich Train Card Builder ──────────────────────────────────────
  function renderTrainCard(t, journey) {
    const cat = trainCategory(t.type);
    const speed = (t.speed !== undefined ? t.speed : 0).toFixed(1);
    const heading = (t.heading !== undefined ? t.heading : 0).toFixed(0);
    const compass = headingToCompass(t.heading);
    const lat = (t.displayed ? t.displayed.lat : t.lat).toFixed(4);
    const lng = (t.displayed ? t.displayed.lng : t.lng).toFixed(4);
    const isMoving = t.speed >= 1.5;

    let routeHtml = "";
    if (journey) {
      const delayClass = journey.current_delay > 0 ? "delayed" : "ontime";
      const delayText = journey.current_delay > 0 ? `+${journey.current_delay} min vertraging` : "Op tijd";
      const isAtDest = journey.next_stop && journey.next_stop.at_destination;
      const isAtStation = journey.next_stop && journey.next_stop.at_station;
      let nextLabel = "Volgende:";
      if (isAtDest) {
        nextLabel = "🏁 Eindpunt:";
      } else if (isAtStation) {
        nextLabel = "🚉 Halteert:";
      }
      const nextStopName = journey.next_stop ? journey.next_stop.name : (journey.destination || "Eindpunt");
      const nextStopTrack = journey.next_stop && journey.next_stop.track ? `<span class="ns-track">Spoor ${journey.next_stop.track}</span>` : "";

      routeHtml = `
        <div class="popup-route-container">
          <div class="popup-route-line" title="${journey.origin} naar ${journey.destination}">
            <span>${journey.origin || "—"}</span>
            <span class="route-arrow">➔</span>
            <span>${journey.destination || "—"}</span>
          </div>
          <div class="popup-next-stop">
            <span>${nextLabel} <b>${nextStopName}</b></span>
            ${nextStopTrack}
          </div>
          <div class="popup-status-delay">
            <span style="color:#8fa8cc;">Status:</span>
            <span class="delay-pill ${delayClass}">${delayText}</span>
          </div>
        </div>
      `;
    } else {
      routeHtml = `
        <div class="popup-route-container" id="route-box-${t.id}">
          <div style="font-size:11.5px;color:#8fa8cc;text-align:center;padding:4px;">
            🔄 Route en dienstregeling ophalen…
          </div>
        </div>
      `;
    }

    return `
      <div class="train-card-wrap">
        <div class="popup-head-row">
          <span class="popup-badge ${cat}">${categoryLabel(t.type)} ${t.id}</span>
          <span class="popup-motion-status">
            <span class="popup-motion-dot ${isMoving ? "moving" : "stopped"}"></span>
            <span>${isMoving ? "Rijdend" : "Stilstaand"}</span>
          </span>
        </div>

        ${routeHtml}

        <div class="popup-telemetry-grid">
          <div class="telemetry-item">
            <span class="telemetry-label">Snelheid</span>
            <span class="telemetry-val" id="live-speed-${t.id}">${speed} km/h</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Richting</span>
            <span class="telemetry-val" id="live-heading-${t.id}">${heading}° · ${compass}</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Locatie</span>
            <span class="telemetry-val" id="live-pos-${t.id}">${lat}, ${lng}</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Bron</span>
            <span class="telemetry-val">${t.source || "OBIS"}</span>
          </div>
        </div>

        <div class="popup-actions-row">
          <button class="popup-btn btn-follow ${followedTrainId === t.id ? 'active' : ''}" id="follow-btn-${t.id}" onclick="window.toggleFollowTrain(${t.id})">
            ${followedTrainId === t.id ? '⏹️ Stop' : '🎯 Volg Trein'}
          </button>
          <button class="popup-btn" onclick="window.openJourney(${t.id})">📜 Dienstregeling</button>
        </div>
      </div>
    `;
  }

  // Opens popup and loads journey details asynchronously
  async function openTrainPopup(trainId) {
    // If journey drawer is already open, sync it with the selected train
    if (!$drawer.classList.contains("drawer-closed")) {
      window.openJourney(trainId);
      return;
    }

    openPopupId = trainId;
    activeSelectedTrainId = trainId;
    const m = markers[trainId];
    if (!m) return;

    // 1. Render immediate card with cached journey or placeholder
    const cached = journeyCache[trainId];
    m.marker.getPopup().setContent(renderTrainCard(m, cached));
    m.marker.openPopup();
    if (cached) {
      drawActiveTrainRoute(trainId, cached);
    }
    updateFollowButtons();

    // 2. Fetch fresh journey if not cached
    if (!cached) {
      try {
        let url = `/api/journey/${trainId}`;
        if (m && m.target) {
          url += `?lat=${m.target.lat.toFixed(5)}&lng=${m.target.lng.toFixed(5)}`;
        }
        const r = await fetch(url);
        if (!r.ok) return;
        const jData = await r.json();
        journeyCache[trainId] = jData;
        drawActiveTrainRoute(trainId, jData);

        // If this train's popup is still open, smoothly update the route container
        if (openPopupId === trainId && m.marker.isPopupOpen()) {
          const box = document.getElementById(`route-box-${trainId}`);
          if (box) {
            const delayClass = jData.current_delay > 0 ? "delayed" : "ontime";
            const delayText = jData.current_delay > 0 ? `+${jData.current_delay} min vertraging` : "Op tijd";
            const isAtDest = jData.next_stop && jData.next_stop.at_destination;
            const isAtStation = jData.next_stop && jData.next_stop.at_station;
            let nextLabel = "Volgende:";
            if (isAtDest) {
              nextLabel = "🏁 Eindpunt:";
            } else if (isAtStation) {
              nextLabel = "🚉 Halteert:";
            }
            const nextStopName = jData.next_stop ? jData.next_stop.name : (jData.destination || "Eindpunt");
            const nextStopTrack = jData.next_stop && jData.next_stop.track ? `<span class="ns-track">Spoor ${jData.next_stop.track}</span>` : "";

            box.innerHTML = `
              <div class="popup-route-line" title="${jData.origin} naar ${jData.destination}">
                <span>${jData.origin || "—"}</span>
                <span class="route-arrow">➔</span>
                <span>${jData.destination || "—"}</span>
              </div>
              <div class="popup-next-stop">
                <span>${nextLabel} <b>${nextStopName}</b></span>
                ${nextStopTrack}
              </div>
              <div class="popup-status-delay">
                <span style="color:#8fa8cc;">Status:</span>
                <span class="delay-pill ${delayClass}">${delayText}</span>
              </div>
            `;
          }
        }
      } catch (_) {}
    }
  }

  // ── Active Route Tracing & Train Following ──────────────────────
  function drawActiveTrainRoute(trainId, journey) {
    activeRouteLayer.clearLayers();
    if (!journey || !journey.stops || journey.stops.length < 2) return;

    const m = markers[trainId];
    const trainPos = m ? (m.displayed || m.target) : null;
    const stops = journey.stops.filter((s) => s.lat != null && s.lng != null);
    if (stops.length < 2) return;

    const nextIdx = stops.findIndex((s) => s.state === "next");
    const activeIdx = nextIdx !== -1 ? nextIdx : stops.length - 1;

    // 1. Passed route track (stops[0] .. stops[activeIdx-1] and train current pos)
    const passedCoords = [];
    for (let i = 0; i < activeIdx; i++) {
      passedCoords.push([stops[i].lat, stops[i].lng]);
    }
    if (trainPos && activeIdx > 0) {
      passedCoords.push([trainPos.lat, trainPos.lng]);
    }
    if (passedCoords.length >= 2) {
      L.polyline(passedCoords, {
        color: "#8fa8cc",
        weight: 3.5,
        opacity: 0.45,
        dashArray: "5, 8",
        lineCap: "round",
        interactive: false,
      }).addTo(activeRouteLayer);
    }

    // 2. Remaining active route track (train current pos .. stops[activeIdx] .. destination)
    const remainingCoords = [];
    if (trainPos) {
      remainingCoords.push([trainPos.lat, trainPos.lng]);
    }
    for (let i = activeIdx; i < stops.length; i++) {
      remainingCoords.push([stops[i].lat, stops[i].lng]);
    }
    if (remainingCoords.length >= 2) {
      // Outer ambient glow in NS yellow
      L.polyline(remainingCoords, {
        color: "rgba(255, 201, 23, 0.35)",
        weight: 8,
        opacity: 0.85,
        lineCap: "round",
        interactive: false,
      }).addTo(activeRouteLayer);

      // Core crisp path
      L.polyline(remainingCoords, {
        color: "#FFC917",
        weight: 3.8,
        opacity: 0.95,
        lineCap: "round",
        interactive: false,
      }).addTo(activeRouteLayer);
    }

    // 3. Station waypoints along the route path
    stops.forEach((s, idx) => {
      const isPast = idx < activeIdx;
      const isNext = idx === activeIdx;
      const isDest = idx === stops.length - 1;

      const fillColor = isDest ? "#00e676" : (isNext ? "#FFC917" : (isPast ? "#5577aa" : "#ffffff"));
      const radius = isNext ? 6.5 : (isDest ? 5.5 : 4);

      const circle = L.circleMarker([s.lat, s.lng], {
        radius: radius,
        fillColor: fillColor,
        color: "#ffffff",
        weight: isNext ? 2.5 : 1.5,
        fillOpacity: 1,
        className: isNext ? "pulse-stop-marker" : "",
      });

      const delayInfo = s.delay_minutes > 0 ? ` (+${s.delay_minutes} min)` : "";
      circle.bindTooltip(`<b>${s.name}</b><br/>${s.time || "—"}${delayInfo}${s.track ? ` · Spoor ${s.track}` : ""}`, {
        direction: "top",
        offset: [0, -6],
        className: "route-stop-tooltip",
      });

      circle.addTo(activeRouteLayer);
    });
  }

  function hideCockpitHUD() {
    if ($cockpitHud) $cockpitHud.classList.remove("active");
  }

  function updateFollowButtons() {
    if (followedTrainId === null) {
      hideCockpitHUD();
    }
    if (openPopupId !== null) {
      const btn = document.getElementById(`follow-btn-${openPopupId}`);
      if (btn) {
        if (followedTrainId === openPopupId) {
          btn.classList.add("active");
          btn.innerHTML = "⏹️ Stop";
        } else {
          btn.classList.remove("active");
          btn.innerHTML = "🎯 Volg Trein";
        }
      }
    }
    if ($drawerFollow && activeSelectedTrainId !== null) {
      if (followedTrainId === activeSelectedTrainId) {
        $drawerFollow.classList.add("active");
        $drawerFollow.innerHTML = "⏹️ Stop";
      } else {
        $drawerFollow.classList.remove("active");
        $drawerFollow.innerHTML = "🎯 Volg";
      }
    }
  }

  window.toggleFollowTrain = function (trainId) {
    if (followedTrainId === trainId) {
      followedTrainId = null;
      hideCockpitHUD();
    } else {
      followedTrainId = trainId;
      activeSelectedTrainId = trainId;
      playNSChime();
      const m = markers[trainId];
      if (m) {
        const p = m.displayed || m.target;
        map.panTo([p.lat, p.lng], { animate: true, duration: 0.6 });
        updateCockpitHUD(m);
      }
    }
    updateFollowButtons();
  };

  function updateCockpitHUD(m) {
    if (!$cockpitHud || !m) return;
    $cockpitHud.classList.add("active");

    const cat = trainCategory(m.type);
    if ($cockpitBadge) {
      $cockpitBadge.textContent = cat.toUpperCase();
      $cockpitBadge.className = `cockpit-badge ${cat}`;
    }
    if ($cockpitTrainNum) {
      $cockpitTrainNum.textContent = `Trein ${m.id}`;
    }

    if ($cockpitSpeedNum) {
      const spd = Math.round(m.speed || 0);
      $cockpitSpeedNum.textContent = String(spd);
      if (spd >= 100) {
        $cockpitSpeedNum.classList.add("high-speed");
      } else {
        $cockpitSpeedNum.classList.remove("high-speed");
      }
    }

    if ($cockpitHeading) {
      const hdg = Math.round(m.heading || 0);
      $cockpitHeading.textContent = `🧭 ${hdg}° · ${headingToCompass(hdg)}`;
    }

    const j = journeyCache[m.id];
    if (j) {
      if ($cockpitRoute) {
        const orig = j.origin || "";
        const dest = j.destination || "";
        $cockpitRoute.textContent = (orig && dest) ? `${orig} ➔ ${dest}` : (dest || "Onderweg");
      }

      if (j.next_stop) {
        const ns = j.next_stop;
        if (ns.at_station && audioEnabled) {
          const stopKey = `${m.id}_${ns.name}`;
          if (lastAnnouncedStopKey !== stopKey) {
            lastAnnouncedStopKey = stopKey;
            playNSChime();
          }
        }

        if ($cockpitNextName) {
          const trk = ns.track ? ` (Sp. ${ns.track})` : "";
          $cockpitNextName.textContent = `${ns.name}${trk}`;
        }

        if ($cockpitDistance) {
          if (ns.at_destination) {
            $cockpitDistance.textContent = "🏁 Eindpunt bereikt";
            $cockpitDistance.style.color = "#FFC917";
          } else if (ns.at_station) {
            $cockpitDistance.textContent = "🚉 Halteert op station";
            $cockpitDistance.style.color = "#00e676";
          } else if (ns.lat && ns.lng && m.displayed) {
            const distM = distanceMeters(m.displayed.lat, m.displayed.lng, ns.lat, ns.lng);
            const distKm = distM / 1000;
            const distStr = distKm < 1 ? `${Math.round(distM)} m` : `${distKm.toFixed(1)} km`;
            const dMin = ns.delay_minutes > 0 ? ` (+${ns.delay_minutes}m)` : "";
            $cockpitDistance.textContent = `📍 nog ${distStr}${dMin}`;
            $cockpitDistance.style.color = "#00e676";
          } else if (ns.time) {
            $cockpitDistance.textContent = `Aankomst: ${ns.time}`;
            $cockpitDistance.style.color = "#8fa8cc";
          }
        }
      } else {
        if ($cockpitNextName) $cockpitNextName.textContent = "—";
        if ($cockpitDistance) $cockpitDistance.textContent = "";
      }
    } else {
      if ($cockpitRoute) $cockpitRoute.textContent = "Dienstregeling laden…";
      if ($cockpitNextName) $cockpitNextName.textContent = "—";
      if ($cockpitDistance) $cockpitDistance.textContent = "";
      if (!m._fetchingJourney) {
        m._fetchingJourney = true;
        fetchJourneyForCache(m.id, m.displayed || m.target);
      }
    }
  }

  async function fetchJourneyForCache(trainId, pos) {
    try {
      let url = `/api/journey/${trainId}`;
      if (pos && pos.lat) url += `?lat=${pos.lat.toFixed(5)}&lng=${pos.lng.toFixed(5)}`;
      const r = await fetch(url);
      if (r.ok) {
        journeyCache[trainId] = await r.json();
      }
    } catch (_) {}
  }

  if ($cockpitStopBtn) {
    $cockpitStopBtn.addEventListener("click", () => {
      if (followedTrainId !== null) {
        window.toggleFollowTrain(followedTrainId);
      }
    });
  }
  if ($cockpitJourneyBtn) {
    $cockpitJourneyBtn.addEventListener("click", () => {
      if (followedTrainId !== null) {
        window.openJourney(followedTrainId);
      }
    });
  }
  if ($cockpitInfoClick) {
    $cockpitInfoClick.addEventListener("click", () => {
      if (followedTrainId !== null) {
        window.openJourney(followedTrainId);
      }
    });
  }

  // ── NS Acoustic Chime Synthesizer (Web Audio API) ────────────────
  function getAudioContext() {
    if (!audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioCtx = new AudioCtx();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playTone(freq, startTime, duration, masterGain) {
    if (!audioCtx) return;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc1.type = "sine";
    osc1.frequency.setValueAtTime(freq, startTime);

    // Warm bell-like 2nd harmonic
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(freq * 2, startTime);

    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.24, startTime + 0.008);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(masterGain);

    osc1.start(startTime);
    osc2.start(startTime);
    osc1.stop(startTime + duration + 0.05);
    osc2.stop(startTime + duration + 0.05);
  }

  function playNSChime() {
    if (!audioEnabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.28, now);
      master.connect(ctx.destination);

      // Authentic NS two-tone chime: G4 (391.995 Hz) -> E4 (329.628 Hz)
      playTone(391.995, now + 0.02, 0.42, master);
      playTone(329.628, now + 0.38, 0.72, master);
    } catch (_) {}
  }

  function updateAudioButton() {
    if (!$audioBtn) return;
    if (audioEnabled) {
      $audioBtn.classList.add("active");
      $audioBtn.innerHTML = "🔊";
      $audioBtn.title = "NS Stationsgong ingeschakeld (klik om te dempen)";
    } else {
      $audioBtn.classList.remove("active");
      $audioBtn.innerHTML = "🔇";
      $audioBtn.title = "NS Stationsgong gedempt (klik om in te schakelen)";
    }
  }

  if ($audioBtn) {
    $audioBtn.addEventListener("click", () => {
      audioEnabled = !audioEnabled;
      try {
        localStorage.setItem("nachtlijn_audio_enabled", audioEnabled ? "true" : "false");
      } catch (_) {}
      updateAudioButton();
      if (audioEnabled) {
        getAudioContext();
        playNSChime();
      }
    });
  }

  // ── Geo math ─────────────────────────────────────────────────────
  function distanceMeters(lat1, lng1, lat2, lng2) {
    const cosLat = Math.cos(((lat1 + lat2) / 2) * DEG2RAD);
    const dx = (lng2 - lng1) * cosLat * 111320;
    const dy = (lat2 - lat1) * 110540;
    return Math.hypot(dx, dy);
  }

  function bearingDeg(lat1, lng1, lat2, lng2) {
    const y = Math.sin((lng2 - lng1) * DEG2RAD) * Math.cos(lat2 * DEG2RAD);
    const x = Math.cos(lat1 * DEG2RAD) * Math.sin(lat2 * DEG2RAD) -
              Math.sin(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.cos((lng2 - lng1) * DEG2RAD);
    return (Math.atan2(y, x) / DEG2RAD + 360) % 360;
  }

  function extrapolate(lat, lng, speedKmh, headingDeg, dtSec) {
    const d = (speedKmh / 3.6) * dtSec;
    const brng = headingDeg * DEG2RAD;
    const lat1 = lat * DEG2RAD;
    const lng1 = lng * DEG2RAD;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d / EARTH_R) +
      Math.cos(lat1) * Math.sin(d / EARTH_R) * Math.cos(brng)
    );
    const lng2 = lng1 + Math.atan2(
      Math.sin(brng) * Math.sin(d / EARTH_R) * Math.cos(lat1),
      Math.cos(d / EARTH_R) - Math.sin(lat1) * Math.sin(lat2)
    );
    return { lat: lat2 / DEG2RAD, lng: lng2 / DEG2RAD };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Snap train coordinates onto the physical rail track using the 2D spatial grid
  function snapToTrack(lat, lng, heading) {
    const gx = Math.floor(lng / GRID_CELL_SIZE);
    const gy = Math.floor(lat / GRID_CELL_SIZE);
    const cosLat = Math.cos(lat * DEG2RAD);

    let bestDist = 1e9;
    let bestProj = null;
    let bestFeat = null;
    let bestSeg = null;
    let bestT = 0;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = trackSpatialGrid[`${gx + dx}_${gy + dy}`];
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const seg = bucket[i]; // [lat1, lng1, lat2, lng2, fIdx, sIdx]
          const lat1 = seg[0], lng1 = seg[1], lat2 = seg[2], lng2 = seg[3];

          const vx = (lng2 - lng1) * cosLat * 111320;
          const vy = (lat2 - lat1) * 110540;
          const wx = (lng - lng1) * cosLat * 111320;
          const wy = (lat - lat1) * 110540;

          const segLenSq = vx * vx + vy * vy;
          if (segLenSq < 1e-6) continue;

          const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / segLenSq));
          const pLat = lat1 + t * (lat2 - lat1);
          const pLng = lng1 + t * (lng2 - lng1);

          const dX = (lng - pLng) * cosLat * 111320;
          const dY = (lat - pLat) * 110540;
          const dist = Math.hypot(dX, dY);

          if (dist < bestDist) {
            bestDist = dist;
            bestProj = { lat: pLat, lng: pLng };
            bestFeat = seg[4];
            bestSeg = seg[5];
            bestT = t;
          }
        }
      }
    }

    // Snap to track centerline if within 95m (standard ProRail corridor tolerance)
    if (bestDist <= 95 && bestProj) {
      return {
        snapped: true,
        lat: bestProj.lat,
        lng: bestProj.lng,
        dist: bestDist,
        fIdx: bestFeat,
        sIdx: bestSeg,
        t: bestT
      };
    }

    // Keep raw coordinates if outside 95m (e.g. maintenance depot siding)
    return {
      snapped: false,
      lat: lat,
      lng: lng,
      dist: bestDist
    };
  }

  // Advance smoothly along physical rail polyline curves
  function advanceAlongTrack(latlngs, sIdx, t, distanceMeters, forward) {
    if (!latlngs || latlngs.length < 2) return { lat: 0, lng: 0 };
    let remDist = distanceMeters;
    let currS = sIdx;
    let currT = t;

    while (remDist > 0) {
      let p1, p2;
      if (forward) {
        if (currS >= latlngs.length - 1) {
          const last = latlngs[latlngs.length - 1];
          return { lat: last[0], lng: last[1] };
        }
        p1 = latlngs[currS];
        p2 = latlngs[currS + 1];
      } else {
        if (currS < 0) {
          const first = latlngs[0];
          return { lat: first[0], lng: first[1] };
        }
        p1 = latlngs[currS + 1];
        p2 = latlngs[currS];
      }

      const cosLat = Math.cos(p1[0] * DEG2RAD);
      const segDist = Math.hypot((p2[1] - p1[1]) * cosLat * 111320, (p2[0] - p1[0]) * 110540);
      const availDist = segDist * (1.0 - currT);

      if (remDist <= availDist) {
        const finalT = currT + (remDist / Math.max(1e-6, segDist));
        return {
          lat: p1[0] + finalT * (p2[0] - p1[0]),
          lng: p1[1] + finalT * (p2[1] - p1[1])
        };
      } else {
        remDist -= availDist;
        currT = 0.0;
        if (forward) {
          currS++;
        } else {
          currS--;
          if (currS < 0) {
            const first = latlngs[0];
            return { lat: first[0], lng: first[1] };
          }
        }
      }
    }

    if (forward) {
      const idx = Math.min(currS, latlngs.length - 1);
      return { lat: latlngs[idx][0], lng: latlngs[idx][1] };
    } else {
      const idx = Math.max(0, currS);
      return { lat: latlngs[idx][0], lng: latlngs[idx][1] };
    }
  }

  // ── Netherlands National Border Outline ──────────────────────────
  async function loadBorder() {
    try {
      const r = await fetch("/api/border");
      if (!r.ok) return;
      const geo = await r.json();

      // Outer soft cyan aura glow & very subtle landmass glass tint
      borderGlowLayer = L.geoJSON(geo, {
        style: {
          color: "#38bdf8",
          weight: 6,
          opacity: 0.25,
          fillColor: "#0284c7",
          fillOpacity: 0.025,
          lineJoin: "round",
          lineCap: "round"
        },
        interactive: false
      });

      // Sharp prominent Dutch national boundary edge
      borderLayer = L.geoJSON(geo, {
        style: {
          color: "#93c5fd",
          weight: 2,
          opacity: 0.85,
          dashArray: "7, 6",
          lineJoin: "round",
          lineCap: "round"
        },
        interactive: false
      });

      syncToggleLayers();
    } catch (_) {}
  }

  // ── Tracks Layer & Track Indexing ────────────────────────────────
  async function loadTracks() {
    try {
      const r = await fetch("/api/tracks");
      if (!r.ok) return;
      const geo = await r.json();

      // Index track geometry by from/to station codes and build 2D spatial grid for track snapping
      const features = geo.features || [];
      for (let fIdx = 0; fIdx < features.length; fIdx++) {
        const feat = features[fIdx];
        const props = feat.properties || {};
        const f = (props.from || "").toLowerCase();
        const t = (props.to || "").toLowerCase();
        const coords = feat.geometry ? feat.geometry.coordinates : [];
        if (coords.length > 0) {
          // Convert GeoJSON [lng, lat] to Leaflet [lat, lng]
          const latlngs = coords.map(c => [c[1], c[0]]);
          trackFeatures[fIdx] = latlngs;

          if (f && t) {
            trackIndex[`${f}_${t}`] = latlngs;
            trackIndex[`${t}_${f}`] = [...latlngs].reverse();
          }

          // Populate 2D spatial grid for microsecond snapping
          for (let sIdx = 0; sIdx < latlngs.length - 1; sIdx++) {
            const lat1 = latlngs[sIdx][0];
            const lng1 = latlngs[sIdx][1];
            const lat2 = latlngs[sIdx + 1][0];
            const lng2 = latlngs[sIdx + 1][1];

            const minGx = Math.floor(Math.min(lng1, lng2) / GRID_CELL_SIZE);
            const maxGx = Math.floor(Math.max(lng1, lng2) / GRID_CELL_SIZE);
            const minGy = Math.floor(Math.min(lat1, lat2) / GRID_CELL_SIZE);
            const maxGy = Math.floor(Math.max(lat1, lat2) / GRID_CELL_SIZE);

            const seg = [lat1, lng1, lat2, lng2, fIdx, sIdx];

            for (let gx = minGx; gx <= maxGx; gx++) {
              for (let gy = minGy; gy <= maxGy; gy++) {
                const key = `${gx}_${gy}`;
                if (!trackSpatialGrid[key]) trackSpatialGrid[key] = [];
                trackSpatialGrid[key].push(seg);
              }
            }
          }
        }
      }

      // Halo layer (wide subtle glow)
      L.geoJSON(geo, {
        style: { color: "#4a9eff", weight: 5, opacity: 0.08 },
        interactive: false,
      }).addTo(map);

      // Core rail layer
      tracksLayer = L.geoJSON(geo, {
        style: { color: "#4a9eff", weight: 1.5, opacity: 0.45 },
        interactive: false,
      }).addTo(map);

      // If disruptions were already fetched, re-render them with curved track snapping
      if (disruptionsData && disruptionsData.disruptions && disruptionsVisible) {
        renderDisruptions(disruptionsData.disruptions);
      }
    } catch (_) {}
  }

  // ── Stations Layer & Live Departure Boards ────────────────────────
  async function loadStations() {
    try {
      const r = await fetch("/api/stations");
      if (!r.ok) return;
      stationsData = await r.json();
      syncToggleLayers();
    } catch (_) {}
  }

  function showStations() {
    if (!stationsData) return;
    if (stationsLayer) {
      if (!map.hasLayer(stationsLayer)) stationsLayer.addTo(map);
      return;
    }
    stationsLayer = L.layerGroup();

    for (const s of stationsData) {
      if (s.country && s.country !== "NL") continue;

      const isHub = s.type === "KNOOPPUNT_INTERCITY_STATION" || s.type === "INTERCITY_STATION";
      const dotClass = isHub ? "station-dot hub" : "station-dot";
      const iconSize = isHub ? [12, 12] : [8, 8];

      const m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: dotClass, iconSize: iconSize }),
        zIndexOffset: isHub ? 50 : 0
      });

      // Tooltip on hover
      m.bindTooltip(`<b>${s.name}</b>`, {
        direction: "top",
        offset: [0, -8],
        className: "station-tooltip"
      });

      // Popup on click (loading departure board)
      m.bindPopup(`<div style="padding:10px;font-size:12px;color:#c0cadb;">Vertrektijden laden voor <b>${s.name}</b>…</div>`, {
        maxWidth: 360,
        className: "ns-departure-popup"
      });

      m.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        fetchStationDepartures(s, m);
      });

      m.on("popupclose", () => {
        updateUrlParam("station", null);
      });

      if (s.code) {
        stationMarkers[s.code.toUpperCase()] = { marker: m, station: s };
      }

      stationsLayer.addLayer(m);
    }

    stationsLayer.addTo(map);

    if (pendingUrlStationCode && stationMarkers[pendingUrlStationCode]) {
      const code = pendingUrlStationCode;
      pendingUrlStationCode = null;
      const entry = stationMarkers[code];
      map.flyTo([entry.station.lat, entry.station.lng], Math.max(map.getZoom(), 13), { duration: 1.2 });
      setTimeout(() => {
        entry.marker.openPopup();
        fetchStationDepartures(entry.station, entry.marker);
      }, 400);
    }
  }

  window.focusStation = function (stationCode) {
    if (!stationCode) return;
    const code = stationCode.toUpperCase();
    if (stationMarkers[code]) {
      const entry = stationMarkers[code];
      map.flyTo([entry.station.lat, entry.station.lng], Math.max(map.getZoom(), 13), { duration: 1.2 });
      entry.marker.openPopup();
      fetchStationDepartures(entry.station, entry.marker);
    } else {
      pendingUrlStationCode = code;
    }
  };

  function hideStations() {
    if (stationsLayer && map.hasLayer(stationsLayer)) {
      map.removeLayer(stationsLayer);
    }
  }

  async function fetchStationDepartures(station, marker) {
    updateUrlParam("station", station.code);
    try {
      const r = await fetch(`/api/departures/${station.code}`);
      if (!r.ok) throw new Error();
      const data = await r.json();
      const deps = data.departures || [];

      let rowsHtml = "";
      if (deps.length === 0) {
        rowsHtml = `<tr><td colspan="3" style="color:#8fa8cc;padding:12px;text-align:center;">Geen actuele vertrektijden gevonden</td></tr>`;
      } else {
        for (const d of deps) {
          const delayHtml = d.delay_minutes > 0 ? `<span class="ns-delay">+${d.delay_minutes}</span>` : "";
          const catClass = d.category === "IC" ? "IC" : d.category === "SPR" ? "SPR" : "other";
          const trackHtml = d.track_changed
            ? `<span class="ns-track track-changed" title="Spoorwijziging: van spoor ${d.planned_track} naar ${d.actual_track}"><s class="track-old">${d.planned_track}</s> <b class="track-new">${d.actual_track}</b></span>`
            : `<span class="ns-track">${d.track || "—"}</span>`;

          rowsHtml += `
            <tr class="dep-clickable-row" onclick="window.focusTrainFromDeparture('${d.number}')" title="Klik om trein ${d.number} te volgen en dienstregeling te bekijken">
              <td><span class="ns-time">${d.planned_time}</span>${delayHtml}</td>
              <td>
                <div class="ns-dest">${d.direction}</div>
                <div class="ns-type ${catClass}">${d.category_name} ${d.number} <span class="dep-row-arrow">➔</span></div>
              </td>
              <td style="text-align:right;">${trackHtml}</td>
            </tr>
          `;
        }
      }

      const boardHtml = `
        <div class="ns-board">
          <div class="ns-board-head">
            <span>🚉 Station ${station.name}</span>
            <span style="font-size:10px;opacity:0.85;">Vertrektijden</span>
          </div>
          <div class="ns-board-body">
            <table class="ns-dep-table">
              <thead>
                <tr>
                  <th style="width:72px;">Tijd</th>
                  <th>Bestemming</th>
                  <th style="text-align:right;">Spoor</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      `;
      marker.getPopup().setContent(boardHtml);
    } catch (_) {
      marker.getPopup().setContent(`<div style="padding:10px;color:#ff5252;">Kon vertrektijden niet ophalen.</div>`);
    }
  }

  window.focusTrainFromDeparture = function (trainNumber) {
    if (!trainNumber) return;
    const tid = parseInt(trainNumber, 10);
    map.closePopup();

    if (markers[tid]) {
      const pos = markers[tid].displayed;
      map.flyTo([pos.lat, pos.lng], Math.max(map.getZoom(), 12), { duration: 1.2 });
      followedTrainId = tid;
      updateFollowButtons();
      window.openJourney(tid);
    } else {
      window.openJourney(tid);
      if ($feedback) {
        $feedback.textContent = `Trein ${tid} geselecteerd (dienstregeling geopend, wacht op live radar fix)`;
        setTimeout(() => {
          if ($feedback.textContent.includes(String(tid))) $feedback.textContent = "";
        }, 4000);
      }
    }
  };

  $stationCb.addEventListener("change", syncToggleLayers);

  map.on("zoomend", () => {
    if (stationsVisible && map.getZoom() >= 7) showStations();
    else hideStations();
  });

  // ── Disruption Overlay (Curved Rail Snapped) ──────────────────────
  async function loadDisruptions() {
    try {
      const r = await fetch("/api/disruptions");
      if (!r.ok) return;
      disruptionsData = await r.json();
      const list = disruptionsData.disruptions || [];
      $disruptionsLbl.textContent = `🚨 Rail disruptions (${list.length})`;
      if (disruptionsVisible) {
        renderDisruptions(list);
      }
      syncToggleLayers();
    } catch (_) {
      $disruptionsLbl.textContent = `🚨 Rail disruptions (offline)`;
    }
  }

  function renderDisruptions(list) {
    if (disruptionsLayer) {
      map.removeLayer(disruptionsLayer);
    }
    disruptionsLayer = L.layerGroup();

    for (const d of list) {
      const popupContent = `
        <div style="font-size:12.5px;line-height:1.5;max-width:280px;padding:4px;">
          <div style="font-weight:800;color:#ff3344;margin-bottom:5px;font-size:13.5px;">🚨 ${d.title}</div>
          ${d.cause ? `<div><b>Oorzaak:</b> ${d.cause}</div>` : ""}
          ${d.delay ? `<div><b>Vertraging:</b> <span style="color:#ffcc00;font-weight:700;">${d.delay}</span></div>` : ""}
          ${d.period ? `<div style="color:#8fa8cc;font-size:11px;margin-top:4px;">📅 ${d.period}</div>` : ""}
          ${d.situation ? `<div style="font-size:11px;margin-top:6px;color:#e0e6f0;background:rgba(255,255,255,0.06);padding:6px;border-radius:4px;">${d.situation}</div>` : ""}
        </div>
      `;

      for (const sec of d.sections) {
        // Collect continuous physical corridor rail coordinates
        let corridorCoords = [];
        for (let i = 0; i < sec.length - 1; i++) {
          const s1 = (sec[i].code || "").toLowerCase();
          const s2 = (sec[i + 1].code || "").toLowerCase();
          const trackKey = `${s1}_${s2}`;

          const coords = trackIndex[trackKey] || (
            (sec[i].lat && sec[i].lng && sec[i + 1].lat && sec[i + 1].lng)
              ? [[sec[i].lat, sec[i].lng], [sec[i + 1].lat, sec[i + 1].lng]]
              : null
          );

          if (coords) {
            if (corridorCoords.length > 0) {
              corridorCoords.push(...coords.slice(1));
            } else {
              corridorCoords.push(...coords);
            }
          }
        }

        if (corridorCoords.length >= 2) {
          // 1. Wide pulsing ambient danger aura
          const glowPoly = L.polyline(corridorCoords, {
            color: "#ff1744",
            weight: 12,
            opacity: 0.28,
            lineCap: "round",
            lineJoin: "round",
            interactive: false
          });
          disruptionsLayer.addLayer(glowPoly);

          // 2. High-visibility solid red rail track
          const basePoly = L.polyline(corridorCoords, {
            color: "#d50000",
            weight: 5,
            opacity: 0.95,
            lineCap: "round",
            lineJoin: "round",
            interactive: true
          });
          basePoly.bindPopup(popupContent, { maxWidth: 320 });
          basePoly.bindTooltip(`🚨 ${d.title}`, { sticky: true, className: "station-tooltip" });

          basePoly.on("mouseover", () => {
            glowPoly.setStyle({ weight: 18, opacity: 0.55 });
            basePoly.setStyle({ weight: 7, color: "#ff1744" });
          });
          basePoly.on("mouseout", () => {
            glowPoly.setStyle({ weight: 12, opacity: 0.28 });
            basePoly.setStyle({ weight: 5, color: "#d50000" });
          });

          disruptionsLayer.addLayer(basePoly);

          // 3. Dashed yellow hazard overlay stripe
          const dashPoly = L.polyline(corridorCoords, {
            color: "#ffca28",
            weight: 2.5,
            opacity: 0.9,
            dashArray: "7, 9",
            lineCap: "round",
            interactive: false
          });
          disruptionsLayer.addLayer(dashPoly);
        }

        // Place alert markers strictly anchored to station coordinates
        const badgeIndices = [0];
        if (sec.length > 2) badgeIndices.push(Math.floor(sec.length / 2));
        if (sec.length > 1) badgeIndices.push(sec.length - 1);

        for (const idx of badgeIndices) {
          const st = sec[idx];
          if (!st || !st.lat || !st.lng) continue;
          const badge = L.marker([st.lat, st.lng], {
            icon: L.divIcon({
              className: "disruption-marker-wrap",
              html: '<div class="disruption-badge-core">⚠️</div>',
              iconSize: [24, 24],
              iconAnchor: [12, 12]
            }),
            zIndexOffset: 120
          });
          badge.bindPopup(popupContent, { maxWidth: 320 });
          badge.bindTooltip(`🚨 ${d.title}`, { direction: "top", offset: [0, -12], className: "station-tooltip" });
          disruptionsLayer.addLayer(badge);
        }
      }
    }

    if (disruptionsVisible) {
      disruptionsLayer.addTo(map);
    }
  }

  $disruptionsCb.addEventListener("change", syncToggleLayers);

  // ── Rolling Stock Coach Composition Visualizer ──────────────────
  function buildCoachDiagramHtml(data) {
    const isIntercity = (data.category_name && data.category_name.toLowerCase().includes("intercity")) || (data.train_type && ["VIRM", "ICM", "ICNG", "TRAXX"].some(t => data.train_type.toUpperCase().includes(t)));
    const trainModel = data.train_type || (isIntercity ? "VIRM-4 Dubbeldekker" : "SNG-4 Sprinter");
    const numCars = (data.composition && data.composition.length > 0) ? data.composition.length : (data.parts || 4);

    let coaches = [];
    if (data.composition && data.composition.length > 0) {
      coaches = data.composition.map((c, i) => {
        const isFront = (i === 0);
        const isRear = (i === data.composition.length - 1);
        const has1st = (i === 0);
        return {
          cab: isFront ? "front-cab" : isRear ? "rear-cab" : "mid-car",
          classNum: has1st ? "1" : "2",
          isFirstClass: has1st,
          facilities: c.facilities && c.facilities.length > 0 ? c.facilities : (has1st ? ["📶"] : (i === 1 ? ["🚲"] : (i === 2 ? ["♿", "🚻"] : ["📶"]))),
          label: c.identifier || `Rijtuig ${i + 1}`
        };
      });
    } else {
      for (let i = 0; i < Math.max(numCars, 3); i++) {
        const isFront = (i === 0);
        const isRear = (i === numCars - 1);
        const has1st = (i === 0);
        let facs = ["📶"];
        if (i === 1) facs = ["🚲", "📶"];
        if (i === 2) facs = ["♿", "🚻", "📶"];
        coaches.push({
          cab: isFront ? "front-cab" : isRear ? "rear-cab" : "mid-car",
          classNum: has1st ? "1" : "2",
          isFirstClass: has1st,
          facilities: facs,
          label: `Rijtuig ${i + 1}`
        });
      }
    }

    let coachesHtml = "";
    coaches.forEach((c) => {
      const classBadgeClass = c.isFirstClass ? "coach-class-num c1" : "coach-class-num c2";
      const facIcons = c.facilities.join(" ");
      coachesHtml += `
        <div class="train-coach ${c.cab}" title="${c.label}: ${c.isFirstClass ? '1e & 2e klas' : '2e klas'} • Faciliteiten: ${c.facilities.join(', ')}">
          <span class="${classBadgeClass}">${c.classNum}</span>
          <div class="coach-icons">${facIcons}</div>
        </div>
      `;
    });

    const seatsStr = data.seats ? `${data.seats} zitplaatsen` : "Reguliere capaciteit";
    return `
      <div class="stock-meta-row">
        ${data.image_url ? `<img src="${data.image_url}" class="stock-img" alt="${trainModel}"/>` : ""}
        <div class="stock-details">
          <span class="stock-title">🚆 ${trainModel} (${coaches.length}-delig)</span>
          <span class="stock-seats">${seatsStr} • ${data.operator || "NS"}</span>
        </div>
      </div>
      <div class="stock-train-diagram">
        <div class="train-composition-track">
          ${coachesHtml}
        </div>
        <div class="train-legend">
          <span><b class="class-badge c1">1</b> 1e klas</span>
          <span><b class="class-badge c2">2</b> 2e klas</span>
          <span>♿ Rolstoel</span>
          <span>🚲 Fiets</span>
          <span>🚻 WC</span>
          <span>📶 WiFi</span>
        </div>
      </div>
    `;
  }

  // ── Journey Timeline Drawer ──────────────────────────────────────
  window.openJourney = async function (trainId) {
    activeSelectedTrainId = trainId;
    updateUrlParam("train", trainId);
    playNSChime();
    $drawer.classList.remove("drawer-closed");
    $drawerTitle.textContent = `Trein ${trainId}`;
    $drawerSub.textContent = `Dienstregeling en haltes ophalen…`;
    $drawerStock.style.display = "none";
    $drawerTimeline.innerHTML = `<div class="timeline-empty">Haltes laden…</div>`;

    // Automatically close open map popup to prevent visual overlap
    if (openPopupId !== null) {
      const pm = markers[openPopupId];
      if (pm && pm.marker) pm.marker.closePopup();
      openPopupId = null;
    }
    updateFollowButtons();

    const m = markers[trainId];
    if (m) {
      const cat = trainCategory(m.type);
      $drawerBadge.textContent = cat.toUpperCase();
      $drawerBadge.className = `drawer-badge ${cat}`;
    }

    try {
      let url = `/api/journey/${trainId}`;
      if (m && m.target) {
        url += `?lat=${m.target.lat.toFixed(5)}&lng=${m.target.lng.toFixed(5)}`;
      }
      const r = await fetch(url);
      if (!r.ok) throw new Error("Not found");
      const data = await r.json();
      journeyCache[trainId] = data;
      drawActiveTrainRoute(trainId, data);
      updateFollowButtons();

      $drawerTitle.textContent = `${categoryLabel(data.train_type || "Trein")} ${trainId}`;
      $drawerSub.textContent = `${data.origin || ""} ➔ ${data.destination || ""}`;

      // Rolling stock coach composition visualizer
      $drawerStock.style.display = "flex";
      $drawerStock.innerHTML = buildCoachDiagramHtml(data);

      // Next station highlight banner
      let bannerHtml = "";
      if (data.next_stop) {
        const isAtDest = data.next_stop.at_destination;
        const isAtStation = data.next_stop.at_station;
        let bannerTag = "📍 Volgende station / Next stop";
        let timeLabel = "Aankomst";
        if (isAtDest) {
          bannerTag = "🏁 Eindbestemming bereikt / Terminus";
          timeLabel = "Aangekomen";
        } else if (isAtStation) {
          bannerTag = "🚉 Halteert momenteel te / At Station";
          timeLabel = "Vertrek";
        }
        const delayText = data.next_stop.delay_minutes > 0 ? `<span class="ns-delay">+${data.next_stop.delay_minutes} min</span>` : "<span style='color:#00e676;'>Op tijd</span>";
        let trackText = "";
        if (data.next_stop.track) {
          if (data.next_stop.track_changed) {
            trackText = `<span class="ns-track track-changed" title="Spoorwijziging">Spoor <s class="track-old">${data.next_stop.planned_track}</s> <b class="track-new">${data.next_stop.actual_track}</b></span>`;
          } else {
            trackText = `<span class="ns-track">Spoor ${data.next_stop.track}</span>`;
          }
        }
        bannerHtml = `
          <div class="next-station-banner ${isAtDest ? "at-dest" : ""}">
            <span class="next-station-tag">${bannerTag}</span>
            <div class="next-station-title">${data.next_stop.name}</div>
            <div class="next-station-meta">
              ${trackText}
              <span>${timeLabel}: <b>${data.next_stop.time || "—"}</b></span>
              <span>(${delayText})</span>
            </div>
          </div>
        `;
      }

      // Timeline stops (only stopping stations, skipping all non-stopping '--' stations)
      let stopsHtml = bannerHtml;
      const nextIdx = data.stops.findIndex(s => s.state === "next");

      data.stops.forEach((s, idx) => {
        const isNext = s.state === "next";
        const isPrevToNext = (nextIdx !== -1 && idx === nextIdx - 1);
        let itemClass = "timeline-item upcoming";
        let nodeContent = "";

        if (isNext) {
          itemClass = "timeline-item next-stop";
          nodeContent = '<div class="node-pulse-halo"></div>';
        } else if (s.state === "passed") {
          itemClass = isPrevToNext ? "timeline-item passed prev-to-next" : "timeline-item passed";
          nodeContent = '<span class="node-passed-check">✓</span>';
        }

        let nextBadge = "";
        if (isNext) {
          if (s.at_destination) {
            nextBadge = `<span class="next-pill dest">EINDPUNT</span>`;
          } else if (s.at_station) {
            nextBadge = `<span class="next-pill station">HALTEERT NU</span>`;
          } else {
            nextBadge = `<span class="next-pill">VOLGENDE HALTE</span>`;
          }
        }
        const delayStr = s.delay_minutes > 0 ? `<span class="timeline-delay">+${s.delay_minutes} min</span>` : "";
        let trackStr = "";
        if (s.track) {
          if (s.track_changed) {
            trackStr = `<span class="timeline-track track-changed" title="Spoorwijziging">Spoor <s class="track-old">${s.planned_track}</s> <b class="track-new">${s.actual_track}</b></span>`;
          } else {
            trackStr = `<span class="timeline-track">Spoor ${s.track}</span>`;
          }
        }

        stopsHtml += `
          <div class="${itemClass}" ${isNext ? 'id="timeline-active-next"' : ""}>
            <div class="timeline-node">${nodeContent}</div>
            <div class="timeline-station">
              <span>${s.name} ${nextBadge}</span>
              ${trackStr}
            </div>
            <div class="timeline-times">
              <span>${s.time || "—"}</span>
              ${delayStr}
            </div>
          </div>
        `;
      });

      $drawerTimeline.innerHTML = stopsHtml || `<div class="timeline-empty">Geen haltes beschikbaar.</div>`;

      // Smoothly auto-scroll to the next stop
      setTimeout(() => {
        const nextEl = document.getElementById("timeline-active-next");
        if (nextEl) nextEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 150);
    } catch (_) {
      $drawerSub.textContent = "Geen route informatie beschikbaar";
      $drawerTimeline.innerHTML = `<div class="timeline-empty">Route details konden niet worden geladen voor deze rit.</div>`;
    }
  };

  $drawerClose.addEventListener("click", () => {
    $drawer.classList.add("drawer-closed");
    updateUrlParam("train", null);
    if (openPopupId === null) {
      activeRouteLayer.clearLayers();
      activeSelectedTrainId = null;
    }
    if (followedTrainId && followedTrainId === activeSelectedTrainId) {
      followedTrainId = null;
      updateFollowButtons();
    }
  });

  if ($drawerFollow) {
    $drawerFollow.addEventListener("click", () => {
      if (activeSelectedTrainId !== null) {
        window.toggleFollowTrain(activeSelectedTrainId);
      }
    });
  }

  // ── Filter Buttons ───────────────────────────────────────────────
  document.querySelectorAll(".filter-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type;
      visibleTypes[type] = !visibleTypes[type];
      btn.classList.toggle("active", visibleTypes[type]);
      updateMarkerVisibility();
    });
  });

  function updateMarkerVisibility() {
    for (const id in markers) {
      const m = markers[id];
      const cat = trainCategory(m.type);
      const isVisible = visibleTypes[cat];
      if (isVisible) {
        if (!map.hasLayer(m.marker)) map.addLayer(m.marker);
        if (showTrails && m.polyline && !map.hasLayer(m.polyline)) map.addLayer(m.polyline);
      } else {
        if (map.hasLayer(m.marker)) map.removeLayer(m.marker);
        if (m.polyline && map.hasLayer(m.polyline)) map.removeLayer(m.polyline);
      }
    }
  }

  $trailsCb.addEventListener("change", syncToggleLayers);
  if ($borderCb) $borderCb.addEventListener("change", syncToggleLayers);

  // ── Fetch Trains (Fallback Poller) ──────────────────────────────
  async function fetchTrains() {
    try {
      const r = await fetch("/api/trains");
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      fetchBackoff = 0;
      processTrains(data);
      connectionStatus = data.status || "live";
      const feedName = data.feed === "NDOV ZeroMQ Push" ? "Live Push" : (data.feed ? "REST" : "Live Push");
      updateHUDStatus(connectionStatus, feedName);
      if (!isSSEActive) {
        scheduleNext(data.next_update_at);
      }
    } catch (_) {
      connectionStatus = "offline";
      updateHUDStatus("offline", "Offline");
      fetchBackoff = Math.min(Math.max(fetchBackoff || 2, fetchBackoff * 2), 60);
      if (!isSSEActive) {
        scheduleNext(Date.now() / 1000 + fetchBackoff);
      }
    }
  }

  function scheduleNext(serverNext) {
    if (fetchTimer) clearTimeout(fetchTimer);
    if (isSSEActive) return;
    const now = Date.now() / 1000;
    let delaySec = serverNext ? (serverNext - now + 0.15) : 5;
    if (delaySec < 2.5) delaySec = 3.5;
    if (delaySec > 7) delaySec = 5;
    pollInterval = delaySec;
    nextUpdateAt = now + delaySec;
    fetchTimer = setTimeout(fetchTrains, delaySec * 1000);
  }

  // ── Server-Sent Events (SSE) Live Push Stream ─────────────────────
  function connectSSE() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    try {
      eventSource = new EventSource("/api/stream");

      eventSource.onopen = () => {
        isSSEActive = true;
        connectionStatus = "live";
        if (fetchTimer) {
          clearTimeout(fetchTimer);
          fetchTimer = null;
        }
        updateHUDStatus("live", "Live Push");
      };

      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          processTrains(data);
          connectionStatus = data.status || "live";
          const feedName = data.feed === "NDOV ZeroMQ Push" ? "Live Push" : (data.feed ? "REST" : "Live Push");
          updateHUDStatus(connectionStatus, feedName);

          // Pulse countdown ring to visually indicate live push packet arrival
          $ringFg.setAttribute("stroke-dashoffset", "0");
          $cdText.textContent = "LIVE";
        } catch (_) {}
      };

      eventSource.onerror = () => {
        isSSEActive = false;
        connectionStatus = "stale";
        updateHUDStatus("stale", "Reconnecting…");
        // Fall back to polling /api/trains if SSE drops
        if (!fetchTimer) {
          fetchTrains();
        }
        // Try to re-establish SSE after 5 seconds
        setTimeout(() => {
          if (!isSSEActive) connectSSE();
        }, 5000);
      };
    } catch (_) {
      isSSEActive = false;
      if (!fetchTimer) fetchTrains();
    }
  }

  // ── Process Incoming Trains (Track-Snapped) ───────────────────────
  function processTrains(data) {
    const now = performance.now();
    const seen = new Set();
    const counts = data.counts || { IC: 0, SPR: 0, other: 0 };

    $count.textContent = data.count;
    $countIc.textContent = counts.IC;
    $countSpr.textContent = counts.SPR;
    $countOther.textContent = counts.other;

    const isNewServerFix = (data.timestamp && data.timestamp > lastServerTimestamp);
    if (isNewServerFix) {
      lastServerTimestamp = data.timestamp;
    }

    for (const t of data.trains) {
      seen.add(t.id);
      const cat = trainCategory(t.type);
      const color = trainColor(t.type);
      const existing = markers[t.id];

      // Snap train coordinates onto the physical rail track
      const snap = snapToTrack(t.lat, t.lng, t.heading);
      const targetPos = { lat: snap.lat, lng: snap.lng };

      if (existing) {
        if (isNewServerFix) {
          existing.prev = { lat: existing.displayed.lat, lng: existing.displayed.lng };
          existing.target = targetPos;
          existing.snap = snap;
          existing.blendStart = now;
          existing.speed = t.speed;
          existing.heading = t.heading;
          existing.type = t.type;
          existing.source = t.source;
          existing.lastSeen = now;

          // Push to motion trail history
          existing.history.push([targetPos.lat, targetPos.lng]);
          if (existing.history.length > MAX_TRAIL_POINTS) existing.history.shift();
          if (existing.polyline) {
            existing.polyline.setLatLngs(existing.history);
            if (showTrails && visibleTypes[cat] && !map.hasLayer(existing.polyline)) {
              existing.polyline.addTo(map);
            }
          }
        }

        const el = existing.marker.getElement();
        if (el) el.innerHTML = chevronSVG(color, t.heading);
      } else {
        const icon = L.divIcon({
          className: "train-icon",
          html: chevronSVG(color, t.heading),
          iconSize: [28, 28],
        });
        const marker = L.marker([targetPos.lat, targetPos.lng], { icon, zIndexOffset: 20 });

        // Motion trail polyline with 2-point initial wake so it renders immediately
        const initialTail = extrapolate(targetPos.lat, targetPos.lng, Math.max(t.speed, 25), (t.heading + 180) % 360, 0.4);
        const history = [[initialTail.lat, initialTail.lng], [targetPos.lat, targetPos.lng]];
        const polyline = L.polyline(history, {
          color: color,
          weight: 2.5,
          opacity: 0.55,
          lineCap: "round"
        });

        if (visibleTypes[cat]) {
          marker.addTo(map);
          if (showTrails) polyline.addTo(map);
        }

        // Attach rich card popup
        marker.bindPopup(renderTrainCard(t, journeyCache[t.id]), {
          className: "train-card-popup",
          maxWidth: 320,
          closeButton: true
        });

        marker.on("click", (e) => {
          if (e && e.originalEvent) e.originalEvent.stopPropagation();
          openTrainPopup(t.id);
        });

        marker.on("popupclose", () => {
          if (openPopupId === t.id) openPopupId = null;
          if ($drawer.classList.contains("drawer-closed")) {
            activeRouteLayer.clearLayers();
            activeSelectedTrainId = null;
            if (followedTrainId === t.id) {
              followedTrainId = null;
              updateFollowButtons();
            }
          }
        });

        markers[t.id] = {
          marker,
          polyline,
          history,
          displayed: { lat: targetPos.lat, lng: targetPos.lng },
          target: targetPos,
          prev: { lat: targetPos.lat, lng: targetPos.lng },
          snap: snap,
          blendStart: now,
          speed: t.speed,
          heading: t.heading,
          type: t.type,
          source: t.source,
          id: t.id,
          lastSeen: now,
        };
      }
    }

    // Remove departed trains
    for (const id of Object.keys(markers)) {
      if (!seen.has(Number(id))) {
        map.removeLayer(markers[id].marker);
        if (markers[id].polyline) map.removeLayer(markers[id].polyline);
        delete markers[id];
      }
    }

    // Check if a train was requested via URL query param and just spawned on radar
    if (pendingUrlTrainId && markers[pendingUrlTrainId]) {
      const tid = pendingUrlTrainId;
      pendingUrlTrainId = null;
      const m = markers[tid];
      map.flyTo([m.displayed.lat, m.displayed.lng], Math.max(map.getZoom(), 12), { duration: 1.2 });
      followedTrainId = tid;
      updateFollowButtons();
      window.openJourney(tid);
    }

    updateSpeedLeaderboard();
  }

  // ── Animation Loop (Track-Snapped Along-Track Extrapolation) ──────
  function animate() {
    const now = performance.now();

    for (const id in markers) {
      const m = markers[id];
      let lat = m.target.lat;
      let lng = m.target.lng;

      if (m.speed >= 1.5) {
        const elapsed = now - m.blendStart;
        if (elapsed < 1000) {
          // 1s gentle easing toward verified target fix
          const easeT = Math.min(1, elapsed / 1000);
          lat = lerp(m.prev.lat, m.target.lat, easeT);
          lng = lerp(m.prev.lng, m.target.lng, easeT);
        } else {
          // Advance along physical track curves
          const extrapSec = Math.min((elapsed - 1000) / 1000, 4.0);
          let distMeters = (m.speed / 3.6) * extrapSec;

          // Clamp extrapolation at next station if stopping according to timetable
          const j = journeyCache[m.id];
          if (j && j.next_stop && j.next_stop.lat && j.next_stop.lng) {
            const distToStop = distanceMeters(m.target.lat, m.target.lng, j.next_stop.lat, j.next_stop.lng);
            if (distMeters > distToStop) {
              distMeters = distToStop;
            }
          }

          if (m.snap && m.snap.snapped && trackFeatures[m.snap.fIdx]) {
            const coords = trackFeatures[m.snap.fIdx];
            const p1 = coords[m.snap.sIdx];
            const p2 = coords[m.snap.sIdx + 1] || p1;
            const segBearing = bearingDeg(p1[0], p1[1], p2[0], p2[1]);
            const forward = Math.cos((segBearing - m.heading) * DEG2RAD) >= 0;
            const adv = advanceAlongTrack(coords, m.snap.sIdx, m.snap.t, distMeters, forward);
            lat = adv.lat;
            lng = adv.lng;
          } else {
            const adv = extrapolate(m.target.lat, m.target.lng, m.speed, m.heading, extrapSec);
            lat = adv.lat;
            lng = adv.lng;
          }
        }
      }

      m.displayed.lat = lat;
      m.displayed.lng = lng;
      m.marker.setLatLng([lat, lng]);

      // If user is following this train, pan map camera along smoothly
      if (followedTrainId !== null && Number(id) === followedTrainId) {
        map.panTo([lat, lng], { animate: false });
        updateCockpitHUD(m);
      }

      // Keep motion trail synced with head
      if (showTrails && m.polyline && m.history.length > 0) {
        const trailWithHead = [...m.history, [lat, lng]];
        m.polyline.setLatLngs(trailWithHead);
      }

      // Smooth in-place telemetry update without tearing down the popup DOM
      if (openPopupId === m.id && m.marker.isPopupOpen()) {
        const elSpeed = document.getElementById(`live-speed-${m.id}`);
        if (elSpeed) elSpeed.textContent = `${m.speed.toFixed(1)} km/h`;
        const elHeading = document.getElementById(`live-heading-${m.id}`);
        if (elHeading) elHeading.textContent = `${m.heading.toFixed(0)}° · ${headingToCompass(m.heading)}`;
        const elPos = document.getElementById(`live-pos-${m.id}`);
        if (elPos) elPos.textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      }
    }

    if (followedTrainId !== null && !markers[followedTrainId]) {
      followedTrainId = null;
      updateFollowButtons();
      hideCockpitHUD();
    }

    requestAnimationFrame(animate);
  }

  // ── HUD Updates ──────────────────────────────────────────────────
  function updateHUDStatus(status, feedLabel) {
    if (status) connectionStatus = status;
    $statusDot.className = "status-dot " + connectionStatus;
    if ($feedBadge) {
      $feedBadge.textContent = feedLabel || (connectionStatus === "live" ? "Live Push" : "Offline");
      $feedBadge.className = "feed-badge" + (connectionStatus === "live" ? "" : (connectionStatus === "stale" ? " fallback" : " offline"));
    }
  }

  function updateCountdown() {
    if (!isSSEActive) {
      const now = Date.now() / 1000;
      const remaining = Math.max(0, nextUpdateAt - now);
      const total = pollInterval;
      const frac = Math.min(remaining / total, 1);
      $ringFg.setAttribute("stroke-dashoffset", String(CIRC * (1 - frac)));
      $cdText.textContent = remaining > 0 ? Math.ceil(remaining) + "s" : "…";
    } else {
      $ringFg.setAttribute("stroke-dashoffset", "0");
      $cdText.textContent = "LIVE";
    }
    requestAnimationFrame(updateCountdown);
  }

  // ── Fleet Speed Leaderboard ─────────────────────────────────────
  let isLeaderboardCollapsed = false;

  function updateSpeedLeaderboard() {
    const $list = document.getElementById("leaderboard-list");
    if (!$list || isLeaderboardCollapsed) return;

    const moving = [];
    for (const id in markers) {
      const m = markers[id];
      if (m && m.speed > 5) {
        moving.push(m);
      }
    }

    moving.sort((a, b) => b.speed - a.speed);
    const topTrains = moving.slice(0, 4);

    if (topTrains.length === 0) {
      $list.innerHTML = `<div style="color:#8fa8cc;font-size:10.5px;padding:6px;text-align:center;">Geen treinen met actieve snelheid</div>`;
      return;
    }

    let html = "";
    topTrains.forEach((t) => {
      const cat = trainCategory(t.type);
      const isHigh = t.speed >= 100;
      const speedClass = isHigh ? "leaderboard-speed high-speed" : "leaderboard-speed";
      const j = journeyCache[t.id];
      const dest = j && j.destination ? `➔ ${j.destination}` : "";

      html += `
        <div class="leaderboard-item" onclick="window.focusTrainFromDeparture('${t.id}')" title="Volg trein ${t.id} (${t.speed.toFixed(0)} km/h)">
          <div class="leaderboard-train-info">
            <span class="leaderboard-badge ${cat}">${cat}</span>
            <span style="font-weight:700;">${t.id}</span>
            <span style="color:#8fa8cc;font-size:10px;overflow:hidden;text-overflow:ellipsis;">${dest}</span>
          </div>
          <span class="${speedClass}">⚡ ${t.speed.toFixed(0)} km/h</span>
        </div>
      `;
    });

    $list.innerHTML = html;
  }

  const $leaderboardToggle = document.getElementById("leaderboard-toggle");
  const $leaderboardList = document.getElementById("leaderboard-list");
  const $leaderboardChevron = document.getElementById("leaderboard-chevron");

  if ($leaderboardToggle && $leaderboardList) {
    $leaderboardToggle.addEventListener("click", () => {
      isLeaderboardCollapsed = !isLeaderboardCollapsed;
      if (isLeaderboardCollapsed) {
        $leaderboardList.classList.add("collapsed");
        if ($leaderboardChevron) $leaderboardChevron.style.transform = "rotate(180deg)";
      } else {
        $leaderboardList.classList.remove("collapsed");
        if ($leaderboardChevron) $leaderboardChevron.style.transform = "rotate(0deg)";
        updateSpeedLeaderboard();
      }
    });
  }

  // ── Universal Train & Station Search with Real-Time Autocomplete ──
  let highlightedSearchIndex = -1;
  let currentSearchResults = [];

  function performSearch(query) {
    const q = (query || "").trim().toLowerCase();
    $feedback.textContent = "";

    if (!q) {
      closeSearchDropdown();
      return;
    }

    const results = [];

    // 1. Match Active Live Trains by ID
    for (const id in markers) {
      const tidStr = String(id);
      if (tidStr.includes(q)) {
        const m = markers[id];
        const j = journeyCache[id];
        const route = j ? `${j.origin || ""} ➔ ${j.destination || ""}` : `${m.speed.toFixed(0)} km/h`;
        const cat = trainCategory(m.type);
        results.push({
          type: "train",
          id: Number(id),
          title: `Trein ${id}`,
          subtitle: route,
          badge: cat.toUpperCase(),
          cat: cat
        });
      }
      if (results.length >= 4) break;
    }

    // 2. Match Stations by Name or Station Code
    if (stationsData && stationsData.length > 0) {
      for (const s of stationsData) {
        if (s.country && s.country !== "NL") continue;
        const name = (s.name || "").toLowerCase();
        const code = (s.code || "").toLowerCase();

        if (name.includes(q) || code === q || code.startsWith(q)) {
          const isHub = s.type === "KNOOPPUNT_INTERCITY_STATION" || s.type === "INTERCITY_STATION";
          results.push({
            type: "station",
            code: s.code,
            station: s,
            title: s.name,
            subtitle: `Station · ${s.code.toUpperCase()}`,
            badge: isHub ? "IC STATION" : "STATION"
          });
        }
        if (results.length >= 8) break;
      }
    }

    renderSearchResults(results);
  }

  function renderSearchResults(results) {
    currentSearchResults = results;
    highlightedSearchIndex = -1;

    if (!results || results.length === 0) {
      $searchDropdown.innerHTML = `<div style="padding:10px;font-size:11px;color:#8fa8cc;text-align:center;">Geen treinen of stations gevonden</div>`;
      $searchDropdown.style.display = "block";
      return;
    }

    let html = "";
    results.forEach((r, idx) => {
      const icon = r.type === "train" ? "🚆" : "🚉";
      html += `
        <div class="search-result-item" data-idx="${idx}">
          <div class="item-title">
            <span>${icon}</span>
            <span style="font-weight:700;">${r.title}</span>
            <span class="item-code">${r.subtitle}</span>
          </div>
          <span class="item-tag">${r.badge}</span>
        </div>
      `;
    });

    $searchDropdown.innerHTML = html;
    $searchDropdown.style.display = "block";

    $searchDropdown.querySelectorAll(".search-result-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = Number(el.getAttribute("data-idx"));
        selectSearchResult(currentSearchResults[idx]);
      });
    });
  }

  function updateHighlightedItem() {
    const items = $searchDropdown.querySelectorAll(".search-result-item");
    items.forEach((item, idx) => {
      if (idx === highlightedSearchIndex) {
        item.classList.add("highlighted");
        item.scrollIntoView({ block: "nearest" });
      } else {
        item.classList.remove("highlighted");
      }
    });
  }

  function selectSearchResult(item) {
    if (!item) return;
    closeSearchDropdown();
    $search.value = item.title;
    if ($searchClear) $searchClear.style.display = "block";

    if (item.type === "train") {
      const id = item.id;
      const entry = markers[id];
      if (entry) {
        const cat = trainCategory(entry.type);
        if (!visibleTypes[cat]) {
          visibleTypes[cat] = true;
          const filterBtn = document.querySelector(`.filter-pill[data-type="${cat}"]`);
          if (filterBtn) filterBtn.classList.add("active");
          updateMarkerVisibility();
        }
        map.flyTo([entry.displayed.lat, entry.displayed.lng], 13, { duration: 1.2 });
        followedTrainId = id;
        updateFollowButtons();
        window.openJourney(id);
      } else {
        window.openJourney(id);
      }
    } else if (item.type === "station") {
      window.focusStation(item.code);
    }
  }

  function closeSearchDropdown() {
    $searchDropdown.style.display = "none";
    currentSearchResults = [];
    highlightedSearchIndex = -1;
  }

  $search.addEventListener("input", () => {
    const val = $search.value;
    if ($searchClear) $searchClear.style.display = val ? "block" : "none";
    performSearch(val);
  });

  $search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      if (currentSearchResults.length > 0) {
        highlightedSearchIndex = (highlightedSearchIndex + 1) % currentSearchResults.length;
        updateHighlightedItem();
        e.preventDefault();
      }
    } else if (e.key === "ArrowUp") {
      if (currentSearchResults.length > 0) {
        highlightedSearchIndex = (highlightedSearchIndex - 1 + currentSearchResults.length) % currentSearchResults.length;
        updateHighlightedItem();
        e.preventDefault();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedSearchIndex >= 0 && currentSearchResults[highlightedSearchIndex]) {
        selectSearchResult(currentSearchResults[highlightedSearchIndex]);
      } else if (currentSearchResults.length > 0) {
        selectSearchResult(currentSearchResults[0]);
      } else {
        const q = $search.value.trim();
        if (!q) return;
        const id = Number(q);
        if (!isNaN(id) && markers[id]) {
          selectSearchResult({ type: "train", id: id });
        } else {
          $feedback.textContent = `Trein of station "${q}" niet gevonden`;
          setTimeout(() => { $feedback.textContent = ""; }, 3500);
        }
      }
    } else if (e.key === "Escape") {
      closeSearchDropdown();
    }
  });

  if ($searchClear) {
    $searchClear.addEventListener("click", () => {
      $search.value = "";
      $searchClear.style.display = "none";
      $feedback.textContent = "";
      closeSearchDropdown();
      $search.focus();
    });
  }

  document.addEventListener("click", (e) => {
    const wrap = document.getElementById("search-wrap");
    if (wrap && !wrap.contains(e.target)) {
      closeSearchDropdown();
    }
  });

  // ── Nachtnet Status Indicator ──────────────────────────────────
  function updateNachtnetStatus() {
    const $pill = document.getElementById("nachtnet-pill");
    if (!$pill) return;
    try {
      const d = new Date();
      const nlTimeStr = d.toLocaleTimeString("en-GB", { timeZone: "Europe/Amsterdam", hour12: false });
      const parts = nlTimeStr.split(":");
      const nlHour = parseInt(parts[0], 10);
      const nlMin = parseInt(parts[1], 10);
      const totalMinutes = nlHour * 60 + nlMin;

      // Dutch Nachtnet operates between 01:00 (60) and 05:30 (330)
      const isNachtnet = (totalMinutes >= 60 && totalMinutes <= 330);
      if (isNachtnet) {
        $pill.className = "nachtnet-pill active";
        $pill.innerHTML = "🌙 Nachtnet";
        $pill.title = "Nachtnet dienstregeling actief (01:00 - 05:30) • Uurlijkse nachttreinen Randstad & Brabant corridor";
      } else {
        $pill.className = "nachtnet-pill daylight";
        $pill.innerHTML = "☀️ Dagdienst";
        $pill.title = "Reguliere NS dienstregeling actief";
      }
    } catch (_) {}
  }

  // ── Boot ─────────────────────────────────────────────────────────
  loadBorder();
  loadDisruptions();
  loadTracks().then(() => {
    if (disruptionsData && disruptionsData.disruptions) {
      renderDisruptions(disruptionsData.disruptions);
    }
    syncToggleLayers();
  });
  loadStations();
  syncToggleLayers();
  updateNachtnetStatus();
  updateAudioButton();
  updateSpeedLeaderboard();
  checkUrlParams();
  window.addEventListener("popstate", checkUrlParams);
  connectSSE();
  requestAnimationFrame(animate);
  requestAnimationFrame(updateCountdown);

  // Periodic checks
  setInterval(loadDisruptions, 60000);
  setInterval(updateNachtnetStatus, 60000);
  setInterval(updateSpeedLeaderboard, 3000);

})();
