// ===================== Map boot =====================
const map = L.map('map').setView([43.6532, -79.3832], 11);
window.map = map; // expose for routing.js / report.js

// Move the default zoom control to the TOP RIGHT
map.zoomControl.setPosition('topright');

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

// ===================== Company logo (bottom-left) =====================
try {
  const LogoControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'logo-control');
      div.innerHTML = `
        <div class="logo-inner">
          <img src="data/LEA_logo.png" alt="LEA Consulting" loading="lazy">
        </div>
      `;
      if (L.DomEvent) {
        L.DomEvent.disableClickPropagation(div);
        if (L.DomEvent.disableScrollPropagation) L.DomEvent.disableScrollPropagation(div);
      }
      return div;
    }
  });

  map.addControl(new LogoControl());

  // Auto-hide logo if it overlaps the left column controls (prevents clutter).
  const _logoEl = document.querySelector('.logo-control');
  let _logoHidden = false;

  function _rectsOverlap(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  function _inflateRect(r, pad) {
    return { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad };
  }

  function _setLogoHidden(hidden) {
    if (!_logoEl) return;
    const next = !!hidden;
    if (next === _logoHidden) return;
    _logoHidden = next;
    _logoEl.classList.toggle('is-hidden', _logoHidden);
  }

  function _updateLogoVisibility() {
    if (!_logoEl) return;
    const logoRect = _inflateRect(_logoEl.getBoundingClientRect(), 3);
    if ((logoRect.right - logoRect.left) <= 0 || (logoRect.bottom - logoRect.top) <= 0) {
      _setLogoHidden(false);
      return;
    }

    const leftStack = document.querySelectorAll('.leaflet-top.leaflet-left .leaflet-control');
    let conflict = false;
    leftStack.forEach(el => {
      if (conflict) return;
      if (!el || el === _logoEl) return;
      const r0 = el.getBoundingClientRect();
      if (r0.width === 0 || r0.height === 0) return;
      const r = _inflateRect(r0, 2);
      if (_rectsOverlap(logoRect, r)) conflict = true;
    });

    _setLogoHidden(conflict);
  }

  const _scheduleLogoCheck = (() => {
    let raf = 0;
    return () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        _updateLogoVisibility();
      });
    };
  })();

  const _ctrlContainer = document.querySelector('.leaflet-control-container');
  if (_ctrlContainer && window.MutationObserver) {
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (_logoEl && (m.target === _logoEl || (_logoEl.contains && _logoEl.contains(m.target)))) continue;
        _scheduleLogoCheck();
        break;
      }
    });
    obs.observe(_ctrlContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  window.addEventListener('resize', _scheduleLogoCheck);
  setTimeout(_scheduleLogoCheck, 150);
} catch (e) {
  console.warn('Logo control failed to load:', e);
}



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
// =====================================================================
// ===================== Planning Districts ============================
// =====================================================================
const PD_URL = 'data/tts_pds.json?v=' + Date.now();

