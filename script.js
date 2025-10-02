// Create the map centered on Toronto
const map = L.map('map').setView([43.6532, -79.3832], 12);

// Add OpenStreetMap basemap
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

// Example searchable locations
const places = [
  { name: "CN Tower", coords: [43.6426, -79.3871] },
  { name: "Union Station", coords: [43.6456, -79.3807] },
  { name: "Kensington Market", coords: [43.6545, -79.4020] }
];

// Add markers
const markers = {};
places.forEach(p => {
  markers[p.name] = L.marker(p.coords).addTo(map).bindPopup(p.name);
});

// Add a basic search box
const searchBox = L.control({ position: 'topleft' });
searchBox.onAdd = function() {
  const div = L.DomUtil.create('div', 'search-box');
  div.innerHTML = `<input type="text" id="search" placeholder="Search a place...">`;
  return div;
};
searchBox.addTo(map);

// Search functionality
document.addEventListener("input", e => {
  if (e.target.id === "search") {
    const query = e.target.value.toLowerCase();
    const result = places.find(p => p.name.toLowerCase().includes(query));
    if (result) {
      map.setView(result.coords, 15);
      markers[result.name].openPopup();
    }
  }
});
