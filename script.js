// ===================== Map boot =====================
const map = L.map('map').setView([43.6532, -79.3832], 11);
window.map = map; // expose for routing.js / report.js

// Move the default zoom control to the TOP RIGHT
map.zoomControl.setPosition('topright');

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

// ===================== Geocoder (search bar) =====================
// Force the geocoder into the TOP LEFT, so it can sit above the PD/Zone/Trip cards
try {
  const geocoderCtl = L.Control.geocoder({
    position: 'topleft',
    collapsed: false,
    defaultMarkGeocode: true
  }).addTo(map);

  // Remember last picked address for routing.js to use as origin
  geocoderCtl.on('markgeocode', (e) => {
    const c = e.geocode.center;
    const labelFrom = () => {
      if (e.geocode && e.geocode.name) return e.geocode.name;
      if (e.geocode && e.geocode.html) return e.geocode.html;
      return `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    };

    window.ROUTING_ORIGIN = {
      lat: c.lat,
      lon: c.lng,
      latlng: c,
      label: labelFrom(),
      geocode: e.geocode
    };
  });
} catch (err) {
  console.warn('Geocoder not loaded:', err);
}

// ===================== Helpers =====================
function pdKeyFromProps(p) {
  const cand =
    p?.PD_no ?? p?.pd_no ?? p?.PDID ?? p?.PD_ID ?? p?.PD ?? p?.pd ??
    p?.PD_NAME ?? p?.PD_name ?? null;
  if (cand != null) return String(cand).trim();
  return String(p?.PD_name || p?.PD_NAME || p?.name || 'PD').trim();
}

function zoneKeyFromProps(p) {
  const cand =
    p?.TTS2022 ?? p?.ZONE ?? p?.ZONE_ID ?? p?.ZN_ID ?? p?.TTS_ZONE ??
    p?.Zone ?? p?.Z_no ?? p?.Z_ID ?? p?.ZONE_NO ?? p?.ZONE_NUM ?? null;
  return String(cand ?? 'Zone').trim();
}

// Give PD section a way to call Zones section, and vice-versa
window._pdSelectByKey    = undefined; // (key, {zoom}) -> void
window._pdClearSelection = undefined;
window._zonesShowFor     = undefined; // (pdKey, focusZoneId?) -> void
window._zonesClear       = undefined; // () -> void

// =====================================================================
// ===================== Planning Districts ============================
// =====================================================================
const PD_URL = 'data/tts_pds.json?v=' + Date.now();

fetch(PD_URL)
  .then(r => r.json())
  .then(geo => {
    // --- Styles ---
    // Base: always visible, light orange (NOT the same thing as "selected")
    const baseStyle     = { color: '#ff8c1a', weight: 2, fillColor: '#ffd1a6', fillOpacity: 0.18 };
    // Selected: red
    const selectedStyle = { color: '#d40000', weight: 4, fillColor: '#ff6666', fillOpacity: 0.22 };

    // Show PD names only when zoomed in (to avoid clutter)
    const PD_LABEL_SHOW_ZOOM = 10;

    const group = L.featureGroup().addTo(map);

    // State: which PDs are selected (checkbox-checked and red on the map)
    const selectedKeys = new Set();

    const pdIndex = [];

    function applyPDStyles() {
      pdIndex.forEach(i => {
        try {
          i.layer.setStyle(selectedKeys.has(i.key) ? selectedStyle : baseStyle);
        } catch {}
      });
    }

    function syncPDListSelection() {
      document.querySelectorAll('.pd-cbx').forEach(cbx => {
        const key = decodeURIComponent(cbx.dataset.key || '');
        const isSel = selectedKeys.has(key);
        cbx.checked = isSel;

        const row = cbx.closest('.pd-item');
        if (row) row.classList.toggle('selected', isSel);
      });
    }

    function setSingleSelection(item, { zoom = true } = {}) {
      if (!item) return;
      selectedKeys.clear();
      selectedKeys.add(item.key);
      applyPDStyles();
      syncPDListSelection();
      if (zoom) {
        try { map.fitBounds(item.bounds, { padding: [20, 20] }); } catch {}
      }
    }

    function toggleSelection(item, { zoom = false } = {}) {
      if (!item) return;
      if (selectedKeys.has(item.key)) selectedKeys.delete(item.key);
      else selectedKeys.add(item.key);
      applyPDStyles();
      syncPDListSelection();
      if (zoom) {
        try { map.fitBounds(item.bounds, { padding: [20, 20] }); } catch {}
      }
    }

    function clearPDSelection() {
      selectedKeys.clear();
      applyPDStyles();
      syncPDListSelection();
      map.closePopup();
    }

    function selectAllPDs() {
      selectedKeys.clear();
      pdIndex.forEach(i => selectedKeys.add(i.key));
      applyPDStyles();
      syncPDListSelection();
    }

    // PD labels
    function updatePDNameLabels() {
      const z = map.getZoom();
      const show = z >= PD_LABEL_SHOW_ZOOM;
      pdIndex.forEach(i => {
        if (!i || !i.layer || !i.bounds) return;
        try {
          if (show) i.layer.openTooltip(i.bounds.getCenter());
          else i.layer.closeTooltip();
        } catch {}
      });
    }

    // Build index + map layer
    L.geoJSON(geo, {
      style: baseStyle,
      onEachFeature: (f, layer) => {
        const p = f?.properties || {};
        const key  = pdKeyFromProps(p);
        const name = pdNameFromProps(p);
        const no   = (p?.PD_NO ?? p?.PDNo ?? p?.PD ?? p?.NUMBER ?? null);

        layer.addTo(group);

        const item = {
          key,
          name,
          no : (no != null ? String(no) : null),
          layer,
          bounds: layer.getBounds()
        };
        pdIndex.push(item);

        // Bind label tooltip (we open/close it based on zoom level)
        try {
          layer.bindTooltip(item.name, {
            permanent : true,
            direction : 'center',
            className : 'pd-name-label',
            interactive: false
          });
          layer.closeTooltip();
        } catch {}

        // Click on polygon → select
        layer.on('click', (ev) => {
          const oe = ev?.originalEvent;
          const multi = !!(oe && (oe.ctrlKey || oe.metaKey));
          if (multi) toggleSelection(item, { zoom: false });
          else setSingleSelection(item, { zoom: true });
        });
      }
    });

    // Sort PDs: by number then by name
    pdIndex.sort((a, b) => {
      const ah = a.no !== null;
      const bh = b.no !== null;
      if (ah && bh) return Number(a.no) - Number(b.no);
      if (ah && !bh) return -1;
      if (!ah && bh) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // Expose registry for routing/report code
    window.PD_REGISTRY = {};
    pdIndex.forEach(i => {
      window.PD_REGISTRY[i.key] = { layer: i.layer, name: i.name };
    });

    // Helper: [lon, lat, label] for every checked/selected PD
    window.getSelectedPDTargets = function () {
      const boxes = Array.from(document.querySelectorAll('.pd-cbx:checked'));
      const out   = [];
      for (const box of boxes) {
        const key  = decodeURIComponent(box.dataset.key || '');
        const item = pdIndex.find(i => i.key === key);
        if (!item || !item.bounds) continue;
        const c = item.bounds.getCenter();
        out.push([c.lng, c.lat, item.name || key]);
      }
      return out;
    };

    // Give Zones panel a way to "focus" a PD
    window._pdSelectByKey = function _pdSelectByKey(key, { zoom = true } = {}) {
      const item = pdIndex.find(i => String(i.key) === String(key));
      if (item) setSingleSelection(item, { zoom });
    };
    window._pdClearSelection = function _pdClearSelection() {
      clearPDSelection();
    };

    // ---------------- PD Control UI ----------------
    const PDControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control');
        div.dataset.role = 'pd';
        div.innerHTML = `
          <div class="pd-header">
            <strong>Planning Districts</strong>
            <div class="pd-actions">
              <button type="button" id="pd-select-all">Select all</button>
              <button type="button" id="pd-clear-all">Clear all</button>
              <button type="button" id="pd-toggle" class="grow">Collapse ▴</button>
            </div>
          </div>
          <div class="pd-list" id="pd-list"></div>
        `;
        if (L.DomEvent) {
          L.DomEvent.disableClickPropagation(div);
          if (L.DomEvent.disableScrollPropagation) L.DomEvent.disableScrollPropagation(div);
        }
        return div;
      }
    });

    map.addControl(new PDControl());

    const listEl     = document.getElementById('pd-list');
    const btnAll     = document.getElementById('pd-select-all');
    const btnClr     = document.getElementById('pd-clear-all');
    const btnToggle  = document.getElementById('pd-toggle');
    const controlDiv = listEl.closest('.pd-control');

    // Build the PD list UI (checkbox + name + route-count)
    listEl.innerHTML = pdIndex.map(i => `
      <div class="pd-item" data-key="${encodeURIComponent(i.key)}">
        <input type="checkbox" class="pd-cbx" id="pd-${encodeURIComponent(i.key)}"
               data-key="${encodeURIComponent(i.key)}">
        <span class="pd-name" data-key="${encodeURIComponent(i.key)}">${i.name}</span>
        <input type="number"
               class="pd-route-count"
               min="0"
               max="3"
               value="1"
               title="Number of routes to generate for this PD (0–3)">
      </div>
    `).join('');

    // --- Mouse wheel behavior (PD panel) ---
    // Scroll inside the PD panel should NOT zoom the map.
    // Scroll inside the white list should scroll the list normally.
    // Scroll over the header/buttons should scroll the list (not zoom the map).
    if (controlDiv && typeof L !== 'undefined' && L.DomEvent) {
      if (L.DomEvent.disableScrollPropagation) {
        L.DomEvent.disableScrollPropagation(controlDiv);
        L.DomEvent.disableScrollPropagation(listEl);
      }
      // Extra safety: stop bubbling from the list itself (do not prevent default so it can scroll)
      listEl.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: true });

      controlDiv.addEventListener('wheel', (e) => {
        if (e.target && listEl.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        listEl.scrollTop += e.deltaY;
      }, { passive: false });
    }

    // Clicking the map/list selects PDs.
    // - Without Ctrl/Cmd: single-select (replaces selection)
    // - With Ctrl/Cmd: toggle (add/remove while keeping others)
    function handlePDKeyClick(key, multi, { zoom = true } = {}) {
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;
      if (multi) toggleSelection(item, { zoom: false });
      else setSingleSelection(item, { zoom });
    }

    listEl.addEventListener('click', (e) => {
      const t = e.target;

      // Don't treat clicks in the route-count box as selection clicks
      if (t && (t.classList?.contains('pd-route-count') || t.closest?.('.pd-route-count'))) return;

      const row = t.closest?.('.pd-item');
      if (!row) return;

      const key = decodeURIComponent(row.dataset.key || '');
      const multi = !!(e.ctrlKey || e.metaKey);

      // If the user clicked the checkbox, we fully control checked state.
      if (t.classList?.contains('pd-cbx')) {
        e.preventDefault();
      }

      // Ctrl/Cmd click can also REMOVE a PD from selection
      if (multi && selectedKeys.has(key)) {
        const item = pdIndex.find(i => i.key === key);
        toggleSelection(item, { zoom: false });
        return;
      }

      handlePDKeyClick(key, multi, { zoom: true });
    });

    // Buttons
    btnAll.addEventListener('click', () => {
      selectAllPDs();
      try {
        map.fitBounds(group.getBounds(), { padding: [20, 20] });
      } catch {}
    });

    btnClr.addEventListener('click', () => {
      clearPDSelection();
      // Keep base orange layer visible (do NOT remove from map)
    });

    // Expand / collapse list
    let _pdCollapsed = false;
    function _setPDCollapsed(state) {
      _pdCollapsed = !!state;
      if (_pdCollapsed) {
        listEl.style.display = 'none';
        btnToggle.textContent = 'Expand ▾';
        controlDiv.classList.add('collapsed');
      } else {
        listEl.style.display = '';
        btnToggle.textContent = 'Collapse ▴';
        controlDiv.classList.remove('collapsed');
      }
    }
    _setPDCollapsed(false);

    btnToggle.addEventListener('click', () => _setPDCollapsed(!_pdCollapsed));

    // Initial view: show the PD orange layer immediately (already added), no selection
    applyPDStyles();
    syncPDListSelection();
    updatePDNameLabels();
    map.on('zoomend', updatePDNameLabels);

    // Optional: start by framing all PDs if the user hasn't searched yet
    try { map.fitBounds(group.getBounds(), { padding: [20, 20] }); } catch {}
  })
  .catch(err => {
    console.error('Failed to load PDs:', err);
    alert('Could not load Planning Districts. See console for details.');
  });

// =====================================================================
const ZONES_URL        = 'data/tts_zones.json?v=' + Date.now();
const ZONE_LABEL_ZOOM  = 14;

let zonesEngaged       = false;
const zonesGroup       = L.featureGroup(); // polygons for current PD
const zonesLabelGroup  = L.featureGroup(); // label markers for current PD
const zonesByKey       = new Map();        // PD key -> [feature,...]
const zoneLookup       = new Map();        // zoneId -> { feature, pdKey }
let selectedZoneLayer  = null;

const zoneBaseStyle     = { color: '#2166f3', weight: 2, fillOpacity: 0.08 };
const zoneSelectedStyle = { color: '#0b3aa5', weight: 4, fillOpacity: 0.25 };

// Helper to approximate center of a zone feature without building Leaflet layers
function centerOfZoneFeature(f) {
  if (!f || !f.geometry) return null;
  const g = f.geometry;
  if (g.type === 'Point') {
    return { lng: g.coordinates[0], lat: g.coordinates[1] };
  }
  let coords = null;
  if (g.type === 'Polygon') {
    coords = g.coordinates[0];
  } else if (g.type === 'MultiPolygon') {
    coords = g.coordinates[0] && g.coordinates[0][0];
  }
  if (!coords || !coords.length) return null;
  let sx = 0, sy = 0, n = 0;
  coords.forEach(c => {
    if (c && c.length >= 2) {
      sx += c[0];
      sy += c[1];
      n++;
    }
  });
  if (!n) return null;
  return { lng: sx / n, lat: sy / n };
}

// Build zone indices
fetch(ZONES_URL)
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || ZONES_URL}`);
    return r.text();
  })
  .then(txt => {
    try {
      return JSON.parse(txt);
    } catch (e) {
      console.error('Zones JSON parse error:', e, txt.slice(0, 200));
      throw new Error('Invalid Zones GeoJSON');
    }
  })
  .then(zGeo => {
    L.geoJSON(zGeo, {
      onEachFeature: f => {
        const props = f.properties || {};
        const pdKey = pdKeyFromProps(props);
        if (!pdKey) return;

        if (!zonesByKey.has(pdKey)) zonesByKey.set(pdKey, []);
        zonesByKey.get(pdKey).push(f);

        const zId = zoneKeyFromProps(props);
        if (!zoneLookup.has(String(zId))) {
          zoneLookup.set(String(zId), { feature: f, pdKey });
        }
      }
    });

    // Expose helper for routing.js: all zone targets for a PD
    // Each item includes lon/lat/label plus a Leaflet layer so routing.js
    // can apply the same "inside polygon" fallback that PDs use.
    window.getZoneTargetsForPD = function (pdKey) {
      const feats = zonesByKey.get(String(pdKey)) || [];
      const out = [];
      for (const f of feats) {
        const c = centerOfZoneFeature(f);
        if (!c) continue;
        const label = 'Zone ' + zoneKeyFromProps(f.properties || {});
        let layer = null;
        try {
          const tmp = L.geoJSON(f);
          const layers = (tmp && typeof tmp.getLayers === 'function') ? tmp.getLayers() : [];
          layer = layers[0] || null;
        } catch (_) {
          layer = null;
        }
        out.push({ lon: c.lng, lat: c.lat, label, layer });
      }
      return out;
    };

    // Zones control (Engage / Disengage) with inline search
    const ZonesControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control');
        div.dataset.role = 'zones';        // mark for re-ordering
        div.innerHTML = `
          <div class="pd-header">
            <strong>Traffic Zones</strong>
            <div class="pd-actions">
              <button type="button" id="pz-engage">Engage</button>
              <button type="button" id="pz-disengage">Disengage</button>
              <input id="pz-inline-search" class="pz-inline-search" type="text" placeholder="Zone #">
            </div>
          </div>
        `;
        const geocoderEl = document.querySelector('.leaflet-control-geocoder');
        if (geocoderEl) div.style.width = geocoderEl.offsetWidth + 'px';
        L.DomEvent.disableClickPropagation(div);
        return div;
      }
    });
    map.addControl(new ZonesControl());

    const btnEng  = document.getElementById('pz-engage');
    const btnDis  = document.getElementById('pz-disengage');
    const inpZone = document.getElementById('pz-inline-search');

    function clearZoneSelection() {
      if (selectedZoneLayer) selectedZoneLayer.setStyle(zoneBaseStyle);
      selectedZoneLayer = null;
      try {
        map.closePopup();
      } catch {}
    }

    function selectZone(layer) {
      if (selectedZoneLayer === layer) {
        clearZoneSelection();
        return;
      }
      if (selectedZoneLayer) selectedZoneLayer.setStyle(zoneBaseStyle);
      selectedZoneLayer = layer;
      layer.setStyle(zoneSelectedStyle);
      try { layer.bringToFront?.(); } catch {}
    }

    function updateZoneLabels() {
      const show = map.getZoom() >= ZONE_LABEL_ZOOM;
      if (show) {
        if (!map.hasLayer(zonesLabelGroup)) zonesLabelGroup.addTo(map);
      } else {
        if (map.hasLayer(zonesLabelGroup)) zonesLabelGroup.remove();
      }
    }

    function setMode(engaged) {
      zonesEngaged = engaged;
      btnEng.classList.toggle('active', engaged);
      btnDis.classList.toggle('active', !engaged);

      if (!engaged) {
        // Clear zones view
        if (typeof window._zonesClear === 'function') window._zonesClear();
      } else {
        if (!map.hasLayer(zonesGroup)) zonesGroup.addTo(map);
        updateZoneLabels();
      }
    }

    // Expose clear function for PD section to call
    window._zonesClear = function _zonesClear() {
      clearZoneSelection();
      zonesGroup.clearLayers();
      zonesLabelGroup.clearLayers();
      if (map.hasLayer(zonesGroup))      zonesGroup.remove();
      if (map.hasLayer(zonesLabelGroup)) zonesLabelGroup.remove();
      try { map.closePopup(); } catch {}
    };

    // Show zones for a PD; optional focusZoneId highlights + opens popup
    window._zonesShowFor = function _zonesShowFor(pdKey, focusZoneId = null) {
      if (!zonesEngaged) return;
      const feats = zonesByKey.get(String(pdKey)) || [];

      zonesGroup.clearLayers();
      zonesLabelGroup.clearLayers();
      clearZoneSelection();

      if (!feats.length) {
        if (map.hasLayer(zonesGroup)) map.removeLayer(zonesGroup);
        if (map.hasLayer(zonesLabelGroup)) map.removeLayer(zonesLabelGroup);
        return;
      }

      let pendingOpen   = null;
      let pendingBounds = null;

      feats.forEach(f => {
        // 1) Polygon
        const poly = L.geoJSON(f, { style: zoneBaseStyle }).getLayers()[0];

        poly.on('click', () => selectZone(poly));
        poly.on('dblclick', (e) => {
          if (typeof window._pdClearSelection === 'function') window._pdClearSelection();
          clearZoneSelection();
          L.DomEvent.stop(e);
          if (e.originalEvent?.preventDefault) e.originalEvent.preventDefault();
        });

        poly.addTo(zonesGroup);

        // 2) Label marker (chip)
        const center    = poly.getBounds().getCenter();
        const zName     = zoneKeyFromProps(f.properties || {});
        const labelHtml = `<span class="zone-tag">${String(zName)}</span>`;

        let labelIcon = L.divIcon({
          className: 'zone-label',
          html     : labelHtml,
          iconSize : null
        });

        const labelMarker = L.marker(center, {
          icon       : labelIcon,
          riseOnHover: true,
          zIndexOffset: 1000
        });

        // Measure chip then center anchor
        labelMarker.once('add', () => {
          const el = labelMarker.getElement();
          if (!el) return;
          const w = el.offsetWidth  || 24;
          const h = el.offsetHeight || 16;
          const centered = L.divIcon({
            className: 'zone-label',
            html     : labelHtml,
            iconSize : [w, h],
            iconAnchor: [w / 2, h / 2]
          });
          labelMarker.setIcon(centered);
        });

        const POPUP_OFFSET_Y = -10;
        labelMarker.on('click', () => {
          const props = f.properties || {};
          if (selectedZoneLayer !== poly) selectZone(poly);
          else poly.setStyle(zoneSelectedStyle);

          const content = `
            <div>
              <strong><u>Planning Zone ${zoneKeyFromProps(props)}</u></strong><br/>
              ${(props?.Reg_name ?? props?.REG_NAME ?? '')}<br/>
              PD: ${(props?.PD_no ?? props?.pd_no ?? props?.PD ?? '')}
            </div>
          `;
          try { labelMarker.unbindPopup(); } catch {}
          labelMarker
            .bindPopup(content, {
              offset     : L.point(0, POPUP_OFFSET_Y),
              autoPan    : true,
              closeButton: true,
              keepInView : false,
              maxWidth   : 280,
              className  : 'zone-popup'
            })
            .openPopup();
        });

        labelMarker.on('dblclick', (e) => {
          if (typeof window._pdClearSelection === 'function') window._pdClearSelection();
          clearZoneSelection();
          try { labelMarker.closePopup(); } catch {}
          L.DomEvent.stop(e);
          if (e.originalEvent?.preventDefault) e.originalEvent.preventDefault();
        });

        // Preselect focused zone if requested
        if (focusZoneId && String(zName) === String(focusZoneId)) {
          pendingOpen   = () => labelMarker.fire('click');
          pendingBounds = poly.getBounds();
          selectZone(poly);
        }

        labelMarker.addTo(zonesLabelGroup);
      });

      if (zonesGroup.getLayers().length && !map.hasLayer(zonesGroup)) {
        zonesGroup.addTo(map);
      }
      updateZoneLabels();

      if (pendingOpen)   setTimeout(pendingOpen, 0);
      if (pendingBounds) {
        map.fitBounds(pendingBounds, { padding: [30, 30], maxZoom: 16 });
      }
    };

    // Expose a helper for routing.js to get the currently selected Zone
    // Returns an array of 0 or 1 objects with lon/lat/label/layer.
    window.getSelectedZoneTargets = function () {
      const out = [];
      if (selectedZoneLayer && typeof selectedZoneLayer.getBounds === 'function') {
        const center = selectedZoneLayer.getBounds().getCenter();
        const props  = (selectedZoneLayer.feature && selectedZoneLayer.feature.properties) || {};
        const zName  = zoneKeyFromProps(props || {});
        out.push({
          lon: center.lng,
          lat: center.lat,
          label: `Zone ${zName}`,
          layer: selectedZoneLayer
        });
      }
      return out;
    };

    // ---- Inline search (Enter to run) ----
    function parseZoneId(raw) {
      if (!raw) return null;
      const m = String(raw).match(/\d+/);
      return m ? m[0] : null;
    }

    function runZoneSearch() {
      const zId = parseZoneId(inpZone.value);
      if (!zId) return;

      const found = zoneLookup.get(String(zId));
      if (!found) return;

      const { pdKey } = found;

      // Select PD (zooms to PD)…
      if (typeof window._pdSelectByKey === 'function') {
        window._pdSelectByKey(pdKey, { zoom: true });
      }
      // …then draw zones with focus on zId
      if (typeof window._zonesShowFor === 'function') {
        window._zonesShowFor(pdKey, String(zId));
      }
    }

    inpZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runZoneSearch();
    });

    btnEng.addEventListener('click', () => setMode(true));
    btnDis.addEventListener('click', () => setMode(false));
    setMode(false);

    // Keep labels in sync with zoom
    map.on('zoomend', updateZoneLabels);
  })
  .catch(err => {
    console.error('Failed to load Planning Zones:', err);
  });