fetch(PD_URL)
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || PD_URL}`);
    return r.text();
  })
  .then(txt => {
    try {
      return JSON.parse(txt);
    } catch (e) {
      console.error('PD JSON parse error:', e, txt.slice(0, 200));
      throw new Error('Invalid PD GeoJSON');
    }
  })
  .then(geo => {
    // ---- Styles ----
    // Base layer: ALWAYS visible (light orange)
    const baseStyle = {
      color: '#ff9f1c',
      weight: 2,
      opacity: 0.9,
      fillColor: '#ffd08a',
      fillOpacity: 0.22
    };

    // Selected layer: only for checked PDs (red)
    const selectedStyle = {
      color: '#d41414',
      weight: 3,
      opacity: 1,
      fillColor: '#ff3b30',
      fillOpacity: 0.30
    };

    const hoverStyle = {
      weight: 3,
      opacity: 1
    };

    // Layer group for PD polygons (always on)
    const pdGroup = L.layerGroup().addTo(map);

    // Label group (shown only when zoomed in)
    const PD_LABEL_ZOOM = 10;
    const pdLabelGroup = L.layerGroup();

    // Build PD index
    const pdIndex = [];

    function pdKeyFromProps(p) {
      return String(
        p?.PD_KEY ?? p?.pd_key ?? p?.PD ?? p?.pd ?? p?.id ?? p?.ID ?? p?.Name ?? p?.name ?? ''
      ).trim();
    }

    function pdNameFromProps(p) {
      return String(
        p?.PD_NAME ?? p?.pd_name ?? p?.NAME ?? p?.name ?? p?.Name ?? pdKeyFromProps(p)
      ).trim();
    }

    function pdNoFromName(name) {
      // If PD names start with a number ("1 Something"), capture it; else null.
      const m = String(name || '').trim().match(/^(\d+)\b/);
      return m ? Number(m[1]) : null;
    }

    // Selection state (checkboxes reflect this)
    let selectedKeys = new Set();

    function updatePDStyles() {
      for (const item of pdIndex) {
        const isSel = selectedKeys.has(item.key);
        item.layer.setStyle(isSel ? selectedStyle : baseStyle);
        if (isSel) {
          try { item.layer.bringToFront(); } catch {}
        }
      }
    }

    function syncPDCheckboxes() {
      for (const item of pdIndex) {
        const id = `pd-${encodeURIComponent(item.key)}`;
        const cbx = document.getElementById(id);
        if (cbx) cbx.checked = selectedKeys.has(item.key);
      }
    }

    function setSelectionSingle(key) {
      selectedKeys = new Set([key]);
      syncPDCheckboxes();
      updatePDStyles();
    }

    function toggleSelectionKey(key) {
      const next = new Set(selectedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      selectedKeys = next;
      syncPDCheckboxes();
      updatePDStyles();
    }

    function selectAllPDs() {
      selectedKeys = new Set(pdIndex.map(i => i.key));
      syncPDCheckboxes();
      updatePDStyles();
    }

    function clearAllPDs() {
      selectedKeys = new Set();
      syncPDCheckboxes();
      updatePDStyles();
    }

    function handlePDUserSelect(key, originalEvent) {
      const ctrl = !!(originalEvent && (originalEvent.ctrlKey || originalEvent.metaKey));
      if (ctrl) {
        toggleSelectionKey(key);
      } else {
        // Single-select: switch selection to this PD
        setSelectionSingle(key);
      }
    }

    // Build GeoJSON layers
    const pdGeoLayer = L.geoJSON(geo, {
      style: baseStyle,
      onEachFeature: (feature, layer) => {
        const props = feature?.properties || {};
        const key = pdKeyFromProps(props);
        const name = pdNameFromProps(props) || key;
        const no = pdNoFromName(name);

        const bounds = layer.getBounds ? layer.getBounds() : null;

        const item = { key, name, no, layer, bounds, labelMarker: null };
        pdIndex.push(item);

        layer.on('click', (e) => {
          handlePDUserSelect(key, e.originalEvent);
        });

        layer.on('mouseover', () => {
          layer.setStyle(hoverStyle);
        });
        layer.on('mouseout', () => {
          // restore based on selection
          layer.setStyle(selectedKeys.has(key) ? selectedStyle : baseStyle);
        });
      }
    });

    pdGeoLayer.addTo(pdGroup);

    // Sort PD list: by number then by name
    pdIndex.sort((a, b) => {
      const ah = a.no !== null;
      const bh = b.no !== null;
      if (ah && bh) return Number(a.no) - Number(b.no);
      if (ah && !bh) return -1;
      if (!ah && bh) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // Labels: create markers once, toggle group at zoom threshold
    function createPDLabelMarker(item) {
      if (!item?.bounds) return null;
      const center = item.bounds.getCenter();
      const html = `<div class="pd-name-label">${item.name}</div>`;
      return L.marker(center, {
        interactive: false,
        icon: L.divIcon({
          className: 'pd-name-label-wrap',
          html,
          iconSize: null
        })
      });
    }

    for (const item of pdIndex) {
      const m = createPDLabelMarker(item);
      if (m) {
        item.labelMarker = m;
        pdLabelGroup.addLayer(m);
      }
    }

    function updatePDLabelVisibility() {
      const z = map.getZoom();
      const shouldShow = z >= PD_LABEL_ZOOM;
      if (shouldShow) {
        if (!map.hasLayer(pdLabelGroup)) pdLabelGroup.addTo(map);
      } else {
        if (map.hasLayer(pdLabelGroup)) map.removeLayer(pdLabelGroup);
      }
    }
    map.on('zoomend', updatePDLabelVisibility);
    updatePDLabelVisibility();

    // ===== Build PD list UI =====
    const itemsHTML = pdIndex.map(i => `
      <div class="pd-item" data-key="${encodeURIComponent(i.key)}">
        <label class="pd-left">
          <input type="checkbox"
                 class="pd-cbx"
                 id="pd-${encodeURIComponent(i.key)}"
                 data-key="${encodeURIComponent(i.key)}">
          <span class="pd-name" data-key="${encodeURIComponent(i.key)}">${i.name}</span>
        </label>
        <input type="number"
               class="pd-route-count"
               min="0"
               max="3"
               value="1"
               title="Number of routes to generate for this PD (0–3)">
      </div>
    `).join('');

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
          <div class="pd-list" id="pd-list">${itemsHTML}</div>
        `;

        // Match the geocoder width if present
        const geocoderEl = document.querySelector('.leaflet-control-geocoder');
        if (geocoderEl) div.style.width = geocoderEl.offsetWidth + 'px';

        // Prevent click from panning map
        if (L.DomEvent) L.DomEvent.disableClickPropagation(div);

        return div;
      }
    });

    map.addControl(new PDControl());

    const listEl     = document.getElementById('pd-list');
    const btnAll     = document.getElementById('pd-select-all');
    const btnClr     = document.getElementById('pd-clear-all');
    const btnToggle  = document.getElementById('pd-toggle');
    const controlDiv = listEl ? listEl.closest('.pd-control') : null;

    // --- Wheel behavior: never zoom map while cursor is in PD panel; allow list scrolling ---
    if (controlDiv && typeof L !== 'undefined' && L.DomEvent) {
      if (L.DomEvent.disableScrollPropagation) {
        L.DomEvent.disableScrollPropagation(controlDiv);
        if (listEl) L.DomEvent.disableScrollPropagation(listEl);
      }
      if (listEl) {
        // allow native list scroll, but prevent bubbling to map
        listEl.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: true });
      }

      // When scrolling over header/buttons, scroll the list instead
      controlDiv.addEventListener('wheel', (e) => {
        if (!listEl) return;
        if (e.target && listEl.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        listEl.scrollTop += e.deltaY;
      }, { passive: false });
    }

    // Collapse / Expand (only hides the list; PD polygons stay visible)
    let _pdCollapsed = false;
    function _setPDCollapsed(state) {
      _pdCollapsed = !!state;
      if (!listEl) return;
      if (_pdCollapsed) {
        listEl.style.display = 'none';
        btnToggle.textContent = 'Expand ▾';
        if (controlDiv) controlDiv.classList.add('collapsed');
      } else {
        listEl.style.display = '';
        btnToggle.textContent = 'Collapse ▴';
        if (controlDiv) controlDiv.classList.remove('collapsed');
      }
    }
    _setPDCollapsed(false);
    btnToggle.addEventListener('click', () => _setPDCollapsed(!_pdCollapsed));

    // List interactions: click checkbox or name selects PD.
    // - No modifier: single-select
    // - Ctrl/Cmd: toggle add/remove
    if (listEl) {
      listEl.addEventListener('click', (e) => {
        const input = e.target.closest('.pd-route-count');
        if (input) return; // don't change selection when editing counts

        const cbx = e.target.closest('.pd-cbx');
        const nameEl = e.target.closest('.pd-name');
        const itemEl = e.target.closest('.pd-item');
        if (!cbx && !nameEl && !itemEl) return;

        // key from whichever element we found
        const keyEnc = (cbx && cbx.dataset.key) || (nameEl && nameEl.dataset.key) || (itemEl && itemEl.dataset.key) || '';
        const key = decodeURIComponent(keyEnc);

        // prevent native checkbox toggle; we control it
        if (cbx) e.preventDefault();

        handlePDUserSelect(key, e);
      });
    }

    // Buttons
    btnAll.addEventListener('click', () => selectAllPDs());
    btnClr.addEventListener('click', () => clearAllPDs());

    // Ensure initial styles (base layer visible, no selection)
    clearAllPDs();

    // === Routing hooks: PD registry + PD targets ===
    window.PD_REGISTRY = {};
    pdIndex.forEach(i => {
      window.PD_REGISTRY[i.key] = { layer: i.layer, name: i.name };
    });

    // Helper: [lon, lat, label] for every checked PD (routing.js reads checkboxes)
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
  })
  .catch(err => {
    console.error('Failed to load PDs:', err);
    alert('Could not load Planning Districts. See console for details.');
  });

// ===================== Traffic (Planning) Zones ======================
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
