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
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  const S = {
    map: null,
    group: null,
    keys: [],
    keyIndex: 0,
    lastMode: null,
    lastTrips: [],
    // rate-limit state
    minuteStartMs: 0,
    minuteCount  : 0
  };

  // ===== Tiny helpers =====
  const byId = (id) => document.getElementById(id);

  const escapeHtml = (str) => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const qParam = (k) => new URLSearchParams(location.search).get(k) || '';
  const isFiniteNum = (n) => Number.isFinite(n) && !Number.isNaN(n);
  const num = (x) => {
    const n = typeof x === 'string' ? parseFloat(x) : +x;
    return Number.isFinite(n) ? n : NaN;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function sanitizeLonLat(input) {
    let arr = Array.isArray(input) ? input : [undefined, undefined];
    let x = num(arr[0]), y = num(arr[1]);
    // If lat/lon seem swapped, flip them.
    if (isFiniteNum(x) && isFiniteNum(y) && Math.abs(x) <= 90 && Math.abs(y) > 90) {
      const t = x; x = y; y = t;
    }
    if (!isFiniteNum(x) || !isFiniteNum(y)) {
      throw new Error(`Invalid coordinate (NaN). Raw: ${JSON.stringify(input)}`);
    }
    x = clamp(x, -180, 180);
    y = clamp(y, -85, 85);
    return [x, y];
  }

  function getOriginLonLat() {
    const o = global.ROUTING_ORIGIN;
    if (!o) {
      const err = new Error('Origin not set');
      err.code = 'NO_ORIGIN';
      throw err;
    }
    if (Array.isArray(o) && o.length >= 2) return sanitizeLonLat([o[0], o[1]]);
    if (typeof o.getLatLng === 'function') {
      const ll = o.getLatLng();
      return sanitizeLonLat([ll.lng, ll.lat]);
    }
    if (isFiniteNum(num(o.lng)) && isFiniteNum(num(o.lat))) {
      return sanitizeLonLat([o.lng, o.lat]);
    }
    if (o.latlng && isFiniteNum(num(o.latlng.lng)) && isFiniteNum(num(o.latlng.lat))) {
      return sanitizeLonLat([o.latlng.lng, o.latlng.lat]);
    }
    if (o.center) {
      if (Array.isArray(o.center) && o.center.length >= 2) {
        return sanitizeLonLat([o.center[0], o.center[1]]);
      }
      if (isFiniteNum(num(o.center.lng)) && isFiniteNum(num(o.center.lat))) {
        return sanitizeLonLat([o.center.lng, o.center.lat]);
      }
    }
    if (o.geometry?.coordinates?.length >= 2) {
      return sanitizeLonLat([o.geometry.coordinates[0], o.geometry.coordinates[1]]);
    }
    const x = o.lon ?? o.x, y = o.lat ?? o.y;
    if (isFiniteNum(num(x)) && isFiniteNum(num(y))) {
      return sanitizeLonLat([x, y]);
    }
    if (typeof o === 'string' && o.includes(',')) {
      const [a, b] = o.split(',').map(s => s.trim());
      try { return sanitizeLonLat([a, b]); } catch {}
      return sanitizeLonLat([b, a]);
    }
    throw new Error(`Origin shape unsupported: ${JSON.stringify(o)}`);
  }

  // ===== Key management =====
  function savedKeys() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEYS) || '[]');
    } catch {
      return [];
    }
  }

  function hydrateKeys() {
    const urlKey = qParam('orsKey');
    const saved  = savedKeys();
    const inline = [INLINE_DEFAULT_KEY];
    S.keys = (urlKey ? [urlKey] : []).concat(saved.length ? saved : inline);
    S.keyIndex = Math.min(+localStorage.getItem(LS_ACTIVE_INDEX) || 0, Math.max(0, S.keys.length - 1));
  }

  function currentKey() {
    return S.keys[Math.min(Math.max(S.keyIndex, 0), S.keys.length - 1)] || '';
  }

  function rotateKey() {
    if (S.keys.length <= 1) return false;
    S.keyIndex = (S.keyIndex + 1) % S.keys.length;
    localStorage.setItem(LS_ACTIVE_INDEX, String(S.keyIndex));
    return true;
  }

  // ===== Rate limiter + spinner overlay =====
  let rateOverlayEl = null;
  let rateOverlayTextEl = null;
  let rateOverlayTimer = null;

  function ensureSpinnerStyle() {
    if (document.getElementById('ors-rate-style')) return;
    const style = document.createElement('style');
    style.id = 'ors-rate-style';
    style.textContent = `
      @keyframes ors-spin { 0%{transform:rotate(0deg);}100%{transform:rotate(360deg);} }
      .ors-spinner {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 4px solid rgba(0,0,0,0.1);
        border-top-color: #333;
        animation: ors-spin 1s linear infinite;
        margin: 0 auto 10px auto;
      }
    `;
    document.head.appendChild(style);
  }

  function showRateWaitOverlay(waitMs) {
    ensureSpinnerStyle();
    const target = Date.now() + waitMs;

    if (!rateOverlayEl) {
      const backdrop = document.createElement('div');
      backdrop.id = 'ors-rate-overlay';
      backdrop.style.position = 'fixed';
      backdrop.style.inset = '0';
      backdrop.style.zIndex = '9998';
      backdrop.style.background = 'rgba(0,0,0,0.35)';
      backdrop.style.display = 'flex';
      backdrop.style.alignItems = 'center';
      backdrop.style.justifyContent = 'center';

      const box = document.createElement('div');
      box.style.background = '#fff';
      box.style.padding = '16px 20px';
      box.style.borderRadius = '8px';
      box.style.maxWidth = '360px';
      box.style.width = '90%';
      box.style.boxShadow = '0 8px 20px rgba(0,0,0,0.25)';
      box.style.textAlign = 'center';
      box.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

      box.innerHTML = `
        <div class="ors-spinner"></div>
        <h3 style="margin:0 0 8px 0;font-size:16px;">Waiting for OpenRouteService</h3>
        <p id="ors-rate-text" style="margin:0;font-size:13px;color:#444;"></p>
      `;

      backdrop.appendChild(box);
      document.body.appendChild(backdrop);

      rateOverlayEl = backdrop;
      rateOverlayTextEl = box.querySelector('#ors-rate-text');
    }

    rateOverlayEl.style.display = 'flex';

    function updateText() {
      const remaining = Math.max(0, target - Date.now());
      const secs = Math.ceil(remaining / 1000);
      if (rateOverlayTextEl) {
        rateOverlayTextEl.textContent =
          `Rate limit reached. Continuing in about ${secs}s…`;
      }
      if (remaining <= 0 && rateOverlayTimer) {
        clearInterval(rateOverlayTimer);
        rateOverlayTimer = null;
      }
    }

    updateText();
    if (rateOverlayTimer) clearInterval(rateOverlayTimer);
    rateOverlayTimer = setInterval(updateText, 1000);
  }

  function hideRateWaitOverlay() {
    if (rateOverlayTimer) {
      clearInterval(rateOverlayTimer);
      rateOverlayTimer = null;
    }
    if (rateOverlayEl) {
      rateOverlayEl.style.display = 'none';
    }
  }

  const RateLimiter = {
    async beforeRequest() {
      const now = Date.now();

      if (!S.minuteStartMs || now - S.minuteStartMs >= 60_000) {
        S.minuteStartMs = now;
        S.minuteCount = 0;
      }

      if (S.minuteCount >= MAX_PER_MINUTE) {
        const resetAt = S.minuteStartMs + 60_000;
        const waitMs  = Math.max(0, resetAt - now);
        if (waitMs > 0) {
          showRateWaitOverlay(waitMs);
          await sleep(waitMs);
          hideRateWaitOverlay();
        }
        S.minuteStartMs = Date.now();
        S.minuteCount   = 0;
      }

      S.minuteCount += 1;
      if (BASE_DELAY_MS > 0) await sleep(BASE_DELAY_MS);
    }
  };

  // ===== ORS fetch with retries & 429 handling =====
  async function orsFetch(path, { method = 'GET', body } = {}, attempt = 0) {
    const url = new URL(ORS_BASE + path);

    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: currentKey(),
          ...(method !== 'GET' && { 'Content-Type': 'application/json' })
        },
        body: method === 'GET' ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      // Network / CORS / transient failure (“Failed to fetch”, etc.)
      if (attempt < 2) {
        const waitMs = 10_000 * (attempt + 1); // 10s, then 20s
        showRateWaitOverlay(waitMs);
        await sleep(waitMs);
        hideRateWaitOverlay();
        return orsFetch(path, { method, body }, attempt + 1);
      }
      throw new Error(e && e.message ? e.message : 'Failed to fetch');
    }

    // 429 Too Many Requests
    if (res.status === 429) {
      // If we have multiple keys, rotate
      if (rotateKey()) {
        await sleep(150);
        return orsFetch(path, { method, body }, attempt + 1);
      }
      // Single key: honour Retry-After or wait ~60s
      if (attempt < 2) {
        let waitMs = 60_000;
        const retryAfter = res.headers.get('retry-after');
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!Number.isNaN(parsed) && parsed >= 0) {
            waitMs = parsed * 1000;
          }
        }
        showRateWaitOverlay(waitMs);
        await sleep(waitMs);
        hideRateWaitOverlay();
        return orsFetch(path, { method, body }, attempt + 1);
      }
    }

    // 401/403 with multiple keys → rotate and retry
    if ([401, 403].includes(res.status) && rotateKey()) {
      await sleep(150);
      return orsFetch(path, { method, body }, attempt + 1);
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(`ORS ${res.status}: ${txt}`);
    }

    return res.json();
  }

  // ===== Directions wrapper =====
  
  // ===== Geometry helpers (PD fallback) =====
  function _flattenLatLngs(latlngs) {
    // Returns array of polygons, where each polygon is [outerRing, ...holes]
    // Each ring is [[lng,lat], ...]
    if (!Array.isArray(latlngs) || !latlngs.length) return [];
    const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';
    const toRing = (ring) => ring.map(p => [p.lng, p.lat]);

    // Polygon: [LatLng, LatLng, ...] OR [[LatLng...], [hole...]]
    if (isLatLng(latlngs[0])) {
      return [[[toRing(latlngs)]]].map(x=>x[0]); // [[outer]]
    }
    // Polygon with rings: [[LatLng...], [hole...]]
    if (Array.isArray(latlngs[0]) && latlngs[0].length && isLatLng(latlngs[0][0])) {
      return [latlngs.map(toRing)];
    }
    // MultiPolygon: [[[LatLng...], ...], ...]
    if (Array.isArray(latlngs[0]) && Array.isArray(latlngs[0][0])) {
      const polys = [];
      for (const poly of latlngs) {
        if (Array.isArray(poly) && poly.length) {
          // poly is rings
          if (poly[0] && poly[0].length && isLatLng(poly[0][0])) polys.push(poly.map(toRing));
          // poly is nested one more level
          else if (Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && isLatLng(poly[0][0][0])) {
            for (const p2 of poly) polys.push(p2.map(toRing));
          }
        }
      }
      return polys;
    }
    return [];
  }

  function _pointInRing(pt, ring) {
    // Ray casting, pt = [lng,lat]
    const x = pt[0], y = pt[1];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > y) !== (yj > y)) &&
                        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function _pointInPoly(pt, poly) {
    // poly = [outerRing, ...holes]
    if (!poly || !poly.length) return false;
    const outer = poly[0];
    if (!_pointInRing(pt, outer)) return false;
    for (let h = 1; h < poly.length; h++) {
      if (_pointInRing(pt, poly[h])) return false; // inside a hole
    }
    return true;
  }

  function pointInLayer(lon, lat, layer) {
    if (!layer || typeof layer.getLatLngs !== 'function') return false;
    const polys = _flattenLatLngs(layer.getLatLngs());
    const pt = [lon, lat];
    for (const poly of polys) {
      if (_pointInPoly(pt, poly)) return true;
    }
    return false;
  }

  function lastCoordFromGeojson(json) {
    const feat = json && Array.isArray(json.features) ? json.features[0] : null;
    const coords = feat && feat.geometry && Array.isArray(feat.geometry.coordinates) ? feat.geometry.coordinates : [];
    return coords.length ? coords[coords.length - 1] : null; // [lng,lat]
  }

  // For PD/zone checks we don't care whether it's the start or end of the route;
  // we just need the route to at least pass through the polygon somewhere.
  function endsInsideLayer(json, layer) {
    if (!layer) return false;
    const feat = json && Array.isArray(json.features) ? json.features[0] : null;
    const coords = feat && feat.geometry && Array.isArray(feat.geometry.coordinates)
      ? feat.geometry.coordinates
      : [];

    if (!coords.length) return false;

    // Sample along the line (up to ~50 checks) to see if any point falls inside.
    const step = Math.max(1, Math.floor(coords.length / 50));
    for (let i = 0; i < coords.length; i += step) {
      const c = coords[i];
      if (pointInLayer(c[0], c[1], layer)) return true;
    }

    // Also check the final coordinate as a fallback.
    const last = coords[coords.length - 1];
    return pointInLayer(last[0], last[1], layer);
  }

  function candidatePointsInLayer(layer, maxPts = 16) {
    if (!layer || typeof layer.getBounds !== 'function') return [];
    const b = layer.getBounds();
    const south = b.getSouth(), north = b.getNorth(), west = b.getWest(), east = b.getEast();
    const latSpan = (north - south) || 0;
    const lngSpan = (east - west) || 0;
    const padLat = latSpan * 0.12;
    const padLng = lngSpan * 0.12;

    const s = south + padLat, n = north - padLat, w = west + padLng, e = east - padLng;
    const pts = [];
    for (let iy = 0; iy < 5; iy++) {
      const lat = s + (n - s) * (iy / 4);
      for (let ix = 0; ix < 5; ix++) {
        const lon = w + (e - w) * (ix / 4);
        if (pointInLayer(lon, lat, layer)) pts.push([lon, lat]);
      }
    }
    // Put center-first
    const c = b.getCenter();
    pts.sort((a, b2) => {
      const da = (a[0]-c.lng)**2 + (a[1]-c.lat)**2;
      const db = (b2[0]-c.lng)**2 + (b2[1]-c.lat)**2;
      return da - db;
    });
    // unique-ish
    const out = [];
    const seen = new Set();
    for (const p of pts) {
      const k = p[0].toFixed(6) + ',' + p[1].toFixed(6);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
      if (out.length >= maxPts) break;
    }
    return out;
  }

  // ===== Directions wrapper =====
  async function getRoutes(originLonLat, destLonLat, maxCount, opts = {}) {
    const o = sanitizeLonLat(originLonLat);
    const d = sanitizeLonLat(destLonLat);

    const baseBody = {
      coordinates: [o, d],
      preference: PREFERENCE,
      instructions: true,
      instructions_format: 'html',
      language: 'en',
      geometry_simplify: false,
      elevation: false,
      units: 'km'
    };
    if (maxCount > 1) {
      baseBody.alternative_routes = {
        target_count: Math.min(Math.max(1, maxCount), 3),
        share_factor: 0.6
      };
    }

    const layer  = opts.layer || null;
    const pdSide = (opts.pdSide === 'origin') ? 'origin' : 'dest'; // which end is the PD/zone point

    const doFetch = (body) =>
      orsFetch(`/v2/directions/${PROFILE}/geojson`, { method: 'POST', body });

    const makeRadiuses = (r) => (pdSide === 'origin' ? [r, 350] : [350, r]);

    try {
      return await doFetch(baseBody);
    } catch (e) {
      const msg = String(e.message || '');

      const is2099 = msg.includes('ORS 500') && (msg.includes('"code":2099') || msg.includes('code:2099'));
      const is2010 = msg.includes('ORS 404') && (
        msg.includes('"code":2010') ||
        msg.includes('code:2010') ||
        msg.includes('Could not find routable point')
      );

      // 2010: destination/origin isn't close enough to a routable road (centroid in woods/water/etc.)
      if (is2010) {
        // 1) Retry by allowing a larger snap radius on the PD-side point
        for (const r of [1000, 2000, 5000, 8000]) {
          try {
            const j = await doFetch({ ...baseBody, radiuses: makeRadiuses(r) });
            if (!layer || endsInsideLayer(j, layer)) return j;
          } catch (_) {}
        }

        // 2) If we have the PD polygon layer, try alternate points INSIDE the polygon
        if (layer) {
          const candidates = candidatePointsInLayer(layer, 16);
          for (const p of candidates) {
            const coords = (pdSide === 'origin') ? [p, d] : [o, p];
            for (const r of [2000, 8000]) {
              try {
                const j = await doFetch({ ...baseBody, coordinates: coords, radiuses: makeRadiuses(r) });
                if (endsInsideLayer(j, layer)) return j;
              } catch (_) {}
            }
          }
        }

        // If we get here, we truly couldn't find a routable point close enough.
        throw e;
      }

      // 2099: handle swapped lon/lat fallback (existing behavior)
      if (!is2099) throw e;
      const dSwap = sanitizeLonLat([d[1], d[0]]);
      const bodySwap = { ...baseBody, coordinates: [o, dSwap] };
      return await doFetch(bodySwap);
    }
  }

