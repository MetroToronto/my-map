(function (global) {
  // ===== Config =====
  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // ORS free-tier assumption: 40 requests / minute
  const MAX_PER_MINUTE = 40;
  const BASE_DELAY_MS  = 250;

  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';
  const LS_KEYS         = 'ORS_KEYS';

  // ===== Shared global state =====
  global.ROUTING_CACHE = global.ROUTING_CACHE || {
    kind: null, // 'pd' | 'pz'
    origin: null, // {lat,lng,label}
    reverse: false,
    generatedAt: null,
    items: [] // array of { key, name, muni, dest:{lat,lng}, routes:[{geojson, summary, segments, alternativesIndex}] }
  };

  global.ROUTING_STATE = global.ROUTING_STATE || {
    map: null,
    routeLayerGroup: null,
    busy: false,
    lastError: null,
    overlayEl: null
  };

  // ===== Helpers =====
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function nowMs() {
    return Date.now();
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cleanHtml(str) {
    return String(str || '').replace(/<[^>]*>/g, '').trim();
  }

  function getOrigin() {
    // script.js sets window.ROUTING_ORIGIN = { lat, lng, label }
    const o = global.ROUTING_ORIGIN;
    if (!o || typeof o.lat !== 'number' || typeof o.lng !== 'number') return null;
    return { lat: o.lat, lng: o.lng, label: cleanHtml(o.label || '') };
  }

  function normalizeMuniName(muni) {
    // For spreadsheet needs: remove "City of", "Town of", etc.
    return String(muni || '')
      .replace(/^\s*(City|Town|Township|Municipality|Region|Regional Municipality)\s+of\s+/i, '')
      .trim();
  }

  // Bearing: simple cardinal direction from origin->dest
  function computeTripDirCardinal(from, to) {
    const dLat = to.lat - from.lat;
    const dLng = to.lng - from.lng;
    const absLat = Math.abs(dLat);
    const absLng = Math.abs(dLng);

    if (absLat >= absLng) return dLat >= 0 ? 'N' : 'S';
    return dLng >= 0 ? 'E' : 'W';
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

  // ===== Rate-limit overlay =====
  function createOverlay() {
    if (global.ROUTING_STATE.overlayEl) return global.ROUTING_STATE.overlayEl;

    const overlay = document.createElement('div');
    overlay.id = 'routing-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.display = 'none';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.background = 'rgba(255,255,255,0.85)';
    overlay.style.zIndex = '99999';

    overlay.innerHTML = `
      <div style="background:#fff;border:1px solid #ddd;border-radius:12px;padding:16px 18px;min-width:260px;box-shadow:0 10px 24px rgba(0,0,0,0.12);">
        <div style="font-weight:700;margin-bottom:6px;">Waiting for ORS quota…</div>
        <div style="font-size:0.95em;line-height:1.35;">
          Resuming in <span id="routing-countdown" style="font-weight:700;">60</span>s
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    global.ROUTING_STATE.overlayEl = overlay;
    return overlay;
  }

  async function showCountdown(seconds) {
    const overlay = createOverlay();
    overlay.style.display = 'flex';
    const cdEl = overlay.querySelector('#routing-countdown');

    let remaining = Math.max(0, Math.floor(seconds));
    if (cdEl) cdEl.textContent = String(remaining);

    while (remaining > 0) {
      await sleep(1000);
      remaining--;
      if (cdEl) cdEl.textContent = String(remaining);
    }
    overlay.style.display = 'none';
  }

  // ===== ORS key handling =====
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
    try {
      localStorage.setItem(LS_KEYS, JSON.stringify(keys || []));
    } catch {}
  }

  function hydrateKeys() {
    const container = document.getElementById('routing-key-box');
    if (!container) return;

    const keys = getStoredKeys();
    container.innerHTML = '';

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    title.textContent = 'ORS Keys';
    container.appendChild(title);

    const list = document.createElement('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '6px';

    const addRow = document.createElement('div');
    addRow.style.display = 'flex';
    addRow.style.gap = '6px';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Paste ORS API key…';
    input.style.flex = '1';
    input.style.padding = '6px 8px';
    input.style.border = '1px solid #ddd';
    input.style.borderRadius = '8px';
    input.style.fontSize = '0.9em';

    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add';
    addBtn.style.padding = '6px 10px';

    addBtn.onclick = () => {
      const v = (input.value || '').trim();
      if (!v) return;
      const next = [v, ...keys.filter((k) => k !== v)];
      setStoredKeys(next);
      input.value = '';
      hydrateKeys();
    };

    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    container.appendChild(addRow);

    keys.slice(0, 5).forEach((k, idx) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.gap = '8px';

      const lbl = document.createElement('div');
      lbl.style.fontSize = '0.85em';
      lbl.style.opacity = '0.9';
      lbl.textContent = `Key ${idx + 1}: ${k.slice(0, 6)}…${k.slice(-4)}`;

      const del = document.createElement('button');
      del.textContent = 'Remove';
      del.className = 'ghost';
      del.style.padding = '4px 8px';
      del.onclick = () => {
        const next = keys.filter((x) => x !== k);
        setStoredKeys(next);
        hydrateKeys();
      };

      row.appendChild(lbl);
      row.appendChild(del);
      list.appendChild(row);
    });

    container.appendChild(list);

    const hint = document.createElement('div');
    hint.style.marginTop = '8px';
    hint.style.fontSize = '0.82em';
    hint.style.opacity = '0.85';
    hint.textContent = 'Tip: you can also pass ?orsKey=YOUR_KEY in the URL.';
    container.appendChild(hint);
  }

  function getAnyApiKey() {
    const keys = getStoredKeys();
    if (keys.length) return keys[0];
    return INLINE_DEFAULT_KEY;
  }

  // ===== ORS Directions =====
  function buildDirectionsUrl() {
    return `${ORS_BASE}/v2/directions/${PROFILE}/geojson`;
  }

  async function fetchRouteGeojson(from, to, opts = {}) {
    const apiKey = getAnyApiKey();
    const url = buildDirectionsUrl();

    const payload = {
      coordinates: [
        [from.lng, from.lat],
        [to.lng, to.lat]
      ],
      preference: PREFERENCE,
      instructions: true,
      geometry: true,
      units: 'km'
    };

    // alternatives: provide N-1 alternatives; ORS expects number of alternative routes.
    if (typeof opts.alternatives === 'number' && opts.alternatives > 0) {
      payload.alternative_routes = {
        target_count: Math.min(3, Math.max(1, opts.alternatives))
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`ORS failed: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    return await res.json();
  }

  // ===== Queue runner =====
  async function runQueue(jobs, onProgress) {
    let lastWindowStart = nowMs();
    let sentInWindow = 0;

    for (let i = 0; i < jobs.length; i++) {
      // pace baseline
      await sleep(BASE_DELAY_MS);

      // window reset
      const t = nowMs();
      if (t - lastWindowStart >= 60_000) {
        lastWindowStart = t;
        sentInWindow = 0;
      }

      // if at cap, staged wait
      if (sentInWindow >= MAX_PER_MINUTE) {
        // staged wait: 45 + 10
        await showCountdown(45);
        await showCountdown(10);
        lastWindowStart = nowMs();
        sentInWindow = 0;
      }

      const job = jobs[i];
      try {
        const out = await job();
        sentInWindow++;
        if (onProgress) onProgress(i + 1, jobs.length);
        job._result = out;
      } catch (e) {
        // If likely rate-limit, wait & retry once
        const isRate = e && (e.status === 429 || /rate|quota|Too Many/i.test(String(e.message || '')));

        if (isRate) {
          await showCountdown(45);
          await showCountdown(10);
          lastWindowStart = nowMs();
          sentInWindow = 0;

          const out2 = await job();
          sentInWindow++;
          if (onProgress) onProgress(i + 1, jobs.length);
          job._result = out2;
        } else {
          throw e;
        }
      }
    }

    return jobs.map((j) => j._result);
  }

  // ===== Target builders (expects globals from script.js) =====
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

  function getInvalidPDRouteCounts() {
    // script.js stores PD route counts in per-row inputs; routing.js validates by reading DOM.
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

  // ===== Draw =====
  function drawGeojson(geojson, altIndex) {
    if (!ensureMapRefs()) return;
    const L = global.L;
    const g = global.ROUTING_STATE.routeLayerGroup;

    const color = altIndex === 0 ? COLOR_FIRST : COLOR_OTHERS;
    const weight = altIndex === 0 ? 5 : 3;
    const opacity = altIndex === 0 ? 0.85 : 0.55;

    L.geoJSON(geojson, {
      style: { color, weight, opacity }
    }).addTo(g);
  }

  // ===== Cache writer =====
  function writeCache(kind, origin, reverse, items) {
    global.ROUTING_CACHE = {
      kind,
      origin,
      reverse: !!reverse,
      generatedAt: new Date().toISOString(),
      items
    };
  }

  // ===== Route generators =====
  async function generatePDTrips() {
    const origin = getOrigin();
    if (!origin) {
      alert('Please search/select an origin address first.');
      return;
    }

    const invalid = getInvalidPDRouteCounts();
    if (invalid.length) {
      alert('Fix these PD route-count values:\n\n' + invalid.join('\n'));
      return;
    }

    const reverse = !!document.getElementById('rt-reverse')?.checked;
    const targets = getSelectedPDTargetsSafe();

    if (!targets.length) {
      alert('Please select at least one Planning District.');
      return;
    }

    global.ROUTING_STATE.busy = true;
    clearRoutesFromMap();

    // build jobs with per-PD alternative counts
    const jobs = [];
    const itemMeta = []; // keep mapping for cache assembly

    targets.forEach((t) => {
      const altCount = readPDAltCountForKey(t.key);
      const requestAlternatives = Math.max(0, altCount - 1); // ORS alt count means "extra routes"
      const from = reverse ? t.dest : origin;
      const to   = reverse ? origin : t.dest;

      const job = async () => {
        return await fetchRouteGeojson(from, to, { alternatives: requestAlternatives });
      };
      jobs.push(job);
      itemMeta.push({ t, altCount });
    });

    const results = await runQueue(jobs, (done, total) => {
      // you can add progress UI here if desired
      // console.log(`Routing ${done}/${total}`);
    }).catch((e) => {
      global.ROUTING_STATE.busy = false;
      global.ROUTING_STATE.lastError = e;
      console.error(e);
      alert('Routing failed. Check console for details.');
      throw e;
    });

    // draw + assemble cache items
    const cacheItems = [];
    results.forEach((geo, idx) => {
      const meta = itemMeta[idx];
      const t = meta.t;

      // ORS geojson may include FeatureCollection with "features"
      // With alternative_routes, ORS returns a FeatureCollection with multiple features (one per alternative)
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
        // fallback: draw entire object
        drawGeojson(geo, 0);
        routes.push({
          geojson: geo,
          summary: (geo && geo.properties && geo.properties.summary) ? geo.properties.summary : null,
          segments: (geo && geo.properties && geo.properties.segments) ? geo.properties.segments : null,
          alternativesIndex: 0
        });
      }

      cacheItems.push({
        key: t.key,
        name: t.name,
        muni: normalizeMuniName(t.muni),
        dest: t.dest,
        tripDir: computeTripDirCardinal(origin, t.dest),
        routes
      });
    });

    writeCache('pd', origin, reverse, cacheItems);
    global.ROUTING_STATE.busy = false;
    alert('PD trips generated. You can now Print Report.');
  }

  async function generatePZTrips() {
    const origin = getOrigin();
    if (!origin) {
      alert('Please search/select an origin address first.');
      return;
    }

    const reverse = !!document.getElementById('rt-reverse')?.checked;

    // Two modes:
    // 1) If exactly one PD selected, route to all zones inside that PD.
    // 2) If a specific zone is selected, route to that zone.
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

    global.ROUTING_STATE.busy = true;
    clearRoutesFromMap();

    const jobs = targets.map((t) => {
      const from = reverse ? t.dest : origin;
      const to   = reverse ? origin : t.dest;
      return async () => await fetchRouteGeojson(from, to, { alternatives: 0 });
    });

    const results = await runQueue(jobs).catch((e) => {
      global.ROUTING_STATE.busy = false;
      global.ROUTING_STATE.lastError = e;
      console.error(e);
      alert('Routing failed. Check console for details.');
      throw e;
    });

    const cacheItems = [];
    results.forEach((geo, idx) => {
      const t = targets[idx];
      drawGeojson(geo, 0);
      cacheItems.push({
        key: t.key,
        name: t.name,
        muni: normalizeMuniName(t.muni),
        dest: t.dest,
        tripDir: computeTripDirCardinal(origin, t.dest),
        routes: [{
          geojson: geo,
          summary: (geo && geo.properties && geo.properties.summary) ? geo.properties.summary : null,
          segments: (geo && geo.properties && geo.properties.segments) ? geo.properties.segments : null,
          alternativesIndex: 0
        }]
      });
    });

    writeCache('pz', origin, reverse, cacheItems);
    global.ROUTING_STATE.busy = false;
    alert('Zone trips generated. You can now Print Report.');
  }

  function clearGenerated() {
    clearRoutesFromMap();
    global.ROUTING_CACHE = {
      kind: null,
      origin: null,
      reverse: false,
      generatedAt: null,
      items: []
    };
    alert('Cleared generated trips.');
  }

  // ===== Distribute Trips Leaflet control =====
  const GeneratorControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const el = L.DomUtil.create('div', 'routing-control');
      el.innerHTML = `
        <div class="routing-header"><strong>Distribute Trips</strong></div>
        <div class="routing-actions">
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

        <details style="margin-top:4px;">
          <summary style="cursor:pointer;font-weight:700;font-size:0.9em;">Keys</summary>
          <div id="routing-key-box" style="margin-top:8px;"></div>
        </details>
      `;

      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);

      const btnPD = el.querySelector('#rt-gen-pd');
      const btnPZ = el.querySelector('#rt-gen-pz');
      const btnClear = el.querySelector('#rt-clear');

      if (btnPD) btnPD.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); generatePDTrips(); });
      if (btnPZ) btnPZ.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); generatePZTrips(); });
      if (btnClear) btnClear.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); clearGenerated(); });

      setTimeout(hydrateKeys, 50);
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
            hydrateKeys();
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
    generatePDTrips,
    generatePZTrips,
    clearGenerated
  };

  document.addEventListener('DOMContentLoaded', function () {
    initWhenReady();
  });

})(window);
