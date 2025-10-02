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

// Load PDs
const PD_URL = 'data/tts_pds.json';
console.log("Fetching:", PD_URL);

fetch(PD_URL)
  .then(r => {
    console.log("Fetch status:", r.status);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then(geo => {
    const count = Array.isArray(geo.features) ? geo.features.length : 0;
    console.log("GeoJSON features:", count);

    // Quick CRS sanity check on first coordinate
    try {
      const c = geo.features?.[0]?.geometry?.coordinates;
      let sample;
      if (geo.features?.[0]?.geometry?.type === "Polygon") sample = c[0][0];
      if (geo.features?.[0]?.geometry?.type === "MultiPolygon") sample = c[0][0][0];
      if (sample) console.log("Sample coord [lon,lat]:", sample);
      // If you see values like 600000 or 4840000 here, the file is NOT WGS84 and must be re-exported.
    } catch {}

    const style = { color: '#ff6600', weight: 1, fillOpacity: 0.15 };

    const layer = L.geoJSON(geo, {
      style,
      onEachFeature: (f, lyr) => {
        const p = f.properties || {};
        lyr.bindPopup(p.PD_name || p.PD_no || "Planning District");
        lyr.on('mouseover', () => lyr.setStyle({ weight: 2, fillOpacity: 0.25 }));
        lyr.on('mouseout',  () => lyr.setStyle(style));
      }
    }).addTo(map);

    try {
      map.fitBounds(layer.getBounds(), { padding: [20,20] });
      console.log("fitBounds done");
    } catch (e) {
      console.warn("fitBounds failed:", e);
    }
  })
  .catch(err => {
    console.error("PD load error:", err);
    alert("Could not load PDs (see console).");
  });

console.log("Build v8 loaded");
