// --- Create the map ---
const map = L.map('map').setView([43.6532, -79.3832], 11); // Start in Toronto

// --- Base map tiles ---
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

// --- Address search (no API key needed) ---
L.Control.geocoder({
  collapsed: false,
  defaultMarkGeocode: true
}).addTo(map);

// --- Load PD polygons from your JSON file ---
fetch('data/tts_pds.json')
  .then(r => r.json())
  .then(geo => {
    // style for polygons
    const pdStyle = {
      color: '#ff6600',
      weight: 1,
      fillOpacity: 0.15
    };

    const pdLayer = L.geoJSON(geo, {
      style: pdStyle,
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const label = p.PD_name || p.PD_no || "Planning District";
        layer.bindPopup(label);
        // Optional highlight effect
        layer.on('mouseover', () => layer.setStyle({ weight: 2, fillOpacity: 0.25 }));
        layer.on('mouseout', () => layer.setStyle(pdStyle));
      }
    }).addTo(map);

    // Zoom map to PD boundaries
    try {
      map.fitBounds(pdLayer.getBounds(), { padding: [20,20] });
    } catch (e) {
      console.warn("Could not zoom to PDs:", e);
    }
  })
  .catch(err => console.error("Failed to load PDs:", err));