// =====================================================================
// Order the controls in the left stack
// Desired order (top → bottom):
//   Search bar → Planning Districts → Traffic Zones → Distribute Trips → Report
//   (Trip + Report controls are created in routing.js / report.js)
(function setupControlOrdering() {
  const MAX_TRIES = 25;
  let tries = 0;

  function tryReorder() {
    const container = document.querySelector('.leaflet-top.leaflet-left');
    if (!container) return false;

    const geocoder = container.querySelector('.leaflet-control-geocoder');
    const pdCtl    = container.querySelector('.pd-control[data-role="pd"]');
    const tzCtl    = container.querySelector('.pd-control[data-role="zones"]');
    const tripCtl  = container.querySelector('.routing-control');
    const repCtl   = container.querySelector('.report-control');

    // Wait until all controls exist
    if (!geocoder || !pdCtl || !tzCtl || !tripCtl || !repCtl) return false;

    // Append in the desired order (appendChild moves nodes)
    [geocoder, pdCtl, tzCtl, tripCtl, repCtl].forEach(el => {
      if (el && el.parentNode === container) container.appendChild(el);
    });
    return true;
  }

  const id = setInterval(() => {
    tries += 1;
    if (tryReorder() || tries >= MAX_TRIES) clearInterval(id);
  }, 300);
})();
