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

/* -------------------------------------------------------
   Helpers to extract IDs from feature properties
--------------------------------------------------------*/
function pdKeyFromProps(p) {
  const cand =
    p?.PD_no ?? p?.pd_no ?? p?.PDID ?? p?.PD_ID ?? p?.PD ?? p?.pd ??
    p?.PD_NAME ?? p?.PD_name ?? null;
  if (cand != null) return String(cand).trim();
  return String(p?.PD_name || p?.PD_NAME || p?.name || 'PD').trim();
}
// Zone name/number in your zones GeoJSON; tries common keys
function zoneKeyFromProps(p) {
  const cand =
    p?.ZONE ?? p?.ZONE_ID ?? p?.ZN_ID ?? p?.TTS_ZONE ?? p?.Zone ??
    p?.Z_no ?? p?.Z_ID ?? p?.ZONE_NO ?? p?.ZONE_NUM ?? null;
  return String(cand ?? 'Zone').trim();
}

/* -------------------------------------------------------
   Planning Districts (PDs)
--------------------------------------------------------*/
const PD_URL = 'data/tts_pds.json?v=' + Date.now();

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

    const group = L.featureGroup().addTo(map);

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

    function clearListSelection() {
      document.querySelectorAll('.pd-item.selected').forEach(el => el.classList.remove('selected'));
    }
    function markListSelected(key) {
      clearListSelection();
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx) cbx.closest('.pd-item')?.classList.add('selected');
    }

    const pdIndex = []; // { key, name, no, layer, bounds }
    L.geoJSON(geo, {
      style: baseStyle,
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const name = (p.PD_name || p.PD_no || "Planning District").toString();
        const key  = pdKeyFromProps(p);
        pdIndex.push({ key, name, no: (p.PD_no ?? null), layer, bounds: layer.getBounds() });

        // click polygon to toggle select
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

    // sort by number then name
    pdIndex.sort((a,b) => {
      const ah = a.no !== null, bh = b.no !== null;
      if (ah && bh) return Number(a.no) - Number(b.no);
      if (ah && !bh) return -1;
      if (!ah && bh) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    const show  = i => { if (!map.hasLayer(i.layer)) i.layer.addTo(group); };
    const hide  = i => { if (map.hasLayer(i.layer))  group.removeLayer(i.layer); };
    const reset = () => { pdIndex.forEach(i => i.layer.setStyle(baseStyle)); };

    function clearSelection() {
      reset();
      hideLabel();
      map.closePopup();
      clearListSelection();
      selectedKey = null;
      selectedItem = null;
      // notify zones to clear
      if (typeof window._zonesClear === 'function') window._zonesClear();
    }
    // expose so zones can clear PD on double-click
    window._pdClearSelection = clearSelection;

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

      // notify zones to show for this PD if engaged
      if (typeof window._zonesShowFor === 'function') window._zonesShowFor(item.key);
    }

    // build list UI
    const itemsHTML = pdIndex.map(i => `
      <div class="pd-item">
        <input type="checkbox" class="pd-cbx" id="pd-${encodeURIComponent(i.key)}"
               data-key="${encodeURIComponent(i.key)}" checked>
        <span class="pd-name" data-key="${encodeURIComponent(i.key)}">${i.name}</span>
      </div>
    `).join('');

    // PD control
    const PDControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control collapsed');
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
        const geocoderEl = document.querySelector('.leaflet-control-geocoder');
        if (geocoderEl) div.style.width = geocoderEl.offsetWidth + 'px';
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div.querySelector('#pd-list'));
        return div;
      }
    });
    map.addControl(new PDControl());

    // Elements + initial view
    const listEl = document.getElementById('pd-list');
    const btnAll = document.getElementById('pd-select-all');
    const btnClr = document.getElementById('pd-clear-all');
    const btnTgl = document.getElementById('pd-toggle');
    const controlRoot = listEl.closest('.pd-control');

    pdIndex.forEach(show);
    try { map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20,20] }); } catch {}

    // checkbox toggles visibility; if hiding selected, clear selection
    listEl.addEventListener('change', e => {
      const cbx = e.target.closest('.pd-cbx');
      if (!cbx) return;
      const key = decodeURIComponent(cbx.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;
      if (cbx.checked) show(item);
      else {
        hide(item);
        if (selectedKey === key) clearSelection();
      }
    });

    // click PD name in list -> toggle selection
    listEl.addEventListener('click', e => {
      const nameEl = e.target.closest('.pd-name');
      if (!nameEl) return;
      const key = decodeURIComponent(nameEl.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx && !cbx.checked) { cbx.checked = true; show(item); }
      if (selectedKey === key) clearSelection();
      else selectItem(item, { zoom: true });
    });

    // PD buttons
    btnAll.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = true);
      pdIndex.forEach(show);
      try { map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20,20] }); } catch {}
    });
    btnClr.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = false);
      pdIndex.forEach(hide);
      clearSelection();
    });
    btnTgl.addEventListener('click', () => {
      const collapsed = controlRoot.classList.toggle('collapsed');
      btnTgl.textContent = collapsed ? 'Expand ▾' : 'Collapse ▴';
    });
  })
  .catch(err => {
    console.error('Failed to load PDs:', err);
    alert('Could not load PDs. See console for details.');
  });

