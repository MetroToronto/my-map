// ===== Map & basemap =====
const map = L.map('map').setView([43.6532, -79.3832], 11);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

// ===== Geocoder (address search) =====
try {
  L.Control.geocoder({ collapsed: false, defaultMarkGeocode: true }).addTo(map);
} catch (e) {
  console.warn("Geocoder not loaded:", e);
}

// ===== Helper to derive PD key consistently from properties =====
function pdKeyFromProps(p) {
  // Try common field names used for PD number/id; fallback to name
  const cand =
    p?.PD_no ?? p?.pd_no ?? p?.PDID ?? p?.PD_ID ?? p?.PD ?? p?.pd ??
    p?.PD_NAME ?? p?.PD_name ?? null;
  if (cand != null) return String(cand).trim();
  return String(p?.PD_name || p?.PD_NAME || p?.name || 'PD').trim();
}

// ===== Load PD polygons + checkbox UI (top-right) =====
const PD_URL = 'data/tts_pds.json?v=' + Date.now(); // cache-buster

fetch(PD_URL)
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || PD_URL}`);
    return r.text();
  })
  .then(txt => {
    try { return JSON.parse(txt); }
    catch (e) {
      console.error('JSON parse error:', e, 'First 200 chars:', txt.slice(0,200));
      throw new Error('Invalid GeoJSON format');
    }
  })
  .then(geo => {
    const baseStyle     = { color: '#ff6600', weight: 1, fillOpacity: 0.15 };
    const selectedStyle = { color: '#d40000', weight: 3, fillOpacity: 0.25 };

    // Visible PD layers go here
    const group = L.featureGroup().addTo(map);

    // Selection state + label marker
    let selectedKey = null;
    let selectedItem = null;
    const selectedLabel = L.marker([0,0], { opacity: 0 }); // invisible anchor

    function showLabel(item) {
      const center = item.bounds.getCenter();
      if (!map.hasLayer(selectedLabel)) selectedLabel.addTo(map);
      selectedLabel
        .setLatLng(center)
        .bindTooltip(item.name, {
          permanent: true,
          direction: 'center',
          className: 'pd-label'
        })
        .openTooltip();
    }
    function hideLabel() {
      try { selectedLabel.remove(); } catch {}
    }

    // Helpers to mark/unmark the selected row in the list
    function clearListSelection() {
      document.querySelectorAll('.pd-item.selected').forEach(el => el.classList.remove('selected'));
    }
    function markListSelected(key) {
      clearListSelection();
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx) cbx.closest('.pd-item')?.classList.add('selected');
    }

    // Build feature index
    const pdIndex = []; // { key, name, no, layer, bounds }
    L.geoJSON(geo, {
      style: baseStyle,
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const name = (p.PD_name || p.PD_no || "Planning District").toString();
        const key  = pdKeyFromProps(p);

        // NO popup (we use only the bold tooltip label)
        pdIndex.push({ key, name, no: (p.PD_no ?? null), layer, bounds: layer.getBounds() });

        // Click on map polygon -> toggle select/highlight
        layer.on('click', () => {
          const item = pdIndex.find(i => i.layer === layer);
          if (!item) return;
          if (selectedKey === item.key) {
            clearSelection();
          } else {
            selectItem(item, { zoom: true });
          }
        });
      }
    });

    // Sort by PD number then name
    pdIndex.sort((a,b) => {
      const ah = a.no !== null, bh = b.no !== null;
      if (ah && bh) return Number(a.no) - Number(b.no);
      if (ah && !bh) return -1;
      if (!ah && bh) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // Helpers for show/hide + selection
    const show  = i => { if (!map.hasLayer(i.layer)) i.layer.addTo(group); };
    const hide  = i => { if (map.hasLayer(i.layer))  group.removeLayer(i.layer); };
    const reset = () => { pdIndex.forEach(i => i.layer.setStyle(baseStyle)); };

    function clearSelection() {
      reset();
      hideLabel();
      map.closePopup();              // just in case
      clearListSelection();
      selectedKey = null;
      selectedItem = null;
      // also clear zones (if engaged)
      if (typeof window._zonesClear === 'function') window._zonesClear();
    }

    function selectItem(item, { zoom = false } = {}) {
      if (!map.hasLayer(item.layer)) item.layer.addTo(group);
      reset();
      item.layer.setStyle(selectedStyle);
      try { item.layer.bringToFront?.(); } catch {}
      showLabel(item);
      if (zoom) map.fitBounds(item.bounds, { padding: [30,30] });
      selectedKey = item.key;
      selectedItem = item;
      markListSelected(item.key);

      // show zones for this PD (if engaged)
      if (typeof window._zonesShowFor === 'function') window._zonesShowFor(item.key);
    }

    // Build the checkbox list UI
    const itemsHTML = pdIndex.map(i => `
      <div class="pd-item">
        <input type="checkbox" class="pd-cbx" id="pd-${encodeURIComponent(i.key)}"
               data-key="${encodeURIComponent(i.key)}" checked>
        <span class="pd-name" data-key="${encodeURIComponent(i.key)}">${i.name}</span>
      </div>
    `).join('');

    // ---- PD Control (top-right, under geocoder) ----
    const PDControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control collapsed'); // start collapsed
        div.innerHTML = `
          <div class="pd-header">
            <strong>Planning Districts</strong>
            <div class="pd-actions">
              <button type="button" id="pd-select-all">Select all</button>
              <button type="button" id="pd-clear-all">Clear all</button>
              <button type="button" id="pd-toggle" class="grow">Expand ▾</button>
            </div>
          </div>
          <div class="pd-list" id="pd-list">${itemsHTML}</div>
        `;
        // match geocoder width
        const geocoderEl = document.querySelector('.leaflet-control-geocoder');
        if (geocoderEl) div.style.width = geocoderEl.offsetWidth + 'px';

        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div.querySelector('#pd-list'));
        return div;
      }
    });
    map.addControl(new PDControl());

    // Elements
    const listEl = document.getElementById('pd-list');
    const btnAll = document.getElementById('pd-select-all');
    const btnClr = document.getElementById('pd-clear-all');
    const btnTgl = document.getElementById('pd-toggle');
    const controlRoot = listEl.closest('.pd-control');

    // Initially show all PDs and fit
    pdIndex.forEach(show);
    try { map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20,20] }); } catch {}

    // Checkbox toggles visibility; if hiding selected, clear selection
    listEl.addEventListener('change', e => {
      const cbx = e.target.closest('.pd-cbx');
      if (!cbx) return;
      const key = decodeURIComponent(cbx.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;

      if (cbx.checked) {
        show(item);
      } else {
        hide(item);
        if (selectedKey === key) clearSelection();
      }
    });

    // Click PD NAME in the list -> toggle selection
    listEl.addEventListener('click', e => {
      const nameEl = e.target.closest('.pd-name');
      if (!nameEl) return;
      const key = decodeURIComponent(nameEl.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;

      // ensure visible
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx && !cbx.checked) { cbx.checked = true; show(item); }

      if (selectedKey === key) {
        clearSelection();                  // toggle off if clicking the same PD
      } else {
        selectItem(item, { zoom: true });  // select new PD
      }
    });

    // Buttons
    btnAll.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = true);
      pdIndex.forEach(show);
      try {
        map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20,20] });
      } catch {}
    });

    btnClr.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = false);
      pdIndex.forEach(hide);
      clearSelection();
    });

    // Expand / Collapse (UI only) with arrows ▾ / ▴
    btnTgl.addEventListener('click', () => {
      const collapsed = controlRoot.classList.toggle('collapsed');
      btnTgl.textContent = collapsed ? 'Expand ▾' : 'Collapse ▴';
    });
  })
  .catch(err => {
    console.error('Failed to load PDs:', err);
    alert('Could not load PDs. See console for details.');
  });

// ========================
// Planning Zones (TTS zones)
// ========================

const ZONES_URL = 'data/tts_zones.json?v=' + Date.now(); // cache-buster
let zonesEngaged = false;
const zonesGroup = L.featureGroup(); // holds only the selected PD's zones
const zonesByKey = new Map();        // key -> [layer, layer, ...]

fetch(ZONES_URL)
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || ZONES_URL}`);
    return r.text();
  })
  .then(txt => {
    try { return JSON.parse(txt); }
    catch (e) {
      console.error('ZONES JSON parse error:', e, 'First 200 chars:', txt.slice(0,200));
      throw new Error('Invalid Zones GeoJSON format');
    }
  })
  .then(zGeo => {
    const zoneStyle = { color: '#2166f3', weight: 0.8, fillOpacity: 0.08 };

    // Pre-index zones by PD key; do not add to map yet
    L.geoJSON(zGeo, {
      style: zoneStyle,
      onEachFeature: (f, lyr) => {
        const k = pdKeyFromProps(f.properties || {});
        const key = String(k || '').trim();
        if (!key) return;
        if (!zonesByKey.has(key)) zonesByKey.set(key, []);
        zonesByKey.get(key).push(lyr);
      }
    });

    // --- Control UI (same style/width as PD box) ---
    const ZonesControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control');
        div.innerHTML = `
          <div class="pd-header">
            <strong>Planning Zones</strong>
            <div class="pd-actions">
              <button type="button" id="pz-engage">Engage</button>
              <button type="button" id="pz-disengage">Disengage</button>
            </div>
          </div>
        `;
        // match geocoder width
        const geocoderEl = document.querySelector('.leaflet-control-geocoder');
        if (geocoderEl) div.style.width = geocoderEl.offsetWidth + 'px';

        L.DomEvent.disableClickPropagation(div);
        return div;
      }
    });
    map.addControl(new ZonesControl());

    const btnEng = document.getElementById('pz-engage');
    const btnDis = document.getElementById('pz-disengage');

    function setMode(engaged) {
      zonesEngaged = engaged;
      btnEng.classList.toggle('active', engaged);
      btnDis.classList.toggle('active', !engaged);
      if (!engaged) _zonesClear();
    }

    // public helpers so PD selection can notify us
    window._zonesClear = function _zonesClear() {
      zonesGroup.clearLayers();
      if (map.hasLayer(zonesGroup)) map.removeLayer(zonesGroup);
    };
    window._zonesShowFor = function _zonesShowFor(pdKey) {
      if (!zonesEngaged) return;
      const arr = zonesByKey.get(String(pdKey)) || [];
      zonesGroup.clearLayers();
      arr.forEach(lyr => lyr.addTo(zonesGroup));
      if (!map.hasLayer(zonesGroup) && arr.length) zonesGroup.addTo(map);
    };

    // Buttons behavior
    btnEng.addEventListener('click', () => {
      setMode(true);
      // If a PD is already selected, ask PD block (via global) to show its zones
      // We can't read selected PD directly here, but PD code will call _zonesShowFor on selection.
    });
    btnDis.addEventListener('click', () => setMode(false));

    // Default mode
    setMode(false); // start "Disengage"
  })
  .catch(err => {
    console.error('Failed to load Planning Zones:', err);
  });
