// routing.js with Distribute Trips, PD/Zone routing, best-inside-PD/zone,
// Avoid Routes box, Highway 407 toggle, and robust origin handling.

(function (global) {
  'use strict';

  // ===== Config =====
  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // Simple rate-limit model (40 req/minute)
  const MAX_PER_MINUTE = 40;

  // Inline fallback key (can be overridden by ?orsKey or saved keys)
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
    minuteStartMs: 0,
    minuteCount  : 0
  };

  // ===== Tiny helpers =====
  const byId = (id) => document.getElementById(id);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const qParam = (k) => new URLSearchParams(location.search).get(k) || '';

  const isFiniteNum = (n) => Number.isFinite(n) && !Number.isNaN(n);

  const num = (x) => {
    const n = typeof x === 'string' ? parseFloat(x) : +x;
    return Number.isFinite(n) ? n : NaN;
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ===== Avoid-routes helpers =====

  function parseAvoidRules(raw) {
    const out = [];
    if (!raw) return out;
    const entries = String(raw).split(';');
    for (let entry of entries) {
      entry = String(entry || '').trim();
      if (!entry) continue;

      const lower = entry.toLowerCase();
      const fromIdx = lower.indexOf('from:');
      if (fromIdx > 0) {
        entry = entry.slice(0, fromIdx).trim().replace(/,+$/, '');
      }

      const m = entry.match(/^(.*?)(\(([^)]+)\))?$/);
      if (!m) continue;
      const street = (m[1] || '').trim();
      const muni   = (m[3] || '').trim();
      if (!street) continue;

      out.push({
        type : 'street',
        name : street.toUpperCase(),
        muni : muni ? muni.toUpperCase() : null
      });
    }
    return out;
  }

  function getAvoidPreferences() {
    const textarea = byId('rt-avoid-text');
    const chk407   = byId('rt-avoid-407');

    const rawText = textarea ? textarea.value : '';
    const rules   = parseAvoidRules(rawText);

    if (chk407 && chk407.checked) {
      rules.push({
        type: 'street',
        name: '407',
        muni: null,
        id  : 'HWY_407'
      });
    }

    return {
      rules,
      hasRules: rules.length > 0
    };
  }

  function applyAvoidPreferences(json, avoidPref) {
    if (!json || !avoidPref || !avoidPref.rules || !avoidPref.rules.length) {
      return json;
    }
    const rules = avoidPref.rules;
    const feats = Array.isArray(json.features) ? json.features.slice() : [];
    if (feats.length <= 1) return json;

    function scoreFeature(feat) {
      const props = feat && feat.properties || {};
      const segs  = Array.isArray(props.segments) ? props.segments : [];
      let score = 0;
      for (const seg of segs) {
        const steps = Array.isArray(seg.steps) ? seg.steps : [];
        for (const step of steps) {
          const nm = (step && step.name ? String(step.name) : '').toUpperCase();
          if (!nm) continue;
          for (const rule of rules) {
            if (!rule || !rule.name) continue;
            if (nm.includes(rule.name)) {
              score += 1;
            }
          }
        }
      }
      return score;
    }

    const ranked = feats.map((feat, idx) => ({
      feat,
      idx,
      score: scoreFeature(feat)
    }));

    ranked.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.idx - b.idx;
    });

    json.features = ranked.map(r => r.feat);
    return json;
  }

  // ===== Core numeric helpers =====

  function sanitizeLonLat(input) {
    let arr = Array.isArray(input) ? input : [undefined, undefined];
    let x = num(arr[0]), y = num(arr[1]);
    if (isFiniteNum(x) && isFiniteNum(y)) {
      if (Math.abs(x) <= 90 && Math.abs(y) <= 180) {
        const tmp = x; x = y; y = tmp;
      }
    }
    if (!isFiniteNum(x) || !isFiniteNum(y)) {
      throw new Error('Invalid lon/lat: ' + JSON.stringify(input));
    }
    return [clamp(x, -180, 180), clamp(y, -90, 90)];
  }

  // ===== Rate-limit helpers =====

  function heedRateLimit() {
    const now = Date.now();
    if (!S.minuteStartMs || now - S.minuteStartMs >= 60_000) {
      S.minuteStartMs = now;
      S.minuteCount   = 0;
      return 0;
    }
    if (S.minuteCount < MAX_PER_MINUTE) return 0;
    const elapsed = now - S.minuteStartMs;
    const waitMs  = 60_000 - elapsed;
    return waitMs > 0 ? waitMs : 0;
  }

  function noteRequest() {
    const now = Date.now();
    if (!S.minuteStartMs || now - S.minuteStartMs >= 60_000) {
      S.minuteStartMs = now;
      S.minuteCount   = 0;
    }
    S.minuteCount += 1;
  }

  function showWaitOverlay(waitSeconds) {
    let overlay = document.querySelector('.routing-wait-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'routing-wait-overlay';
      overlay.innerHTML = `
        <div class="routing-wait-modal">
          <div class="spinner"></div>
          <div class="routing-wait-text">
            <div><strong>Rate limit reached</strong></div>
            <div id="routing-wait-countdown"></div>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';

    const label = overlay.querySelector('#routing-wait-countdown');
    if (label) {
      label.textContent = `Waiting ${waitSeconds}s before continuing…`;
    }

    let remaining = waitSeconds;
    const timerId = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timerId);
      }
      if (label) {
        label.textContent = `Waiting ${remaining}s before continuing…`;
      }
    }, 1000);

    return () => {
      overlay.style.display = 'none';
      clearInterval(timerId);
    };
  }

  async function withRateLimit(fn, label) {
    const initialWait = heedRateLimit();
    if (initialWait > 0) {
      const hide = showWaitOverlay(Math.ceil(initialWait / 1000));
      await sleep(initialWait);
      hide();
    }
    try {
      noteRequest();
      return await fn();
    } catch (e) {
      // if we still hit rate-limit, wait again once
      const wait = heedRateLimit();
      if (wait > 0) {
        const hide = showWaitOverlay(Math.ceil(wait / 1000));
        await sleep(wait);
        hide();
      }
      noteRequest();
      return await fn();
    }
  }

  // ===== Key storage =====

  function loadKeysFromStorage() {
    try {
      const raw = localStorage.getItem(LS_KEYS);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.map(x => String(x || '').trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  function saveKeysToStorage(keys) {
    try {
      localStorage.setItem(LS_KEYS, JSON.stringify(keys || []));
    } catch {
      // ignore
    }
  }

  function loadActiveKeyIndex() {
    try {
      const n = parseInt(localStorage.getItem(LS_ACTIVE_INDEX), 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  function saveActiveKeyIndex(idx) {
    try {
      localStorage.setItem(LS_ACTIVE_INDEX, String(idx || 0));
    } catch {
      // ignore
    }
  }

  function hydrateKeys() {
    const fromLS  = loadKeysFromStorage();
    const fromUrl = (qParam('orsKey') || '').trim();
    const merged  = [];

    for (const k of fromLS) if (k && !merged.includes(k)) merged.push(k);
    if (fromUrl && !merged.includes(fromUrl)) merged.push(fromUrl);
    if (INLINE_DEFAULT_KEY && !merged.includes(INLINE_DEFAULT_KEY)) {
      merged.push(INLINE_DEFAULT_KEY);
    }
    if (!merged.length) merged.push(INLINE_DEFAULT_KEY);

    S.keys     = merged;
    S.keyIndex = loadActiveKeyIndex();
    if (S.keyIndex < 0 || S.keyIndex >= S.keys.length) S.keyIndex = 0;
  }

  function getActiveKey() {
    if (!S.keys || !S.keys.length) hydrateKeys();
    return S.keys[S.keyIndex] || '';
  }

  function rotateKeyOnError() {
    if (!S.keys || S.keys.length <= 1) return;
    S.keyIndex = (S.keyIndex + 1) % S.keys.length;
    saveActiveKeyIndex(S.keyIndex);
  }

  // ===== ORS fetch wrapper =====

  async function orsFetch(path, bodyObj, avoidPref) {
    const key = getActiveKey();
    if (!key) throw new Error('No ORS key available');

    const url = `${ORS_BASE}${path}?api_key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept'      : 'application/json'
      },
      body: JSON.stringify(bodyObj)
    });

    if (res.status === 401 || res.status === 403) {
      rotateKeyOnError();
      const key2 = getActiveKey();
      if (!key2) throw new Error('No ORS key available after rotate');
      const url2 = `${ORS_BASE}${path}?api_key=${encodeURIComponent(key2)}`;
      const res2 = await fetch(url2, {
        method : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept'      : 'application/json'
        },
        body: JSON.stringify(bodyObj)
      });
      if (!res2.ok) {
        const text2 = await res2.text();
        throw new Error(`ORS error after rotate: ${res2.status} ${text2}`);
      }
      const json2 = await res2.json();
      return applyAvoidPreferences(json2, avoidPref);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ORS error: ${res.status} ${text}`);
    }
    const json = await res.json();
    return applyAvoidPreferences(json, avoidPref);
  }

  // ===== Geometry helpers =====

  function pointInLayer(coord, layer) {
    if (!layer || !layer.getLayers) return false;
    const pt = L.latLng(coord[1], coord[0]);
    let inside = false;
    layer.eachLayer(function (sub) {
      if (inside) return;
      if (sub.getBounds && sub.getBounds().contains(pt)) {
        inside = true;
      }
    });
    return inside;
  }

  function endsInsideLayer(geojson, layer, pdSide) {
    if (!layer) return true;
    try {
      const feat = geojson &&
        Array.isArray(geojson.features) &&
        geojson.features[0];
      if (!feat || !feat.geometry ||
          feat.geometry.type !== 'LineString' ||
          !Array.isArray(feat.geometry.coordinates)) {
        return false;
      }
      const coords = feat.geometry.coordinates;
      if (!coords.length) return false;

      // Sample along the route (up to ~50 points) and see if any point
      // lies inside the polygon. This works for both origin->PD and
      // PD->origin directions.
      const step = Math.max(1, Math.floor(coords.length / 50));
      for (let i = 0; i < coords.length; i += step) {
        const c = coords[i];
        if (!Array.isArray(c) || c.length < 2) continue;
        if (pointInLayer([c[0], c[1]], layer)) return true;
      }

      // Also check the endpoint corresponding to the PD/zone side.
      const idx = (pdSide === 'origin') ? 0 : coords.length - 1;
      const end = coords[idx];
      if (Array.isArray(end) && end.length >= 2) {
        return pointInLayer([end[0], end[1]], layer);
      }
      return false;
    } catch (e) {
      console.warn('endsInsideLayer error', e);
      return false;
    }
  }

  // ===== getRoutes with best-inside-PD/zone + avoid-routes =====

  async function getRoutes(originLonLat, destLonLat, maxCount, opts = {}) {
    const reverse = !!opts.reverse;
    let o = sanitizeLonLat(originLonLat);
    let d = sanitizeLonLat(destLonLat);
    if (reverse) {
      const tmp = o; o = d; d = tmp;
    }

    const avoidPref = getAvoidPreferences();
    const hasAvoid  = !!(avoidPref && avoidPref.rules && avoidPref.rules.length);

    const baseBody = {
      coordinates: [o, d],
      preference: PREFERENCE,
      instructions: true,
      instructions_format: 'text',
      language: 'en',
      geometry_simplify: false,
      elevation: false,
      units: 'km'
    };

    const targetForAlts = Math.max(
      hasAvoid ? 2 : 1,
      Math.min(Math.max(1, maxCount), 3)
    );
    if (targetForAlts > 1) {
      baseBody.alternative_routes = {
        target_count: targetForAlts,
        share_factor: 0.6
      };
    }

    const layer  = opts.layer || null;
    const pdSide = (opts.pdSide === 'origin') ? 'origin' : 'dest';

    const makeBodyWithRadius = (r) => {
      const radiuses = reverse ? [r, r] : [r, r];
      return { ...baseBody, radiuses };
    };

    async function attempt(body) {
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`, body, avoidPref);
    }

    try {
      return await attempt(baseBody);
    } catch (e1) {
      const msg = String(e1 && e1.message || '');
      if (!msg.includes('"code":2010') &&
          !msg.includes('Could not find routable point')) {
        throw e1;
      }

      const radiuses = [1000, 3000, 5000, 8000];
      for (const r of radiuses) {
        try {
          const body = makeBodyWithRadius(r);
          const json = await attempt(body);
          if (!layer || endsInsideLayer(json, layer, pdSide)) {
            return json;
          }
        } catch (inner) {
          console.warn('ORS 2010 fallback failed for radius', r, inner);
        }
      }
      throw e1;
    }
  }

  // ===== Map drawing =====

  function clearLayerGroup() {
    if (S.group) S.group.clearLayers();
  }

  function colorForIndex(i) {
    return i === 0 ? COLOR_FIRST : COLOR_OTHERS;
  }

  function drawTripLines(trips) {
    clearLayerGroup();
    if (!trips || !trips.length || !S.group) return;

    const bounds = [];
    trips.forEach((t, idx) => {
      const feat = t.geojson &&
        Array.isArray(t.geojson.features) &&
        t.geojson.features[0];
      if (!feat || !feat.geometry ||
          feat.geometry.type !== 'LineString' ||
          !Array.isArray(feat.geometry.coordinates)) {
        return;
      }
      const latlngs = feat.geometry.coordinates.map(c => [c[1], c[0]]);
      const poly = L.polyline(latlngs, {
        color: colorForIndex(idx),
        weight: idx === 0 ? 5 : 3,
        opacity: 0.8
      }).addTo(S.group);
      if (poly.getBounds) bounds.push(poly.getBounds());
    });

    if (bounds.length && S.map && S.map.fitBounds) {
      let combined = bounds[0].clone();
      for (let i = 1; i < bounds.length; i++) combined.extend(bounds[i]);
      S.map.fitBounds(combined, { padding: [40, 40] });
    }
  }

  // ===== Caching for report.js =====

  function makeTripKey(mode, pdKey, zoneKey, variantIndex) {
    return [mode || '', pdKey || '', zoneKey || '', variantIndex ?? ''].join('|');
  }

  function cacheTrip(trip) {
    if (!trip) return;
    const key = makeTripKey(trip.mode, trip.pdKey, trip.zoneKey, trip.variantIndex);
    trip.key = key;
    const idx = S.lastTrips.findIndex(t => t.key === key);
    if (idx >= 0) S.lastTrips[idx] = trip;
    else S.lastTrips.push(trip);
  }

  function setLastMode(mode) {
    S.lastMode = mode || null;
  }

  function getLastTrips() {
    return S.lastTrips.slice();
  }

  function getLastMode() {
    return S.lastMode || null;
  }

  global.RoutingCache = {
    getTrips: getLastTrips,
    getMode : getLastMode
  };

  // ===== Helpers to get PD / Zone targets from script.js =====

  
  // Fallback-aware PD target collector.
  // Uses the legacy PD checkbox + route-count UI (PD_REGISTRY) if no
  // PDSelection helper is present.
  function collectPDTargets() {
    // Future helper (not used in current app, but kept for flexibility)
    if (global.PDSelection && typeof global.PDSelection.getSelectedTargets === 'function') {
      try {
        const arr = global.PDSelection.getSelectedTargets() || [];
        if (Array.isArray(arr) && arr.length) return arr;
      } catch (e) {
        console.warn('PDSelection.getSelectedTargets failed, falling back to DOM-based PD collection:', e);
      }
    }

    const registry = global.PD_REGISTRY || {};
    const items    = Array.from(document.querySelectorAll('.pd-item'));
    const invalid  = [];
    const targets  = [];

    // 1) Validate all route-count fields
    for (const item of items) {
      const cbx   = item.querySelector('.pd-cbx');
      const input = item.querySelector('.pd-route-count');
      const keyEnc = cbx?.dataset.key || item.dataset.key || '';
      const key    = decodeURIComponent(keyEnc || '');
      const reg    = registry[key];
      const name   = reg?.name || key || 'Unknown PD';

      if (!input) continue;

      let raw = input.value.trim();
      // If blank, treat as 1 if the PD is checked, otherwise 0,
      // and write the inferred value back into the box so the user sees it.
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
      const msg = invalid
        .map(x => `${x.name}: "${x.value}" (must be an integer 0–3)`)
        .join('\n');
      alert('Each Planning District route-count must be an integer from 0–3.\n\nProblem values:\n' + msg);
      return [];
    }

    // 2) Build targets for each *checked* PD
    for (const item of items) {
      const cbx = item.querySelector('.pd-cbx');
      if (!cbx || !cbx.checked) continue;

      const keyEnc = cbx.dataset.key || item.dataset.key || '';
      const key    = decodeURIComponent(keyEnc || '');
      const reg    = registry[key];
      if (!reg || !reg.layer || typeof reg.layer.getBounds !== 'function') continue;

      const center = reg.layer.getBounds().getCenter();
      const name   = reg.name || key || 'PD';

      let count = 1;
      const input = item.querySelector('.pd-route-count');
      if (input) {
        const raw = input.value.trim() || '1';
        const n   = Number(raw);
        if (Number.isFinite(n) && n > 0) {
          count = Math.min(3, Math.max(1, Math.floor(n)));
        }
      }

      targets.push({
        key,
        label  : name,
        layer  : reg.layer,
        feature: reg.layer && reg.layer.feature ? reg.layer.feature : null,
        routes : count,
        destLonLat: [center.lng, center.lat]
      });
    }

    return targets;
  }