/* -------------------------------------------------------
   Planning Zones (interactive, Engage/Disengage)
--------------------------------------------------------*/
const ZONES_URL = 'data/tts_zones.json?v=' + Date.now();
const ZONE_LABEL_ZOOM = 13; // show zone labels at/above this zoom

let zonesEngaged = false;
const zonesGroup = L.featureGroup(); // visible zones for the current PD
const zonesByKey = new Map();        // PD key -> [GeoJSON Feature, ...]
let selectedZoneLayer = null;
let selectedZoneKey = null;

const zoneBaseStyle     = { color: '#2166f3', weight: 1, fillOpacity: 0.08 };
const zoneSelectedStyle = { color: '#0b3aa5', weight: 3, fillOpacity: 0.25 };

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
    // Index features by PD key (store raw features; build layers on-demand)
    L.geoJSON(zGeo, {
      onEachFeature: (f) => {
        const pdKey = pdKeyFromProps(f.properties || {});
        const key = String(pdKey || '').trim();
        if (!key) return;
        if (!zonesByKey.has(key)) zonesByKey.set(key, []);
        zonesByKey.get(key).push(f);
      }
    });

    // Zones control (same style/width as PD box)
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
      if (!engaged) _zonesClear(); // clear when disengaging
      // when engaging, PD selection will trigger _zonesShowFor
    }

    function clearZoneSelection() {
      if (selectedZoneLayer) {
        selectedZoneLayer.setStyle(zoneBaseStyle);
        try { selectedZoneLayer.closePopup(); } catch {}
      }
      selectedZoneLayer = null;
      selectedZoneKey = null;
    }

    function selectZone(layer, props, pdKey) {
      const zKey = zoneKeyFromProps(props);
      if (selectedZoneLayer === layer) {
        // toggle off
        clearZoneSelection();
        return;
      }
      if (selectedZoneLayer) selectedZoneLayer.setStyle(zoneBaseStyle);
      selectedZoneLayer = layer;
      selectedZoneKey = zKey;
      layer.setStyle(zoneSelectedStyle);
      try { layer.bringToFront?.(); } catch {}
      layer.bindPopup(`Zone ${zKey} — PD ${pdKey}`, { closeButton: true }).openPopup();
    }

    function updateZoneLabels() {
      const show = map.getZoom() >= ZONE_LABEL_ZOOM;
      zonesGroup.eachLayer(l => {
        if (show) l.openTooltip();
        else l.closeTooltip();
      });
    }
    map.on('zoomend', updateZoneLabels);

    // public helpers so PD code can notify us
    window._zonesClear = function _zonesClear() {
      clearZoneSelection();
      zonesGroup.clearLayers();
      if (map.hasLayer(zonesGroup)) map.removeLayer(zonesGroup);
    };

    window._zonesShowFor = function _zonesShowFor(pdKey) {
      if (!zonesEngaged) return;
      const feats = zonesByKey.get(String(pdKey)) || [];
      zonesGroup.clearLayers();
      clearZoneSelection();

      feats.forEach(f => {
        const layer = L.geoJSON(f, { style: zoneBaseStyle }).getLayers()[0];

        // zone number label (shown only when zoomed in)
        const zName = zoneKeyFromProps(f.properties || {});
        layer.bindTooltip(String(zName), {
          permanent: true,
          direction: 'center',
          className: 'zone-label'
        });

        // click to select/unselect; double-click to clear both Zone & PD
        layer.on('click', () => selectZone(layer, f.properties || {}, pdKey));
        layer.on('dblclick', () => {
          clearZoneSelection();
          if (typeof window._pdClearSelection === 'function') window._pdClearSelection();
        });

        layer.addTo(zonesGroup);
      });

      if (!map.hasLayer(zonesGroup) && feats.length) zonesGroup.addTo(map);
      updateZoneLabels();
    };

    // Buttons
    btnEng.addEventListener('click', () => setMode(true));
    btnDis.addEventListener('click', () => setMode(false));

    // start Disengaged
    setMode(false);
  })
  .catch(err => {
    console.error('Failed to load Planning Zones:', err);
  });
