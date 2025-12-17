// hello
(function (global) {
  // ===== Config =====
  const PROFILE  = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // ORS free-tier assumption: 40 requests / minute
  const MAX_PER_MINUTE = 40;
  const BASE_DELAY_MS  = 250;

  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';
  const LS_KEYS = 'ORS_KEYS';

  // ===== Shared global state =====
  global.ROUTING_CACHE = global.ROUTING_CACHE || {
    kind: null, // 'pd' | 'pz'
    origin: null, // {lon,lat,label} (or lng/lat)
    reverse: false,
    generatedAt: null,
    items: []
  };

  global.ROUTING_STATE = global.ROUTING_STATE || {
    map: null,
    routeLayerGroup: null,
    busy: false,
    lastError: null
  };

  // ===== Helpers =====
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function byId(id) { return document.getElementById(id); }

  function cleanHtml(str) {
    return String(str || '').replace(/<[^>]*>/g, '').trim();
  }

  function normalizeMunicipalityName(muni) {
    return String(muni || '')
      .replace(/^\s*(City|Town|Township|Municipality|Region|Regional Municipality)\s+of\s+/i, '')
      .trim();
  }

  function computeTripDirCardinal(from, to) {
    const dLat = to.lat - from.lat;
    const dLng = to.lng - from.lng;
    const absLat = Math.abs(dLat);
    const absLng = Math.abs(dLng);
    if (absLat >= absLng) return dLat >= 0 ? 'N' : 'S';
    return dLng >= 0 ? 'E' : 'W';
  }

  // IMPORTANT: your script.js uses lon/lat; accept both lon/lng
  function sanitizeLonLat(ll) {
    const lon = Number(ll[0]);
    const lat = Number(ll[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return [lon, lat];
  }

  function getOriginLonLat() {
    const o = global.ROUTING_ORIGIN;
    if (!o) {
      const err = new Error('Origin not set');
      err.code = 'NO_ORIGIN';
      throw err;
    }
    if (Array.isArray(o) && o.length >= 2) return sanitizeLonLat([o[0], o[1]]);

    // accept {lon,lat} or {lng,lat}
    const lon = (o.lon != null) ? o.lon : o.lng;
    const lat = o.lat;
    const ll = sanitizeLonLat([lon, lat]);
    if (!ll) {
      const err = new Error('Origin not set');
      err.code = 'NO_ORIGIN';
      throw err;
    }
    return ll;
  }

  function getOriginLabel() {
    const o = global.ROUTING_ORIGIN;
    if (!o) return '';
    return cleanHtml(o.label || '');
  }

  function ensureMapRefs() {
    if (!global.map || !global.L) return false;
    global.ROUTING_STATE.map = global.map;
    global.ROUTING_STATE.routeLayerGroup = global.ROUTING_STATE.routeLayerGroup || global.L.layerGroup().addTo(global.map);
    return true;
  }

  function clearRoutesFromMap() {
    if (!ensureMapRefs()) return;
    const g = global.ROUTING_STATE.routeLayerGroup;
    if (g) g.clearLayers();
  }

  // ===== Rate-limit overlay (existing) =====
  let rateOverlay = null;
  let rateOverlayTimer = null;
  function ensureRateOverlay() {
    if (rateOverlay) return rateOverlay;
    rateOverlay = document.createElement('div');
    rateOverlay.id = 'routing-rate-overlay';
    rateOverlay.style.position = 'fixed';
    rateOverlay.style.inset = '0';
    rateOverlay.style.display = 'none';
    rateOverlay.style.alignItems = 'center';
    rateOverlay.style.justifyContent = 'center';
    rateOverlay.style.background = 'rgba(255,255,255,0.85)';
    rateOverlay.style.zIndex = '99999';
    rateOverlay.innerHTML = `
      <div style="background:#fff;border:1px solid #ddd;border-radius:12px;padding:16px 18px;min-width:260px;box-shadow:0 10px 24px rgba(0,0,0,0.12);">
        <div style="font-weight:700;margin-bottom:6px;">Waiting for ORS quota…</div>
        <div style="font-size:0.95em;line-height:1.35;">
          Resuming in <span id="routing-countdown" style="font-weight:700;">60</span>s
        </div>
      </div>
    `;
    document.body.appendChild(rateOverlay);
    return rateOverlay;
  }

  function showRateOverlay(secs) {
    const ov = ensureRateOverlay();
    const cd = ov.querySelector('#routing-countdown');
    ov.style.display = 'flex';
    let remaining = Math.max(0, Math.floor(secs));
    if (cd) cd.textContent = String(remaining);

    if (rateOverlayTimer) clearInterval(rateOverlayTimer);
    rateOverlayTimer = setInterval(() => {
      remaining -= 1;
      if (cd) cd.textContent = String(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(rateOverlayTimer);
        rateOverlayTimer = null;
        ov.style.display = 'none';
      }
    }, 1000);
  }

  // ===== ORS key handling (existing) =====
  function getStoredKeys() {
    try {
      const raw = localStorage.getItem(LS_KEYS);
      const parsed = JSON.parse(raw || '[]');
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
      return [];
    } catch {
      return [];
    }
  }

  function setStoredKeys(keys) {
    try { localStorage.setItem(LS_KEYS, JSON.stringify(keys || [])); } catch {}
  }

  function getAnyApiKey() {
    const keys = getStoredKeys();
    if (keys.length) return keys[0];
    return INLINE_DEFAULT_KEY;
  }

  async function fetchDirectionsGeojson(fromLonLat, toLonLat, opts = {}) {
    const apiKey = getAnyApiKey();
    const url = `${ORS_BASE}/v2/directions/${PROFILE}/geojson`;

    const body = {
      coordinates: [
        [fromLonLat[0], fromLonLat[1]],
        [toLonLat[0], toLonLat[1]]
      ],
      preference: PREFERENCE,
      instructions: true,
      geometry: true,
      units: 'km'
    };

    if (typeof opts.alternatives === 'number' && opts.alternatives > 0) {
      body.alternative_routes = { target_count: Math.min(3, Math.max(1, opts.alternatives)) };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const err = new Error(`ORS failed: ${res.status} ${res.statusText}\n${t}`);
      err.status = res.status;
      err.body = t;
      throw err;
    }

    return await res.json();
  }

  // ===== Queue runner (existing) =====
  async function runQueue(jobs) {
    let windowStart = Date.now();
    let sentInWindow = 0;

    for (let i = 0; i < jobs.length; i++) {
      await sleep(BASE_DELAY_MS);

      const now = Date.now();
      if (now - windowStart >= 60_000) {
        windowStart = now;
        sentInWindow = 0;
      }

      if (sentInWindow >= MAX_PER_MINUTE) {
        showRateOverlay(45);
        await sleep(45_000);
        showRateOverlay(10);
        await sleep(10_000);
        windowStart = Date.now();
        sentInWindow = 0;
      }

      const job = jobs[i];
      try {
        job._result = await job();
        sentInWindow++;
      } catch (e) {
        const isRate = e && (e.status === 429 || /rate|quota|Too Many/i.test(String(e.message || '')));
        if (isRate) {
          showRateOverlay(45);
          await sleep(45_000);
          showRateOverlay(10);
          await sleep(10_000);
          windowStart = Date.now();
          sentInWindow = 0;

          job._result = await job();
          sentInWindow++;
        } else {
          throw e;
        }
      }
    }

    return jobs.map(j => j._result);
  }

  // ===== Target builders from script.js (existing globals) =====
  function getSelectedPDTargetsSafe() {
    if (typeof global.getSelectedPDTargets === 'function') return global.getSelectedPDTargets();
    return [];
  }
  function getSelectedZoneTargetsSafe() {
    if (typeof global.getSelectedZoneTargets === 'function') return global.getSelectedZoneTargets();
    return [];
  }
  function getZoneTargetsForPDSafe(pdKey) {
    if (typeof global.getZoneTargetsForPD === 'function') return global.getZoneTargetsForPD(pdKey);
    return [];
  }

  // ===== PD routes per-row validation (existing DOM rules) =====
  function getInvalidPDRouteCounts() {
    const invalid = [];
    const rows = document.querySelectorAll('.pd-row');
    rows.forEach((row) => {
      const key = row.getAttribute('data-pd-key');
      const name = row.getAttribute('data-pd-name') || key || '';
      const checked = row.querySelector('input[type="checkbox"]');
      const countInput = row.querySelector('input[type="number"]');
      if (!countInput) return;

      const v = Number(countInput.value);
      const isSel = checked && checked.checked;

      if (!isSel && v !== 0) {
        invalid.push(`${name} (must be 0 when not selected)`);
        return;
      }
      if (isSel && !(v >= 1 && v <= 3)) {
        invalid.push(`${name} (must be 1–3)`);
        return;
      }
      if (isSel && !Number.isFinite(v)) {
        invalid.push(`${name} (invalid number)`);
      }
    });
    return invalid;
  }

  function readPDAltCountForKey(pdKey) {
    const row = document.querySelector(`.pd-row[data-pd-key="${CSS.escape(pdKey)}"]`);
    if (!row) return 1;
    const input = row.querySelector('input[type="number"]');
    if (!input) return 1;
    const v = Number(input.value);
    if (!Number.isFinite(v)) return 1;
    return Math.max(0, Math.min(3, Math.floor(v)));
  }

  // ===== Draw (existing) =====
  function drawGeojson(geojson, altIndex) {
    if (!ensureMapRefs()) return;
    const L = global.L;
    const g = global.ROUTING_STATE.routeLayerGroup;

    const color = altIndex === 0 ? COLOR_FIRST : COLOR_OTHERS;
    const weight = altIndex === 0 ? 5 : 3;
    const opacity = altIndex === 0 ? 0.85 : 0.55;

    L.geoJSON(geojson, { style: { color, weight, opacity } }).addTo(g);
  }

  // ===== Cache writer (existing) =====
  function writeCache(kind, origin, reverse, items) {
    global.ROUTING_CACHE = {
      kind,
      origin,
      reverse: !!reverse,
      generatedAt: new Date().toISOString(),
      items
    };
  }

  // ===== Busy-state button labels (FIXED) =====
  function setBusyButtons(mode, busy) {
    const btnPD = byId('rt-gen-pd');
    const btnPZ = byId('rt-gen-pz');
    const btnClear = byId('rt-clear');

    // Always keep the *default* labels short.
    const PD_IDLE = 'PD Trips';
    const PZ_IDLE = 'Zone Trips';
    const PD_BUSY = 'PD Trips...';
    const PZ_BUSY = 'Zone Trips...';

    // Disable both generation buttons while busy to prevent double-queues.
    if (btnPD) {
      btnPD.disabled = busy;
      btnPD.textContent = (mode === 'PD' && busy) ? PD_BUSY : PD_IDLE;
    }
    if (btnPZ) {
      btnPZ.disabled = busy;
      btnPZ.textContent = (mode === 'PZ' && busy) ? PZ_BUSY : PZ_IDLE;
    }
    if (btnClear) btnClear.disabled = busy;
  }

  // ===== PD trips (existing flow) =====
  async function generateForPDs() {
    try {
      const originLonLat = getOriginLonLat();
      const originLabel = getOriginLabel();
      const reverse = !!byId('rt-reverse')?.checked;

      const invalid = getInvalidPDRouteCounts();
      if (invalid.length) {
        alert('Fix these PD route-count values:\n\n' + invalid.join('\n'));
        return;
      }

      const targets = getSelectedPDTargetsSafe();
      if (!targets.length) {
        alert('Please select at least one Planning District.');
        return;
      }

      setBusyButtons('PD', true);
      clearRoutesFromMap();

      const jobs = [];
      const itemMeta = [];

      targets.forEach((t) => {
        const altCount = readPDAltCountForKey(t.key);
        const requestAlternatives = Math.max(0, altCount - 1);

        const from = reverse ? [t.dest.lng, t.dest.lat] : originLonLat;
        const to   = reverse ? originLonLat : [t.dest.lng, t.dest.lat];

        jobs.push(async () => await fetchDirectionsGeojson(from, to, { alternatives: requestAlternatives }));
        itemMeta.push({ t, altCount });
      });

      const results = await runQueue(jobs);

      const cacheItems = [];
      results.forEach((geo, idx) => {
        const meta = itemMeta[idx];
        const t = meta.t;

        const features = (geo && geo.features) ? geo.features : [];
        const routes = [];

        if (features.length) {
          features.forEach((f, fIdx) => {
            drawGeojson({ type: 'FeatureCollection', features: [f] }, fIdx);
            routes.push({
              geojson: { type: 'FeatureCollection', features: [f] },
              summary: (f.properties && f.properties.summary) ? f.properties.summary : null,
              segments: (f.properties && f.properties.segments) ? f.properties.segments : null,
              alternativesIndex: fIdx
            });
          });
        } else {
          drawGeojson(geo, 0);
          routes.push({
            geojson: geo,
            summary: (geo && geo.properties && geo.properties.summary) ? geo.properties.summary : null,
            segments: (geo && geo.properties && geo.properties.segments) ? geo.properties.segments : null,
            alternativesIndex: 0
          });
        }

        const origin = { lat: originLonLat[1], lng: originLonLat[0] };
        const dest = { lat: t.dest.lat, lng: t.dest.lng };

        cacheItems.push({
          key: t.key,
          name: t.name,
          muni: normalizeMunicipalityName(t.muni),
          dest: t.dest,
          tripDir: computeTripDirCardinal(origin, dest),
          routes
        });
      });

      writeCache('pd', { lon: originLonLat[0], lat: originLonLat[1], label: originLabel }, reverse, cacheItems);
      alert('PD trips generated. You can now Print Report.');
    } catch (e) {
      if (e && e.code === 'NO_ORIGIN') {
        alert('Please search/select an origin address first.');
        return;
      }
      console.error(e);
      alert('Routing failed. Check console for details.');
    } finally {
      setBusyButtons('PD', false);
    }
  }

  // ===== PZ trips (existing flow) =====
  async function generateForZones() {
    try {
      const originLonLat = getOriginLonLat();
      const originLabel = getOriginLabel();
      const reverse = !!byId('rt-reverse')?.checked;

      const selectedPDs = getSelectedPDTargetsSafe();
      const selectedZones = getSelectedZoneTargetsSafe();

      let targets = [];
      if (selectedZones && selectedZones.length === 1) {
        targets = selectedZones;
      } else {
        if (!selectedPDs || selectedPDs.length !== 1) {
          alert('For Zone trips: select exactly 1 Planning District (or select exactly 1 zone).');
          return;
        }
        const pdKey = selectedPDs[0].key;
        targets = getZoneTargetsForPDSafe(pdKey);
      }

      if (!targets.length) {
        alert('No Traffic Zones available for routing in this selection.');
        return;
      }

      setBusyButtons('PZ', true);
      clearRoutesFromMap();

      const jobs = targets.map((t) => {
        const from = reverse ? [t.dest.lng, t.dest.lat] : originLonLat;
        const to   = reverse ? originLonLat : [t.dest.lng, t.dest.lat];
        return async () => await fetchDirectionsGeojson(from, to, { alternatives: 0 });
      });

      const results = await runQueue(jobs);

      const cacheItems = [];
      results.forEach((geo, idx) => {
        const t = targets[idx];
        drawGeojson(geo, 0);

        const origin = { lat: originLonLat[1], lng: originLonLat[0] };
        const dest = { lat: t.dest.lat, lng: t.dest.lng };

        cacheItems.push({
          key: t.key,
          name: t.name,
          muni: normalizeMunicipalityName(t.muni),
          dest: t.dest,
          tripDir: computeTripDirCardinal(origin, dest),
          routes: [{
            geojson: geo,
            summary: (geo && geo.properties && geo.properties.summary) ? geo.properties.summary : null,
            segments: (geo && geo.properties && geo.properties.segments) ? geo.properties.segments : null,
            alternativesIndex: 0
          }]
        });
      });

      writeCache('pz', { lon: originLonLat[0], lat: originLonLat[1], label: originLabel }, reverse, cacheItems);
      alert('Zone trips generated. You can now Print Report.');
    } catch (e) {
      if (e && e.code === 'NO_ORIGIN') {
        alert('Please search/select an origin address first.');
        return;
      }
      console.error(e);
      alert('Routing failed. Check console for details.');
    } finally {
      setBusyButtons('PZ', false);
    }
  }

  // ===== Clear (existing) =====
  function clearGenerated() {
    clearRoutesFromMap();
    global.ROUTING_CACHE = { kind: null, origin: null, reverse: false, generatedAt: null, items: [] };
    alert('Cleared generated trips.');
  }

  // ===== Distribute Trips Leaflet control (UI labels updated) =====
  const GeneratorControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const el = L.DomUtil.create('div', 'routing-control');
      el.innerHTML = `
        <div class="routing-header"><strong>Distribute Trips</strong></div>
        <div class="routing-actions" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
          <button id="rt-gen-pd">PD Trips</button>
          <button id="rt-gen-pz">Zone Trips</button>
          <button id="rt-clear" class="ghost">Clear</button>
        </div>
        <div style="margin-bottom:8px;">
          <label style="font-size:0.9em;display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="rt-reverse">
            Reverse direction (PD/PZ → origin)
          </label>
        </div>
        <details>
          <summary><strong>Keys</strong></summary>
          <div class="routing-card">
            <label for="rt-keys" style="font-weight:600;">OpenRouteService key(s)</label>
            <input id="rt-keys" type="text" placeholder="KEY1,KEY2 (comma-separated)">
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px;">
              <button id="rt-save">Save Keys</button>
              <button id="rt-url" class="ghost">Use ?orsKey</button>
            </div>
            <small class="routing-hint">
              Priority: ?orsKey → saved → inline fallback. Keys auto-rotate on 401/429.
            </small>
          </div>
        </details>
      `;

      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);

      const btnPD = el.querySelector('#rt-gen-pd');
      const btnPZ = el.querySelector('#rt-gen-pz');
      const btnClear = el.querySelector('#rt-clear');
      const btnSave = el.querySelector('#rt-save');
      const btnUrl = el.querySelector('#rt-url');
      const keysInput = el.querySelector('#rt-keys');

      if (keysInput) {
        // load stored keys into input for convenience
        const keys = getStoredKeys();
        if (keys.length) keysInput.value = keys.join(',');
      }

      if (btnSave) btnSave.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const v = (keysInput?.value || '').trim();
        const arr = v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
        setStoredKeys(arr);
        alert('Saved ORS keys.');
      });

      if (btnUrl) btnUrl.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        alert('Tip: add ?orsKey=YOUR_KEY to the page URL.');
      });

      if (btnPD) btnPD.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); generateForPDs(); });
      if (btnPZ) btnPZ.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); generateForZones(); });
      if (btnClear) btnClear.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); clearGenerated(); });

      return el;
    }
  });

  function initWhenReady() {
    if (global.L && global.map) {
      try {
        global.map.addControl(new GeneratorControl());

        // allow ?orsKey=... in URL
        const url = new URL(window.location.href);
        const keyParam = url.searchParams.get('orsKey');
        if (keyParam) {
          const k = keyParam.trim();
          if (k) {
            localStorage.setItem(LS_KEYS, JSON.stringify([k]));
            alert('Using orsKey from URL.');
          }
        }
      } catch (e) {
        console.error('Failed to add Distribute Trips control:', e);
      }
    } else {
      setTimeout(initWhenReady, 80);
    }
  }

  global.Routing = {
    generatePDTrips: generateForPDs,
    generatePZTrips: generateForZones,
    clearGenerated
  };

  document.addEventListener('DOMContentLoaded', function () {
    initWhenReady();
  });

})(window);
