// ===== Load PD polygons + checkbox UI (top-right) =====
fetch('data/tts_pds.json')
  .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then(geo => {
    const baseStyle     = { color: '#ff6600', weight: 1, fillOpacity: 0.15 };
    const selectedStyle = { color: '#d40000', weight: 3, fillOpacity: 0.25 };

    const group = L.featureGroup().addTo(map);

    // Build feature index
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

    // Sort by PD number then name
    pdIndex.sort((a,b) => {
      const ah = a.no !== null, bh = b.no !== null;
      if (ah && bh) return Number(a.no) - Number(b.no);
      if (ah && !bh) return -1;
      if (!ah && bh) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // Helpers
    const show  = (i) => { if (!map.hasLayer(i.layer)) i.layer.addTo(group); };
    const hide  = (i) => { if (map.hasLayer(i.layer))  group.removeLayer(i.layer); };
    const reset = ()   => { pdIndex.forEach(i => i.layer.setStyle(baseStyle)); };

    // Build list HTML (checkbox + clickable name span)
    const itemsHTML = pdIndex.map(i => `
      <div class="pd-item">
        <input type="checkbox" class="pd-cbx" id="pd-${encodeURIComponent(i.key)}"
               data-key="${encodeURIComponent(i.key)}" checked>
        <span class="pd-name" data-key="${encodeURIComponent(i.key)}">${i.name}</span>
      </div>
    `).join('');

    // Control: top-right
    const PDControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control');
        div.innerHTML = `
          <div class="pd-header">
            <strong>Planning Districts</strong>
            <div class="pd-actions">
              <button type="button" id="pd-toggle">Collapse</button>
              <button type="button" id="pd-select-all">Select all</button>
              <button type="button" id="pd-clear-all">Clear all</button>
            </div>
          </div>
          <div class="pd-list" id="pd-list">${itemsHTML}</div>
        `;
        // prevent map drag/scroll when interacting with this control
        L.DomEvent.disableClickPropagation(div);
        // VERY IMPORTANT: stop wheel scroll from panning map
        const list = div.querySelector('#pd-list');
        L.DomEvent.disableScrollPropagation(list);
        return div;
      }
    });
    map.addControl(new PDControl());

    // Wire up elements
    const listEl = document.getElementById('pd-list');
    const btnAll = document.getElementById('pd-select-all');
    const btnClr = document.getElementById('pd-clear-all');
    const btnTgl = document.getElementById('pd-toggle');
    const controlRoot = listEl.closest('.pd-control');

    // Initially show all + fit
    pdIndex.forEach(show);
    try {
      map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20,20] });
    } catch {}

    // Checkbox toggles visibility ONLY
    listEl.addEventListener('change', (e) => {
      const cbx = e.target.closest('.pd-cbx');
      if (!cbx) return;
      const key = decodeURIComponent(cbx.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;
      if (cbx.checked) show(item); else hide(item);
    });

    // Click on PD NAME (span) -> zoom + highlight (no checkbox toggle)
    listEl.addEventListener('click', (e) => {
      const nameEl = e.target.closest('.pd-name');
      if (!nameEl) return;
      const key = decodeURIComponent(nameEl.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;

      // ensure visible
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx && !cbx.checked) { cbx.checked = true; show(item); }

      reset();
      item.layer.setStyle(selectedStyle);
      try { item.layer.bringToFront?.(); } catch {}
      map.fitBounds(item.bounds, { padding: [30,30] });
      item.layer.openPopup();
    });

    // Buttons
    btnAll.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = true);
      pdIndex.forEach(show);
      reset();
      try {
        map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20,20] });
      } catch {}
    });

    btnClr.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = false);
      pdIndex.forEach(hide);
      reset();
    });

    // Expand / Collapse list (UI only)
    btnTgl.addEventListener('click', () => {
      const collapsed = controlRoot.classList.toggle('collapsed');
      btnTgl.textContent = collapsed ? 'Expand' : 'Collapse';
    });
  })
  .catch(err => {
    console.error("Failed to load PDs:", err);
    alert("Could not load PDs. See console for details.");
  });
