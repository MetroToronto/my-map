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

  // ===== "Avoid routes" helpers =====
  // The user can type one or more street patterns into the Avoid Routes box.
  // We treat each semicolon-separated entry as a rule. For now we prefer
  // alternatives that *do not* use those streets if ORS provides them; if
  // every route uses the street, we still keep the fastest one.
  function parseAvoidRules(raw) {
    const out = [];
    if (!raw) return out;
    const entries = String(raw).split(';');
    for (let entry of entries) {
      entry = String(entry || '').trim();
      if (!entry) continue;

      // If the user used the verbose "From/To" format, keep only the street
      // name part before the first ", From:" segment.
      const lower = entry.toLowerCase();
      const fromIdx = lower.indexOf('from:');
      if (fromIdx > 0) {
        entry = entry.slice(0, fromIdx).trim().replace(/,+$/, '');
      }

      // Basic pattern: "Queen Street West (Toronto)" or just "Queen Street West"
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
      // Treat Highway 407 as a street rule. ORS step names usually
      // contain "407" / "HIGHWAY 407" for this facility.
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

  // Re-order ORS alternative routes so that ones using "avoided" streets
  // are ranked last. We do *not* discard any routes; existing logic that
  // sorts by duration/distance still runs on the re-ordered list.
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
      return a.idx - b.idx; // keep original ORS ordering as tie-breaker
    });

    const sorted = ranked.map(r => r.feat);
    json.features = sorted;
    return json;
  }

  function sanitizeLonLat(input) {
    let arr = Array.isArray(input) ? input : [undefined, undefined];
    let x = num(arr[0]), y = num(arr[1]);
    // If x/y look like they might be [lat, lon], swap them
    if (isFiniteNum(x) && isFiniteNum(y) && Math.abs(x) <= 90 && Math.abs(y) <= 180) {
      if (Math.abs(x) > 90 || Math.abs(y) > 180) {
        const tmp = x;
        x = y;
        y = tmp;
      }
    }
    if (!isFiniteNum(x) || !isFiniteNum(y)) {
      throw new Error('Invalid lon/lat: ' + JSON.stringify(input));
    }
    return [clamp(x, -180, 180), clamp(y, -90, 90)];
  }

  function heedRateLimit() {
    const now = Date.now();
    if (!S.minuteStartMs || now - S.minuteStartMs >= 60_000) {
      S.minuteStartMs = now;
      S.minuteCount   = 0;
      return 0;
    }
    if (S.minuteCount < MAX_PER_MINUTE) {
      return 0;
    }
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
        </div>
      `;
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
      console.warn(`[${label}] initial wait due to rate limit: ${initialWait}ms`);
      const hide = showWaitOverlay(Math.ceil(initialWait / 1000));
      await sleep(initialWait);
      hide();
    }

    try {
      noteRequest();
      return await fn();
    } catch (e) {
      const wait40 = heedRateLimit();
      if (wait40 > 0) {
        console.warn(`[${label}] secondary wait due to rate limit: ${wait40}ms`);
        const hide = showWaitOverlay(Math.ceil(wait40 / 1000));
        await sleep(wait40);
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
    } catch (e) {
      console.warn('Failed to read ORS keys from localStorage:', e);
      return [];
    }
  }

  function saveKeysToStorage(keys) {
    try {
      localStorage.setItem(LS_KEYS, JSON.stringify(keys || []));
    } catch (e) {
      console.warn('Failed to save ORS keys to localStorage:', e);
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
    const fromLS   = loadKeysFromStorage();
    const fromUrl  = (qParam('orsKey') || '').trim();
    const inline   = INLINE_DEFAULT_KEY;

    const merged = [];
    for (const k of fromLS) if (k && !merged.includes(k)) merged.push(k);
    if (fromUrl && !merged.includes(fromUrl)) merged.push(fromUrl);
    if (inline  && !merged.includes(inline))  merged.push(inline);

    if (!merged.length) {
      merged.push(inline);
    }

    S.keys     = merged;
    S.keyIndex = loadActiveKeyIndex();
    if (S.keyIndex < 0 || S.keyIndex >= S.keys.length) {
      S.keyIndex = 0;
    }
  }

  function getActiveKey() {
    if (!S.keys || !S.keys.length) {
      hydrateKeys();
    }
    const idx = S.keyIndex || 0;
    return S.keys[idx] || '';
  }

  function rotateKeyOnError() {
    if (!S.keys || S.keys.length <= 1) return;
    S.keyIndex = (S.keyIndex + 1) % S.keys.length;
    saveActiveKeyIndex(S.keyIndex);
  }

  // ===== ORS fetch wrapper =====

  async function orsFetch(path, options) {
    const key = getActiveKey();
    if (!key) {
      throw new Error('No ORS key available');
    }
    const url = `${ORS_BASE}${path}?api_key=${encodeURIComponent(key)}`;

    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Accept'      : 'application/json'
      }
    });

    if (res.status === 401 || res.status === 403) {
      console.warn('ORS 401/403 – rotating key and retrying once');
      rotateKeyOnError();
      const key2 = getActiveKey();
      if (!key2) throw new Error('No ORS key available after rotate');
      const url2 = `${ORS_BASE}${path}?api_key=${encodeURIComponent(key2)}`;
      const res2 = await fetch(url2, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Accept'      : 'application/json'
        }
      });
      if (!res2.ok) {
        const text = await res2.text();
        throw new Error(`ORS error after rotate: ${res2.status} ${text}`);
      }
      return res2.json();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ORS error: ${res.status} ${text}`);
    }
    return res.json();
  }

  // ===== Core routing helpers =====

  function lastCoordFromGeojson(geojson) {
    try {
      const coords = geojson &&
        geojson.features &&
        geojson.features[0] &&
        geojson.features[0].geometry &&
        geojson.features[0].geometry.coordinates;
      if (!Array.isArray(coords) || !coords.length) return null;
      const last = coords[coords.length - 1];
      return Array.isArray(last) ? last.slice(0, 2) : null;
    } catch {
      return null;
    }
  }

  function getFeaturePoint(feature, key) {
    if (!feature || !feature.geometry) return null;
    const g = feature.geometry;
    if (g.type === 'Point') {
      return sanitizeLonLat(g.coordinates);
    }
    if (g.type === 'MultiPoint' && Array.isArray(g.coordinates) && g.coordinates.length) {
      return sanitizeLonLat(g.coordinates[0]);
    }
    if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length) {
      const ring = g.coordinates[0];
      if (!Array.isArray(ring) || !ring.length) return null;
      let sumX = 0, sumY = 0;
      for (const c of ring) {
        if (!Array.isArray(c) || c.length < 2) continue;
        sumX += +c[0];
        sumY += +c[1];
      }
      const n = ring.length || 1;
      return sanitizeLonLat([sumX / n, sumY / n]);
    }
    if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.length) {
      const ring = g.coordinates[0] && g.coordinates[0][0];
      if (!Array.isArray(ring) || !ring.length) return null;
      let sumX = 0, sumY = 0;
      for (const c of ring) {
        if (!Array.isArray(c) || c.length < 2) continue;
        sumX += +c[0];
        sumY += +c[1];
      }
      const n = ring.length || 1;
      return sanitizeLonLat([sumX / n, sumY / n]);
    }
    console.warn('Unsupported feature geometry for', key, feature);
    return null;
  }

  function pointInLayer(lonLat, layer) {
    if (!layer || !layer.getLayers) return false;
    const pt = L.latLng(lonLat[1], lonLat[0]);
    let inside = false;
    layer.eachLayer(function (sub) {
      if (inside) return;
      if (sub.getBounds && sub.getBounds().contains(pt)) {
        if (sub instanceof L.Polygon || sub instanceof L.Polyline) {
          inside = leafletPointInPolygon(pt, sub);
        } else {
          inside = true;
        }
      }
    });
    return inside;
  }

  function leafletPointInPolygon(latLng, poly) {
    const x = latLng.lng;
    const y = latLng.lat;
    const latlngs = poly.getLatLngs();
    const flat = [];
    (function flatten(lls) {
      for (const ll of lls) {
        if (Array.isArray(ll)) flatten(ll);
        else flat.push(ll);
      }
    })(latlngs);
    let inside = false;
    for (let i = 0, j = flat.length - 1; i < flat.length; j = i++) {
      const xi = flat[i].lng, yi = flat[i].lat;
      const xj = flat[j].lng, yj = flat[j].lat;
      const intersect =
        ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function endsInsideLayer(geojson, layer, pdSide) {
    if (!layer) return true;
    try {
      const line = geojson &&
        geojson.features &&
        geojson.features[0] &&
        geojson.features[0].geometry;
      if (!line || !Array.isArray(line.coordinates) || !line.coordinates.length) {
        return false;
      }
      const coords = line.coordinates;
      const idx    = (pdSide === 'origin') ? 0 : coords.length - 1;
      const c      = coords[idx];
      if (!Array.isArray(c) || c.length < 2) return false;
      const candidate = [c[0], c[1]];
      return pointInLayer(candidate, layer);
    } catch (e) {
      console.warn('endsInsideLayer error', e);
      return false;
    }
  }

  async function getRoutes(originLonLat, destLonLat, maxCount, opts = {}) {
    const reverse = !!opts.reverse;
    let o = sanitizeLonLat(originLonLat);
    let d = sanitizeLonLat(destLonLat);
    if (reverse) {
      const tmp = o;
      o = d;
      d = tmp;
    }

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

    // Read current "avoid" preferences from the UI (if present)
    const avoidPref = getAvoidPreferences();
    const hasAvoid  = !!(avoidPref && avoidPref.rules && avoidPref.rules.length);

    // We normally ask ORS for multiple alternatives only when the user
    // requests more than 1 route. If the user has specified streets to
    // avoid, we still request a couple of alternatives so we can pick the
    // one that best avoids those streets.
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
    const pdSide = (opts.pdSide === 'origin') ? 'origin' : 'dest'; // which end is the PD/zone point

    const doFetch = (body) =>
      orsFetch(`/v2/directions/${PROFILE}/geojson`, { method: 'POST', body })
        .then(json => applyAvoidPreferences(json, avoidPref));

    const makeRadiuses = (rOrigin, rDest) => {
      const arr = [];
      arr[reverse ? 1 : 0] = rOrigin;
      arr[reverse ? 0 : 1] = rDest;
      return arr;
    };

    async function tryWithRadius(radiusMeters) {
      const body = {
        ...baseBody,
        radiuses: makeRadiuses(radiusMeters, radiusMeters)
      };
      return await doFetch(JSON.stringify(body));
    }

    try {
      return await doFetch(JSON.stringify(baseBody));
    } catch (e1) {
      const msg = String(e1 && e1.message || '');

      if (msg.includes('"code":2010') || msg.includes('Could not find routable point')) {
        console.warn('ORS 2010 / not routable, trying with radiuses');

        try {
          const try1 = await tryWithRadius(1000);
          if (try1 && endsInsideLayer(try1, layer, pdSide)) {
            return try1;
          }
          const try2 = await tryWithRadius(3000);
          if (try2 && endsInsideLayer(try2, layer, pdSide)) {
            return try2;
          }
          const try3 = await tryWithRadius(5000);
          if (try3 && endsInsideLayer(try3, layer, pdSide)) {
            return try3;
          }
          const try4 = await tryWithRadius(8000);
          return try4;
        } catch (e2) {
          console.error('ORS 2010 fallback failed as well:', e2);
          throw e2;
        }
      }

      console.error('getRoutes fatal error:', e1);
      throw e1;
    }
  }

  // ===== Rendering on the map =====

  function clearLayerGroup() {
    if (S.group) {
      S.group.clearLayers();
    }
  }

  function colorForIndex(i) {
    return i === 0 ? COLOR_FIRST : COLOR_OTHERS;
  }

  function drawTripLines(trips) {
    clearLayerGroup();
    if (!trips || !trips.length || !S.group) return;

    const bounds = [];

    trips.forEach((t, idx) => {
      if (!t.geojson ||
          !t.geojson.features ||
          !t.geojson.features[0] ||
          !t.geojson.features[0].geometry) {
        return;
      }
      const line = t.geojson.features[0].geometry;
      if (!line || line.type !== 'LineString' ||
          !Array.isArray(line.coordinates)) {
        return;
      }

      const latlngs = line.coordinates.map(c => [c[1], c[0]]);
      const poly = L.polyline(latlngs, {
        color: colorForIndex(idx),
        weight: idx === 0 ? 5 : 3,
        opacity: 0.8
      }).addTo(S.group);

      if (poly.getBounds) {
        bounds.push(poly.getBounds());
      }
    });

    if (bounds.length && S.map && S.map.fitBounds) {
      let combined = bounds[0].clone();
      for (let i = 1; i < bounds.length; i++) {
        combined.extend(bounds[i]);
      }
      S.map.fitBounds(combined, { padding: [40, 40] });
    }
  }

  // ======= Caching structure =======

  function makeTripKey(mode, pdKey, zoneKey, variantIndex) {
    return [
      mode || '',
      pdKey || '',
      zoneKey || '',
      (variantIndex != null ? variantIndex : '')
    ].join('|');
  }

  function cacheTrip(trip) {
    if (!trip) return;
    const key = makeTripKey(
      trip.mode,
      trip.pdKey,
      trip.zoneKey,
      trip.variantIndex
    );
    trip.key = key;
    const idx = S.lastTrips.findIndex(t => t.key === key);
    if (idx >= 0) {
      S.lastTrips[idx] = trip;
    } else {
      S.lastTrips.push(trip);
    }
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

  // Expose cache helpers for report.js
  global.RoutingCache = {
    getTrips: getLastTrips,
    getMode : getLastMode
  };

  // ===== PD & Zone helpers (targets are provided by script.js) =====

  function collectPDTargets() {
    if (!global.PDSelection || !global.PDSelection.getSelectedTargets) {
      return [];
    }
    return global.PDSelection.getSelectedTargets();
  }

  function collectZoneTargets() {
    if (!global.ZoneSelection || !global.ZoneSelection.getSelectedTargets) {
      return [];
    }
    return global.ZoneSelection.getSelectedTargets();
  }

  // ===== UI wiring (buttons) =====

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

  async function generateForPDs(reverse) {
    const origin = global.ROUTING_ORIGIN;
    if (!origin || !Array.isArray(origin.lonLat)) {
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
      if (!point) {
        console.warn('Skipping PD with invalid geometry', target.key);
        continue;
      }

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
          origin.lonLat,
          job.destLonLat,
          job.count,
          { reverse: reverseFlag, layer: job.layer, pdSide: reverseFlag ? 'origin' : 'dest' }
        ), label);

        if (!json || !Array.isArray(json.features) || !json.features.length) {
          console.warn('No features for PD', job.pdKey, json);
          continue;
        }

        const feats = Array.isArray(json.features)
          ? json.features.slice(0, job.count)
          : [json.features[0]];

        feats.sort((a, b) => {
          const da = a && a.properties && a.properties.summary && a.properties.summary.duration || Infinity;
          const db = b && b.properties && b.properties.summary && b.properties.summary.duration || Infinity;
          if (da !== db) return da - db;
          const la = a && a.properties && a.properties.summary && a.properties.summary.distance || Infinity;
          const lb = b && b.properties && b.properties.summary && b.properties.summary.distance || Infinity;
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
            originLonLat: origin.lonLat,
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

  async function generateForPZs(reverse) {
    const origin = global.ROUTING_ORIGIN;
    if (!origin || !Array.isArray(origin.lonLat)) {
      alert('Please search/select an origin address first.');
      return;
    }

    const pdTargets = collectPDTargets();
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
          origin.lonLat,
          job.destLonLat,
          1,
          { reverse: reverseFlag, layer: job.layer, pdSide: reverseFlag ? 'origin' : 'dest' }
        ), label);

        if (!json || !Array.isArray(json.features) || !json.features.length) {
          console.warn('No features for zone', job.zoneKey, json);
          continue;
        }

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
          originLonLat: origin.lonLat,
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

  function wireControls() {
    const pdBtn  = byId('rt-gen-pd');
    const pzBtn  = byId('rt-gen-pz');
    const clrBtn = byId('rt-clear');
    const reverseChk = byId('rt-reverse');

    if (pdBtn) {
      pdBtn.addEventListener('click', function () {
        const reverse = !!(reverseChk && reverseChk.checked);
        generateForPDs(reverse);
      });
    }
    if (pzBtn) {
      pzBtn.addEventListener('click', function () {
        const reverse = !!(reverseChk && reverseChk.checked);
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
      const currentKeys = S.keys.join('\n');
      keyInput.value = currentKeys;

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
        alert('Keys saved. They will be used for future routing requests.');
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
    map.addControl(new GeneratorControl());
    map.addControl(new AvoidControl());
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
    if (global.map) {
      Routing.init(global.map);
    }
  });

})(window);