// ===== Drawing / state =====
  function clearRoutes() {
    if (S.group) {
      try { S.map.removeLayer(S.group); } catch {}
      S.group = null;
    }
    S.lastTrips = [];
    S.lastMode  = null;
    global.ROUTING_CACHE = undefined;
  }

  function drawRoute(coords, color) {
    if (!coords?.length) return;
    if (!S.group) S.group = L.layerGroup().addTo(S.map);
    const latlngs = coords.map(([lng, lat]) => [lat, lng]);
    L.polyline(latlngs, { color, weight: 4, opacity: 0.9 }).addTo(S.group);
  }

  // ===== PD route-count + requests =====
  function collectPDRequests() {
    const registry = global.PD_REGISTRY || {};
    const items    = Array.from(document.querySelectorAll('.pd-item'));
    const invalid  = [];
    const requests = [];

    // validate route-count fields
    for (const item of items) {
      const cbx   = item.querySelector('.pd-cbx');
      const input = item.querySelector('.pd-route-count');
      const keyEnc = cbx?.dataset.key || item.dataset.key || '';
      const key    = decodeURIComponent(keyEnc || '');
      const reg    = registry[key];
      const name   = reg?.name || key || 'Unknown PD';

      if (!input) continue;

      let raw = input.value.trim();
      if (raw === '') {
        raw = cbx && cbx.checked ? '1' : '0';
        input.value = raw;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || Math.floor(n) !== n || n < 0 || n > 3) {
        invalid.push({ key, name, value: raw });
      }
    }

    if (invalid.length) {
      const err = new Error('Invalid PD route counts');
      err.type  = 'validation';
      err.invalid = invalid;
      throw err;
    }

    // build requests from checked PDs
    for (const item of items) {
      const cbx = item.querySelector('.pd-cbx');
      if (!cbx || !cbx.checked) continue;

      const keyEnc = cbx.dataset.key || item.dataset.key || '';
      const key    = decodeURIComponent(keyEnc || '');
      const reg    = registry[key];
      if (!reg || !reg.layer) continue;

      const center = reg.layer.getBounds().getCenter();
      const name   = reg.name || key || 'PD';

      let count = 1;
      const input = item.querySelector('.pd-route-count');
      if (input) {
        const raw = input.value.trim() || '1';
        const n   = Number(raw);
        if (!Number.isFinite(n) || n <= 0) continue;
        count = Math.min(Math.max(1, Math.floor(n)), 3);
      }

      requests.push({
        key,
        name,
        layer: reg.layer,
        lon: center.lng,
        lat: center.lat,
        count
      });
    }

    return requests;
  }

  // ===== Zone targets =====
  function collectZoneTargets() {
    if (typeof global.getSelectedZoneTargets !== 'function') {
      const err = new Error('Zone helper missing');
      err.type  = 'noZonesHelper';
      throw err;
    }
    const raw = global.getSelectedZoneTargets() || [];
    const out = [];

    for (const t of raw) {
      if (!t) continue;
      if (Array.isArray(t) && t.length >= 2) {
        out.push({
          lon: t[0],
          lat: t[1],
          label: t[2] || 'Zone'
        });
      } else if (typeof t === 'object') {
        const lon = t.lon ?? t.lng ?? t.x ?? (t.center && t.center[0]);
        const lat = t.lat ?? t.y ?? (t.center && t.center[1]);
        if (!isFiniteNum(num(lon)) || !isFiniteNum(num(lat))) continue;
        out.push({
          lon: num(lon),
          lat: num(lat),
          label: t.label || t.name || 'Zone'
        });
      }
    }
    return out;
  }

  // ===== Overlays =====
  function showValidationPopup(invalid) {
    if (!invalid || !invalid.length) return;
    const existing = document.getElementById('routing-validation-overlay');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'routing-validation-overlay';
    backdrop.style.position = 'fixed';
    backdrop.style.inset = '0';
    backdrop.style.zIndex = '9999';
    backdrop.style.background = 'rgba(0,0,0,0.35)';
    backdrop.style.display = 'flex';
    backdrop.style.alignItems = 'center';
    backdrop.style.justifyContent = 'center';

    const box = document.createElement('div');
    box.style.background = '#fff';
    box.style.padding = '16px 20px';
    box.style.borderRadius = '8px';
    box.style.maxWidth = '420px';
    box.style.width = '90%';
    box.style.boxShadow = '0 8px 20px rgba(0,0,0,0.25)';
    box.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    box.innerHTML = `
      <h3 style="margin:0 0 8px 0;">Trip generation blocked</h3>
      <p style="margin:0 0 8px 0;font-size:0.95em;">
        Trip generation is not possible because the following Planning District(s)
        have an invalid route count. Please use only <strong>0, 1, 2, or 3</strong>.
      </p>
      <ul style="margin:0 0 12px 20px;padding:0;font-size:0.95em;">
        ${invalid.map(i => `<li>${escapeHtml(i.name || i.key || 'PD')} — value: "${escapeHtml(i.value)}"</li>`).join('')}
      </ul>
      <div style="text-align:right;">
        <button id="routing-validation-close">Close</button>
      </div>
    `;

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const closeBtn = box.querySelector('#routing-validation-close');
    if (closeBtn) closeBtn.addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
  }

  // Overlay for “only one PD” rule for Zone Trips
  function showSinglePDPopup(selectedKeys) {
    const existing = document.getElementById('routing-pd-overlay');
    if (existing) existing.remove();

    const registry = global.PD_REGISTRY || {};
    const names = (selectedKeys || []).map(k => {
      const reg = registry[k];
      return reg?.name || k || 'PD';
    });

    const backdrop = document.createElement('div');
    backdrop.id = 'routing-pd-overlay';
    backdrop.style.position = 'fixed';
    backdrop.style.inset = '0';
    backdrop.style.zIndex = '9999';
    backdrop.style.background = 'rgba(0,0,0,0.35)';
    backdrop.style.display = 'flex';
    backdrop.style.alignItems = 'center';
    backdrop.style.justifyContent = 'center';

    const box = document.createElement('div');
    box.style.background = '#fff';
    box.style.padding = '16px 20px';
    box.style.borderRadius = '8px';
    box.style.maxWidth = '420px';
    box.style.width = '90%';
    box.style.boxShadow = '0 8px 20px rgba(0,0,0,0.25)';
    box.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    box.innerHTML = `
      <h3 style="margin:0 0 8px 0;">Select a single Planning District</h3>
      <p style="margin:0 0 8px 0;font-size:0.95em;">
        <strong>Zone Trips</strong> can only run when exactly one Planning District
        is selected. Right now you have the following PDs checked:
      </p>
      <ul style="margin:0 0 12px 20px;padding:0;font-size:0.95em;">
        ${names.map(n => `<li>${escapeHtml(n)}</li>`).join('')}
      </ul>
      <p style="margin:0 0 12px 0;font-size:0.95em;">
        Please uncheck all but one Planning District and try again.
      </p>
      <div style="text-align:right;">
        <button id="routing-pd-close">Close</button>
      </div>
    `;

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const closeBtn = box.querySelector('#routing-pd-close');
    if (closeBtn) closeBtn.addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
  }

  // ===== Button state =====
  function setBusy(mode, busy) {
    const btnPD    = byId('rt-gen-pd');
    const btnPZ    = byId('rt-gen-pz');
    const btnClear = byId('rt-clear');

    if (mode === 'PD' && btnPD) {
      btnPD.disabled  = busy;
      btnPD.textContent = busy ? 'PD Trips…' : 'PD Trips';
    }
    if (mode === 'PZ' && btnPZ) {
      btnPZ.disabled  = busy;
      btnPZ.textContent = busy ? 'Zone Trips…' : 'Zone Trips';
    }
    if (btnClear) btnClear.disabled = busy;
  }

  // ===== PD trips =====
  async function generateForPDs() {
    try {
      const origin  = getOriginLonLat();
      const reverse = !!byId('rt-reverse')?.checked;

      const requests = collectPDRequests();
      if (!requests.length) {
        alert('Select at least one Planning District.');
        return;
      }

      setBusy('PD', true);
      clearRoutes();
      S.lastMode  = 'PD';
      S.lastTrips = [];

      for (const req of requests) {
        const dest = sanitizeLonLat([req.lon, req.lat]);
        const o = reverse ? dest : origin;
        const d = reverse ? origin : dest;

        await RateLimiter.beforeRequest();
        let json;
        try {
          json = await getRoutes(o, d, req.count, { layer: req.layer, pdSide: (reverse ? 'origin' : 'dest') });
        } catch (errOne) {
          console.warn('PD routing failed for', req?.name || req?.key || 'PD', errOne);
          S.lastTrips.push({
            mode: 'PD',
            key : req.key,
            name: req.name,
            reverse,
            origin: { lon: o[0], lat: o[1], label: (reverse ? req.name : ((global.ROUTING_ORIGIN && (global.ROUTING_ORIGIN.label || global.ROUTING_ORIGIN.name)) || 'Origin')) },
            destination: { lon: d[0], lat: d[1], label: (reverse ? ((global.ROUTING_ORIGIN && (global.ROUTING_ORIGIN.label || global.ROUTING_ORIGIN.name)) || 'Origin') : req.name) },
            features: [],
            error: String(errOne && errOne.message ? errOne.message : errOne)
          });
          continue;
        }
        const feats = Array.isArray(json.features) ? json.features.slice(0, req.count) : [];
        if (!feats.length) {
          console.warn('No routes returned for', req?.name || req?.key || 'PD');
          S.lastTrips.push({
            mode: 'PD',
            key : req.key,
            name: req.name,
            reverse,
            origin: { lon: o[0], lat: o[1], label: (reverse ? req.name : ((global.ROUTING_ORIGIN && (global.ROUTING_ORIGIN.label || global.ROUTING_ORIGIN.name)) || 'Origin')) },
            destination: { lon: d[0], lat: d[1], label: (reverse ? ((global.ROUTING_ORIGIN && (global.ROUTING_ORIGIN.label || global.ROUTING_ORIGIN.name)) || 'Origin') : req.name) },
            features: [],
            error: 'No routes returned by ORS for this destination.'
          });
          continue;
        }

        // sort alternatives by duration then distance
        feats.sort((a, b) => {
          const pa = a.properties || {};
          const pb = b.properties || {};
          const sa = pa.summary || (pa.segments && pa.segments[0]) || {};
          const sb = pb.summary || (pb.segments && pb.segments[0]) || {};
          const da = num(sa.duration);
          const db = num(sb.duration);
          if (Number.isFinite(da) && Number.isFinite(db) && da !== db) return da - db;
          const la = num(sa.distance);
          const lb = num(sb.distance);
          if (Number.isFinite(la) && Number.isFinite(lb) && la !== lb) return la - lb;
          return 0;
        });

        feats.forEach((feat, idx) => {
          const coords = feat.geometry?.coordinates || [];
          drawRoute(coords, idx === 0 ? COLOR_FIRST : COLOR_OTHERS);
        });

        const defaultOriginLabel =
          (global.ROUTING_ORIGIN && (global.ROUTING_ORIGIN.label || global.ROUTING_ORIGIN.name)) || 'Origin';
        const originLabel = reverse ? req.name : defaultOriginLabel;
        const destLabel   = reverse ? defaultOriginLabel : req.name;

        S.lastTrips.push({
          type: 'PD',
          key : req.key,
          name: req.name,
          reverse,
          origin: { lon: o[0], lat: o[1], label: originLabel },
          destination: { lon: d[0], lat: d[1], label: destLabel },
          features: feats.map(f => ({ geometry: f.geometry, properties: f.properties }))
        });
      }

      global.ROUTING_CACHE = {
        mode: 'PD',
        reverse,
        trips: S.lastTrips
      };
    } catch (e) {
      console.error(e);
      if (e.type === 'validation') {
        showValidationPopup(e.invalid);
      } else if (e.code === 'NO_ORIGIN') {
        alert('Please pick an origin using the address search bar before generating trips.');
      } else {
        alert('Routing error: ' + (e.message || e));
      }
    } finally {
      setBusy('PD', false);
      hideRateWaitOverlay();
    }
  }

  // ===== PZ trips =====
  // 1) If a zone is selected → route to that zone.
  // 2) Else, if exactly one PD is checked → route to ALL zones in that PD.
  async function generateForPZs() {
    try {
      const origin  = getOriginLonLat();
      const reverse = !!byId('rt-reverse')?.checked;

      let targets = [];
      let explicitZoneTargets = [];

      // try selected zone first
      try {
        explicitZoneTargets = collectZoneTargets();
      } catch (e) {
        if (e.type === 'noZonesHelper') explicitZoneTargets = [];
        else throw e;
      }

      if (explicitZoneTargets.length) {
        targets = explicitZoneTargets;
      } else {
        // fallback: 1 PD → all its zones
        const boxes = Array.from(document.querySelectorAll('.pd-cbx:checked'));
        const pdKeys = boxes
          .map(b => decodeURIComponent(b.dataset.key || b.closest('.pd-item')?.dataset.key || ''))
          .filter(Boolean);

        if (!pdKeys.length) {
          alert('To generate PZ trips, either select a Planning Zone or check exactly one Planning District.');
          return;
        }
        if (pdKeys.length > 1) {
          showSinglePDPopup(pdKeys);
          return;
        }

        const pdKey = pdKeys[0];
        if (typeof global.getZoneTargetsForPD !== 'function') {
          alert('PZ trip generation by PD requires script.js to define window.getZoneTargetsForPD(pdKey).');
          return;
        }

        const pdTargets = global.getZoneTargetsForPD(pdKey) || [];
        if (!pdTargets.length) {
          alert('No Planning Zones found for the selected Planning District.');
          return;
        }

        targets = pdTargets.map(t => ({
          lon: t.lon,
          lat: t.lat,
          label: t.label
        }));
      }

      if (!targets.length) {
        alert('No Planning Zones available to route to.');
        return;
      }

      setBusy('PZ', true);
      clearRoutes();
      S.lastMode  = 'PZ';
      S.lastTrips = [];

      for (const t of targets) {
        const dest = sanitizeLonLat([t.lon, t.lat]);
        const o = reverse ? dest : origin;
        const d = reverse ? origin : dest;

        await RateLimiter.beforeRequest();
        const json = await getRoutes(o, d, 1);
        const feat = Array.isArray(json.features) ? json.features[0] : null;
        if (!feat) continue;

        const coords = feat.geometry?.coordinates || [];
        drawRoute(coords, COLOR_FIRST);

        const defaultOriginLabel =
          (global.ROUTING_ORIGIN && (global.ROUTING_ORIGIN.label || global.ROUTING_ORIGIN.name)) || 'Origin';
        const originLabel = reverse ? (t.label || 'Zone') : defaultOriginLabel;
        const destLabel   = reverse ? defaultOriginLabel : (t.label || 'Zone');

        S.lastTrips.push({
          type: 'PZ',
          label: t.label || 'Zone',
          reverse,
          origin: { lon: o[0], lat: o[1], label: originLabel },
          destination: { lon: d[0], lat: d[1], label: destLabel },
          features: [ { geometry: feat.geometry, properties: feat.properties } ]
        });
      }

      global.ROUTING_CACHE = {
        mode: 'PZ',
        reverse,
        trips: S.lastTrips
      };
    } catch (e) {
      console.error(e);
      if (e.code === 'NO_ORIGIN') {
        alert('Please pick an origin using the address search bar before generating trips.');
      } else {
        alert('Routing error: ' + (e.message || e));
      }
    } finally {
      setBusy('PZ', false);
      hideRateWaitOverlay();
    }
  }

  // ===== Wire buttons & key UI =====
  function wireControls() {
    const btnPD      = byId('rt-gen-pd');
    const btnPZ      = byId('rt-gen-pz');
    const btnClear   = byId('rt-clear');
    const btnSaveKey = byId('rt-save');
    const btnUseUrl  = byId('rt-url');
    const inpKeys    = byId('rt-keys');

    if (btnPD)    btnPD.onclick    = () => generateForPDs();
    if (btnPZ)    btnPZ.onclick    = () => generateForPZs();
    if (btnClear) btnClear.onclick = () => clearRoutes();

    if (btnSaveKey && inpKeys) {
      btnSaveKey.onclick = () => {
        const arr = inpKeys.value.split(',').map(x => x.trim()).filter(Boolean);
        localStorage.setItem(LS_KEYS, JSON.stringify(arr));
        hydrateKeys();
        alert(`Saved ${S.keys.length} key(s).`);
      };
    }

    if (btnUseUrl) {
      btnUseUrl.onclick = () => {
        const k = qParam('orsKey');
        if (!k) alert('Add ?orsKey=YOUR_KEY to the URL query.');
        else {
          localStorage.setItem(LS_KEYS, JSON.stringify([k]));
          hydrateKeys();
          alert('Using orsKey from URL.');
        }
      };
    }
  }

  // ===== Distribute Trips Leaflet control =====
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
      const geocoderEl = document.querySelector('.leaflet-control-geocoder');
      if (geocoderEl) el.style.width = geocoderEl.offsetWidth + 'px';
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  async function innerInit(map) {
    S.map = map;
    hydrateKeys();
    S.group = L.layerGroup().addTo(map);
    map.addControl(new GeneratorControl());
    setTimeout(wireControls, 0);
  }

  const Routing = {
    init(map) {
      if (!map || !map._loaded) {
        const retry = () =>
          (map && map._loaded) ? innerInit(map) : setTimeout(retry, 80);
        return retry();
      }
      innerInit(map);
    }
  };

  global.Routing = Routing;

  document.addEventListener('DOMContentLoaded', () => {
    const tryInit = () => {
      if (global.map && (global.map._loaded || global.map._size)) Routing.init(global.map);
      else setTimeout(tryInit, 80);
    };
    tryInit();
  });
})(window);
