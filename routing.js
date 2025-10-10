/* routing.js — ORS routing with hard-coded fallback key
 * Author: Zain / GPT-5 collaboration
 *
 * Default key (inline fallback): eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=
 * ---------------------------------------------------------------------------
 * You can still override this key without editing code:
 *  1️⃣ Add ?orsKey=KEY1,KEY2 in the URL (highest priority)
 *  2️⃣ Use the in-map “API keys & options” panel → Save Keys (stored in localStorage)
 *  3️⃣ Or edit the inline constant below if you ever want a new hard-coded fallback.
 */

(function (global) {
  // ---------- Config ----------
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';

  const UI_POS = 'topright';
  const PROFILE = 'driving-car';
  const PREFERENCE = 'fastest';
  const THROTTLE_MS = 1700;

  const COLOR_MAIN = '#0b3aa5';
  const COLOR_ALT  = '#2166f3';

  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  const ORS_BASE = 'https://api.openrouteservice.org';
  const EP = { GEOCODE: '/geocode/search', DIRECTIONS: '/v2/directions' };

  const S = { map: null, group: null, keys: [], keyIndex: 0, els: {} };

  // ---------- Helpers ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const parseUrlKeys = () => {
    const q = new URLSearchParams(location.search);
    const raw = q.get('orsKey');
    return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  };

  const loadKeys = () => {
    const url = parseUrlKeys();
    if (url.length) return url;
    try {
      const ls = JSON.parse(localStorage.getItem(LS_KEYS) || '[]');
      if (Array.isArray(ls) && ls.length) return ls;
    } catch {}
    // Inline fallback key
    return [INLINE_DEFAULT_KEY];
  };

  const saveKeys = (k) => localStorage.setItem(LS_KEYS, JSON.stringify(k));
  const setIndex = (i) => {
    S.keyIndex = Math.max(0, Math.min(i, S.keys.length - 1));
    localStorage.setItem(LS_ACTIVE_INDEX, String(S.keyIndex));
  };
  const getIndex = () => Number(localStorage.getItem(LS_ACTIVE_INDEX) || 0);
  const currentKey = () => S.keys[S.keyIndex];
  const rotateKey = () => (S.keys.length > 1 ? (setIndex((S.keyIndex + 1) % S.keys.length), true) : false);

  const ensureGroup = () => { if (!S.group) S.group = L.layerGroup().addTo(S.map); };
  const clearAll = () => S.group && S.group.clearLayers();
  const popup = (msg, ll) => {
    ll = ll || (S.map ? S.map.getCenter() : null);
    if (ll) L.popup().setLatLng(ll).setContent(msg).openOn(S.map); else alert(msg.replace(/<[^>]+>/g, ''));
  };

  // ---------- API ----------
  async function orsFetch(path, { method = 'GET', params = {}, body } = {}) {
    const url = new URL(ORS_BASE + path);
    if (method === 'GET') for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);

    const res = await fetch(url, {
      method,
      headers: { Authorization: currentKey(), ...(method !== 'GET' && { 'Content-Type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });

    if ([401,403,429].includes(res.status)) { if (rotateKey()) return orsFetch(path, { method, params, body }); }
    if (!res.ok) throw new Error(`ORS ${res.status}: ${await res.text()}`);
    return res.json();
  }

  const geocode = async (addr) => {
    const d = await orsFetch(EP.GEOCODE, { params: { text: addr, size: 1, boundary_country: 'CA' } });
    const f = d?.features?.[0];
    if (!f) throw new Error('Address not found.');
    const [lon, lat] = f.geometry.coordinates;
    return { lon, lat, label: f.properties?.label || addr };
  };

  const route = (o, d) =>
    orsFetch(`${EP.DIRECTIONS}/${PROFILE}/geojson`, { method: 'POST', body: { coordinates: [o, d], preference: PREFERENCE } });

  // ---------- Drawing ----------
  const draw = (gj, c) => (ensureGroup(), S.group.addLayer(L.geoJSON(gj, { style:{ color:c, weight:5, opacity:.9 } })));
  const mark = (lat, lon, html, r=6) => (ensureGroup(), S.group.addLayer(L.circleMarker([lat,lon],{radius:r}).bindPopup(html)));

  // ---------- UI ----------
  const Control = L.Control.extend({
    options: { position: UI_POS },
    onAdd() {
      const el = L.DomUtil.create('div','routing-control');
      el.innerHTML = `
        <div class="routing-header">
          <strong>Trip Generator</strong>
          <div class="routing-actions">
            <button id="rt-gen">Generate Trips</button>
            <button id="rt-clr" class="ghost">Clear</button>
          </div>
        </div>
        <div class="routing-section">
          <label for="rt-origin" style="font-weight:600">Start address</label>
          <input id="rt-origin" type="text" placeholder="e.g., 100 Queen St W, Toronto">
          <small class="routing-hint">Also works with ?origin=… and ?orsKey=…</small>
        </div>
        <div class="routing-section">
          <details>
            <summary style="cursor:pointer">API keys & options</summary>
            <div class="key-row" style="margin-top:8px;">
              <label for="rt-keys" style="font-weight:600;">OpenRouteService key(s)</label>
              <input id="rt-keys" type="text" placeholder="KEY1,KEY2 (comma-separated)">
              <div class="routing-row">
                <button id="rt-save">Save Keys</button>
                <button id="rt-url" class="ghost">Use ?orsKey</button>
              </div>
              <small class="routing-hint">Priority: ?orsKey → saved → inline fallback. Keys rotate on 401/429.</small>
            </div>
          </details>
        </div>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  function init(map) {
    S.map = map;
    S.keys = loadKeys();
    setIndex(getIndex());
    map.addControl(new Control());
    S.els = {
      gen: document.getElementById('rt-gen'),
      clr: document.getElementById('rt-clr'),
      origin: document.getElementById('rt-origin'),
      keys: document.getElementById('rt-keys'),
      save: document.getElementById('rt-save'),
      url: document.getElementById('rt-url')
    };
    if (S.els.keys) S.els.keys.value = S.keys.join(',');
    const qs = new URLSearchParams(location.search);
    if (qs.get('origin')) S.els.origin.value = qs.get('origin');
    S.els.gen.onclick = generate;
    S.els.clr.onclick = () => clearAll();
    S.els.save.onclick = saveKeysUI;
    S.els.url.onclick = useUrl;
  }

  const saveKeysUI = () => {
    const arr = (S.els.keys.value||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (!arr.length) return popup('<b>Routing</b><br>Enter a key.');
    S.keys=arr; saveKeys(arr); setIndex(0);
    popup('<b>Routing</b><br>Keys saved.');
  };
  const useUrl = () => {
    const k=parseUrlKeys(); if(!k.length)return popup('<b>Routing</b><br>No ?orsKey= found.');
    S.keys=k; setIndex(0); popup('<b>Routing</b><br>Using keys from URL.');
  };

  async function generate() {
    try {
      const addr = (S.els.origin.value||'').trim();
      if (!addr) return popup('<b>Routing</b><br>Enter a start address.');
      const g = await geocode(addr);
      mark(g.lat,g.lon,`<b>Origin</b><br>${g.label}`,6);

      let t = typeof global.getSelectedPDTargets==='function'?global.getSelectedPDTargets():[];
      if (!t.length) return popup('<b>Routing</b><br>No PDs selected.');
      try { S.map.fitBounds(L.latLngBounds([[g.lat,g.lon],[t[0][1],t[0][0]]]),{padding:[24,24]}); } catch{}

      for(let i=0;i<t.length;i++){
        const [lon,lat,name]=t[i];
        try{
          const gj=await route([g.lon,g.lat],[lon,lat]);
          draw(gj,i?COLOR_ALT:COLOR_MAIN);
          const s=gj?.features?.[0]?.properties?.summary;
          const km=s?(s.distance/1000).toFixed(1):'—';
          const min=s?Math.round(s.duration/60):'—';
          mark(lat,lon,`<b>${name}</b><br>${km} km • ${min} min`,5);
        }catch(e){console.error(e);popup(`<b>Routing</b><br>${name||'Dest'} failed<br>${e.message}`);}
        if(i<t.length-1)await sleep(THROTTLE_MS);
      }
    }catch(e){console.error(e);popup(`<b>Routing</b><br>${e.message}`);}
  }

  global.Routing={init,clear:clearAll,setApiKeys:(a)=>{S.keys=a;saveKeys(a);setIndex(0);}};
  document.addEventListener('DOMContentLoaded',()=>{if(global.map)Routing.init(global.map);});
})(window);

