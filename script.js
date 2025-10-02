console.log("Build v8 starting…");

// Map
const map = L.map('map').setView([43.6532, -79.3832], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap'
}).addTo(map);

// Geocoder (non-fatal if missing)
try {
  L.Control.geocoder({ collapsed: false, defaultMarkGeocode: true }).addTo(map);
  console.log("Geocoder ready");
} catch (e) {
  console.warn("Geocoder not loaded:", e);
}

// --- Load PD polygons + build dropdown ---
fetch('data/tts_pds.json')
  .then(r => r.json())
  .then(geo => {
    const baseStyle = { color: '#ff6600', weight: 1, fillOpacity: 0.15 };

    // Draw PDs
    const pdLayer = L.geoJSON(geo, {
      style: baseStyle,
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const label = p.PD_name || p.PD_no || "Planning District";
        layer.bindPopup(label);
        layer.on('mouseover', () => layer.setStyle({ weight: 2, fillOpacity: 0.25 }));
        layer.on('mouseout',  () => layer.setStyle(baseStyle));
      }
    }).addTo(map);

    // Keep overall bounds
    const allBounds = pdLayer.getBounds();
    map.fitBounds(allBounds, { padding: [20, 20] });

    // Build an index of PD layers and a sorted option list
    const pdIndex = []; // [{key, name, layer, bounds}]
    pdLayer.eachLayer(layer => {
      const p = layer.feature?.properties || {};
      const name  = (p.PD_name || p.PD_no || "PD").toString();
      // Use PD_no if present for a stable key; fallback to name
      const key   = (p.PD_no != null ? String(p.PD_no) : name).trim();
      pdIndex.push({ key, name, layer, bounds: layer.getBounds(), no: (p.PD_no ?? null) });
    });

    // Sort by PD_no numerically if available, else by name
    pdIndex.sort((a, b) => {
      const aHas = a.no !== null, bHas = b.no !== null;
      if (aHas && bHas) return Number(a.no) - Number(b.no);
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // Create dropdown HTML
    const optionsHTML = [
      `<option value="">— Select a PD —</option>`,
      `<option value="__ALL__">Show all PDs</option>`,
      ...pdIndex.map(item => `<option value="${encodeURIComponent(item.key)}">${item.name}</option>`)
    ].join('');

    // Leaflet control with dropdown
    const PDControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control');
        div.innerHTML = `<select id="pdSelect">${optionsHTML}</select>`;
        // Don’t let map drag when clicking the control
        L.DomEvent.disableClickPropagation(div);
        return div;
      }
    });
    map.addControl(new PDControl());

    // Change handler
    const selectEl = document.getElementById('pdSelect');

    function resetHighlight() {
      pdLayer.setStyle(baseStyle);
    }

    selectEl.addEventListener('change', () => {
      const val = selectEl.value;
      if (val === "__ALL__") {
        resetHighlight();
        map.fitBounds(allBounds, { padding: [20, 20] });
        return;
      }
      const key = decodeURIComponent(val);
      const item = pdIndex.find(x => x.key === key);
      if (!item) return;

      // Highlight the selected PD and zoom to it
      resetHighlight();
      item.layer.setStyle({ color: '#d40000', weight: 3, fillOpacity: 0.25 });
      try { item.layer.bringToFront?.(); } catch {}
      map.fitBounds(item.bounds, { padding: [30, 30] });
      item.layer.openPopup();
    });
  })
  .catch(err => {
    console.error("Failed to load PDs:", err);
    alert("Could not load PDs. See console for details.");
  });

console.log("Build v8 loaded");