function collectZoneTargets() {
    if (!global.ZoneSelection || !global.ZoneSelection.getSelectedTargets) return [];
    return global.ZoneSelection.getSelectedTargets();
  }

  function getFeaturePoint(feature, key) {
    if (!feature || !feature.geometry) return null;
    const g = feature.geometry;
    try {
      if (g.type === 'Point') {
        return sanitizeLonLat(g.coordinates);
      }
      if (g.type === 'MultiPoint' && Array.isArray(g.coordinates) && g.coordinates.length) {
        return sanitizeLonLat(g.coordinates[0]);
      }
      if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length) {
        const ring = g.coordinates[0];
        if (!Array.isArray(ring) || !ring.length) return null;
        let sx = 0, sy = 0;
        for (const c of ring) { sx += +c[0]; sy += +c[1]; }
        const n = ring.length || 1;
        return sanitizeLonLat([sx / n, sy / n]);
      }
      if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.length) {
        const ring = g.coordinates[0] && g.coordinates[0][0];
        if (!Array.isArray(ring) || !ring.length) return null;
        let sx = 0, sy = 0;
        for (const c of ring) { sx += +c[0]; sy += +c[1]; }
        const n = ring.length || 1;
        return sanitizeLonLat([sx / n, sy / n]);
      }
    } catch (e) {
      console.warn('getFeaturePoint error for', key, e);
    }
    return null;
  }

  // ===== Robust origin handling =====

  function getOriginLonLat() {
    const o = global.ROUTING_ORIGIN;

    if (!o) {
      if (global.map && typeof global.map.getCenter === 'function') {
        const c = global.map.getCenter();
        return sanitizeLonLat([c.lng, c.lat]);
      }
      const err = new Error('Origin not set');
      err.code = 'NO_ORIGIN';
      throw err;
    }

    if (Array.isArray(o) && o.length >= 2) {
      return sanitizeLonLat([o[0], o[1]]);
    }

    if (typeof o.getLatLng === 'function') {
      const ll = o.getLatLng();
      return sanitizeLonLat([ll.lng, ll.lat]);
    }

    if (isFiniteNum(num(o.lng)) && isFiniteNum(num(o.lat))) {
      return sanitizeLonLat([o.lng, o.lat]);
    }

    if (o.lonLat && Array.isArray(o.lonLat) && o.lonLat.length >= 2) {
      return sanitizeLonLat(o.lonLat);
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

    const x = o.lon ?? o.x;
    const y = o.lat ?? o.y;
    if (isFiniteNum(num(x)) && isFiniteNum(num(y))) {
      return sanitizeLonLat([x, y]);
    }

    if (typeof o === 'string' && o.includes(',')) {
      const [a, b] = o.split(',').map(s => s.trim());
      try {
        return sanitizeLonLat([a, b]);
      } catch {
        return sanitizeLonLat([b, a]);
      }
    }

    const err = new Error('Origin shape unsupported');
    err.code = 'NO_ORIGIN';
    throw err;
  }

  // ===== UI helpers =====

  function setButtonBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      btn.disabled = true;
      if (!btn.dataset.originalLabel) {
        btn.dataset.originalLabel = btn.textContent;
      }
      btn.textContent = btn.dataset.originalLabel + '…';
    } else {
      btn.disabled = false;
      if (btn.dataset.originalLabel) {
        btn.textContent = btn.dataset.originalLabel;
      }
    }
  }

  // ===== PD routing =====

  async function generateForPDs(reverse) {
    let originLonLat;
    try {
      originLonLat = getOriginLonLat();
    } catch (e) {
      alert('Please search/select an origin address first.');
      return;
    }

    const pdTargets = collectPDTargets();
    if (!pdTargets || !pdTargets.length) {
      alert('Please select at least one Planning District.');
      return;
    }

    const jobs = [];
    for (const target of pdTargets) {
      const point = getFeaturePoint(target.feature, target.key);
      if (!point) continue;
      const count = clamp(num(target.routes), 0, 3) || 1;
      jobs.push({
        mode   : 'PD',
        pdKey  : target.key,
        zoneKey: null,
        destLonLat: point,
        count,
        layer: target.layer
      });
    }
    if (!jobs.length) {
      alert('No valid PD targets to route to.');
      return;
    }

    clearLayerGroup();
    setLastMode('PD');
    S.lastTrips = [];

    const reverseFlag = !!reverse;
    const pdBtn  = byId('rt-gen-pd');
    const pzBtn  = byId('rt-gen-pz');
    setButtonBusy(pdBtn, true);
    setButtonBusy(pzBtn, true);

    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const label = `PD ${job.pdKey} (${i + 1}/${jobs.length})`;

        const json = await withRateLimit(() => getRoutes(
          originLonLat,
          job.destLonLat,
          job.count,
          { reverse: reverseFlag, layer: job.layer, pdSide: reverseFlag ? 'origin' : 'dest' }
        ), label);

        if (!json || !Array.isArray(json.features) || !json.features.length) continue;

        const feats = json.features.slice(0, job.count);
        feats.sort((a, b) => {
          const da = a?.properties?.summary?.duration ?? Infinity;
          const db = b?.properties?.summary?.duration ?? Infinity;
          if (da !== db) return da - db;
          const la = a?.properties?.summary?.distance ?? Infinity;
          const lb = b?.properties?.summary?.distance ?? Infinity;
          return la - lb;
        });

        feats.forEach((feat, variantIndex) => {
          const trip = {
            mode: 'PD',
            pdKey: job.pdKey,
            zoneKey: null,
            variantIndex,
            geojson: {
              type: 'FeatureCollection',
              features: [feat]
            },
            originLonLat: originLonLat,
            destLonLat  : job.destLonLat
          };
          cacheTrip(trip);
        });
      }

      drawTripLines(getLastTrips());
    } catch (e) {
      console.error('PD routing failed:', e);
      alert('Routing failed. Check console for details.');
    } finally {
      setButtonBusy(pdBtn, false);
      setButtonBusy(pzBtn, false);
    }
  }

  // ===== Zone routing =====

  async function generateForPZs(reverse) {
    let originLonLat;
    try {
      originLonLat = getOriginLonLat();
    } catch (e) {
      alert('Please search/select an origin address first.');
      return;
    }

    const pdTargets   = collectPDTargets();
    const zoneTargets = collectZoneTargets();

    if ((!pdTargets || !pdTargets.length) && (!zoneTargets || !zoneTargets.length)) {
      alert('Select a Planning District (for all zones) or a specific zone.');
      return;
    }

    const jobs = [];

    if (pdTargets && pdTargets.length === 1 && (!zoneTargets || !zoneTargets.length)) {
      const pd = pdTargets[0];
      if (!pd || !pd.key) {
        alert('Invalid Planning District selection.');
        return;
      }
      if (!global.ZoneSelection || !global.ZoneSelection.getZonesForPD) {
        alert('Zone selection helper not available.');
        return;
      }
      const zonesInPD = global.ZoneSelection.getZonesForPD(pd.key);
      if (!zonesInPD || !zonesInPD.length) {
        alert('No zones found inside that Planning District.');
        return;
      }
      zonesInPD.forEach(z => {
        const pt = getFeaturePoint(z.feature, z.key);
        if (!pt) return;
        jobs.push({
          mode: 'PZ',
          pdKey: pd.key,
          zoneKey: z.key,
          destLonLat: pt,
          count: 1,
          layer: z.layer
        });
      });
    } else if (zoneTargets && zoneTargets.length) {
      zoneTargets.forEach(z => {
        const pt = getFeaturePoint(z.feature, z.key);
        if (!pt) return;
        jobs.push({
          mode: 'PZ',
          pdKey: null,
          zoneKey: z.key,
          destLonLat: pt,
          count: 1,
          layer: z.layer
        });
      });
    } else {
      alert('To generate Zone Trips, either select exactly 1 PD or at least 1 specific zone.');
      return;
    }

    if (!jobs.length) {
      alert('No valid zone targets to route to.');
      return;
    }

    clearLayerGroup();
    setLastMode('PZ');
    S.lastTrips = [];

    const reverseFlag = !!reverse;
    const pdBtn  = byId('rt-gen-pd');
    const pzBtn  = byId('rt-gen-pz');
    setButtonBusy(pdBtn, true);
    setButtonBusy(pzBtn, true);

    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const label = `Zone ${job.zoneKey || '?'} (${i + 1}/${jobs.length})`;

        const json = await withRateLimit(() => getRoutes(
          originLonLat,
          job.destLonLat,
          1,
          { reverse: reverseFlag, layer: job.layer, pdSide: reverseFlag ? 'origin' : 'dest' }
        ), label);

        if (!json || !Array.isArray(json.features) || !json.features.length) continue;

        const feat = json.features[0];
        const trip = {
          mode: 'PZ',
          pdKey: job.pdKey,
          zoneKey: job.zoneKey,
          variantIndex: 0,
          geojson: {
            type: 'FeatureCollection',
            features: [feat]
          },
          originLonLat: originLonLat,
          destLonLat  : job.destLonLat
        };
        cacheTrip(trip);
      }

      drawTripLines(getLastTrips());
    } catch (e) {
      console.error('Zone routing failed:', e);
      alert('Routing failed. Check console for details.');
    } finally {
      setButtonBusy(pdBtn, false);
      setButtonBusy(pzBtn, false);
    }
  }

  // ===== Wiring =====

  function wireControls() {
    const pdBtn     = byId('rt-gen-pd');
    const pzBtn     = byId('rt-gen-pz');
    const clrBtn    = byId('rt-clear');
    const reverseEl = byId('rt-reverse');

    if (pdBtn) {
      pdBtn.addEventListener('click', function () {
        const reverse = !!(reverseEl && reverseEl.checked);
        generateForPDs(reverse);
      });
    }
    if (pzBtn) {
      pzBtn.addEventListener('click', function () {
        const reverse = !!(reverseEl && reverseEl.checked);
        generateForPZs(reverse);
      });
    }
    if (clrBtn) {
      clrBtn.addEventListener('click', function () {
        clearLayerGroup();
        S.lastTrips = [];
        setLastMode(null);
      });
    }

    const keyInput = byId('rt-keys');
    const saveBtn  = byId('rt-save');
    const urlBtn   = byId('rt-url');

    if (keyInput && saveBtn) {
      keyInput.value = (S.keys || []).join('\n');
      saveBtn.addEventListener('click', function () {
        const lines = keyInput.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (!lines.length) {
          alert('Please enter at least one ORS key.');
          return;
        }
        S.keys = lines;
        saveKeysToStorage(lines);
        S.keyIndex = 0;
        saveActiveKeyIndex(0);
        alert('Keys saved.');
      });
    }

    if (urlBtn) {
      urlBtn.addEventListener('click', function () {
        const val = (qParam('orsKey') || '').trim();
        if (!val) {
          alert('No ?orsKey parameter found in the URL.');
          return;
        }
        alert('The ?orsKey parameter is already merged into the active key list on load.');
      });
    }
  }

  // ===== Leaflet controls =====

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
          <div class="routing-keys">
            <label>OpenRouteService API keys (one per line):</label>
            <textarea id="rt-keys" rows="3"></textarea>
            <div class="routing-key-buttons">
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

  const AvoidControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const el = L.DomUtil.create('div', 'routing-control');
      el.innerHTML = `
        <div class="routing-header"><strong>Avoid Routes</strong></div>
        <div class="routing-row" style="margin-bottom:6px;">
          <textarea id="rt-avoid-text" rows="2" style="width:100%;resize:vertical;"
            placeholder="Queen Street West (Toronto);"></textarea>
        </div>
        <div class="routing-row">
          <label style="font-size:0.9em;display:flex;align-items:flex-start;gap:6px;cursor:pointer;">
            <input type="checkbox" id="rt-avoid-407">
            <span>Avoid Highway 407 (Burlington → Brock Rd, Pickering)</span>
          </label>
        </div>
      `;
      const geocoderEl = document.querySelector('.leaflet-control-geocoder');
      if (geocoderEl) el.style.width = geocoderEl.offsetWidth + 'px';
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      return el;
    }
  });

  function innerInit(map) {
    S.map = map;
    hydrateKeys();
    S.group = L.layerGroup().addTo(map);
    map.addControl(new AvoidControl());
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

  document.addEventListener('DOMContentLoaded', function () {
    if (global.map) Routing.init(global.map);
  });

})(window);
