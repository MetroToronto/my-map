// ===== Map & basemap =====
const map = L.map('map').setView([43.6532, -79.3832], 11);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

// ===== Geocoder (address search) =====
try {
  L.Control.geocoder({
    collapsed: false,
    defaultMarkGeocode: true
  }).addTo(map);
} catch (e) {
  console.warn("Geocoder not loaded:", e);
}

// ===== Load PD polygons + checkbox UI (top-right) =====
fetch('data/tts_pds.json')
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then(geo => {
    const baseStyle = { color: '#ff6600', weight: 1, fillOpacity: 0.15 };
    const selectedStyle = { color: '#d40000', weight: 3, fillOpacity: 0.25 };

    // Group for PD layers we decide to show
    const group = L.featureGroup().addTo(map);

    // Build an index: one layer per PD feature
    const pdIndex = []; // { key, name, no, layer, bounds }
    L.geoJSON(geo, {
      style: baseStyle,
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const name = (p.PD_name || p.PD_no || "Planning District").toString();
        const key  = (p.PD_no != null ? String(p.PD_no) : name).trim();
        layer.bindPopup(name);
        pdIndex.push({ key, name, no: (p.PD_no ?? null), layer, bounds: layer.getBounds() });
      }
    });

    // Sort by PD number when available, otherwise by name
    pdIndex.sort((a, b) => {
      const ah = a.no !== null, bh = b.no !== null;
      if (ah && bh) return Number(a.no) - Number(b.no);
      if (ah && !bh) return -1;
      if (!ah && bh) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // Helpers
    function show(item) { if (!map.hasLayer(item.layer)) item.layer.addTo(group); }
    function hide(item) { if (map.hasLayer(item.layer)) group.removeLayer(item.layer); }
    function resetStyles() { pdIndex.forEach(i => i.layer.setStyle(baseStyle)); }

    // Create the checkbox list HTML
    const itemsHTML = pdIndex.map(i => `
      <div class="pd-item">
        <input type="checkbox" class="pd-cbx" id="pd-${encodeURIComponent(i.key)}"
               data-key="${encodeURIComponent(i.key)}" checked>
        <label for="pd-${encodeURIComponent(i.key)}" data-key="${encodeURIComponent(i.key)}">
          ${i.name}
        </label>
      </div>
    `).join('');

    // Leaflet control (TOP-RIGHT)
    const PDControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control');
        div.innerHTML = `
          <div class="pd-header">
            <strong>Planning Districts</strong>
            <div class="pd-actions">
              <button type="button" id="pd-select-all">Select all</button>
              <button type="button" id="pd-clear-all">Clear all</button>
            </div>
          </div>
          <div class="pd-list" id="pd-list">${itemsHTML}</div>
        `;
        // Prevent map drag when interacting with control
        L.DomEvent.disableClickPropagation(div);
        return div;
      }
    });
    map.addControl(new PDControl());

    // Wire up behavior
    const listEl = document.getElementById('pd-list');
    const btnAll = document.getElementById('pd-select-all');
    const btnClr = document.getElementById('pd-clear-all');

    // Initially show all layers and fit to extent
    pdIndex.forEach(show);
    try {
      map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20, 20] });
    } catch {}

    // Checkbox toggle (show/hide)
    listEl.addEventListener('change', (e) => {
      const cbx = e.target.closest('.pd-cbx');
      if (!cbx) return;
      const key = decodeURIComponent(cbx.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;
      if (cbx.checked) show(item); else hide(item);
    });

    // Click PD name -> ensure visible, zoom + highlight
    listEl.addEventListener('click', (e) => {
      const label = e.target.closest('label[data-key]');
      if (!label) return;
      const key = decodeURIComponent(label.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;

      // ensure it's checked & visible
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx && !cbx.checked) { cbx.checked = true; show(item); }

      // highlight + zoom
      resetStyles();
      item.layer.setStyle(selectedStyle);
      try { item.layer.bringToFront?.(); } catch {}
      map.fitBounds(item.bounds, { padding: [30, 30] });
      item.layer.openPopup();
    });

    // Select all / Clear all buttons
    btnAll.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = true);
      pdIndex.forEach(show);
      resetStyles();
      try {
        map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20, 20] });
      } catch {}
    });

    btnClr.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = false);
      pdIndex.forEach(hide);
      resetStyles();
    });
  })
  .catch(err => {
    console.error("Failed to load PDs:", err);
    alert("Could not load PDs. See console for details.");
  });
