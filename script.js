const map = L.map('map').setView([43.6532, -79.3832], 12);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

L.Control.geocoder({
  collapsed: false,
  defaultMarkGeocode: true
}).addTo(map);
