

// =========================================================
// script.js (REWRITE – PD base layer + selection rules + labels)
// Keeps compatibility with routing.js / report.js:
// - window.map
// - window.ROUTING_ORIGIN
// - window.PD_REGISTRY
// - window.getZoneTargetsForPD(pdKey)
// - window.getSelectedZoneTargets()
// =========================================================

(() => {
  'use strict';

  // --------------------- Map boot ---------------------
  const map = L.map('map').setView([43.96199, -79.750281], 11);
  window.map = map; // required by routing.js / report.js

  map.zoomControl.setPosition('topright');

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 9,
    attribution: '© OpenStreetMap'
  }).addTo(map);

  // --------------------- Helpers ---------------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function stopMapEvents(el) {
    if (!el || !L || !L.DomEvent) return;
    L.DomEvent.disableClickPropagation(el);
    if (L.DomEvent.disableScrollPropagation) L.DomEvent.disableScrollPropagation(el);
  }

  function safeJSONParse(txt, label) {
    try { return JSON.parse(txt); }
    catch (e) {
      console.error(label + ' parse error:', e);
      throw e;
    }
  }

  // Robust PD / Zone property readers (handles your data variants)
  function pdKeyFromProps(p) {
    const cand =
      p?.PD_no ?? p?.pd_no ?? p?.PDID ?? p?.PD_ID ?? p?.PD ?? p?.pd ??
      p?.PD_NAME ?? p?.PD_name ?? p?.PD_name ?? null;
    if (cand != null) return String(cand).trim();
    return String(p?.PD_name || p?.PD_NAME || p?.name || 'PD').trim();
  }

  function pdNameFromProps(p) {
    const cand =
      p?.PD_name ?? p?.PD_NAME ?? p?.name ?? p?.Name ??
      p?.PD_no ?? p?.pd_no ?? null;
    if (cand != null) return String(cand).trim();
    return pdKeyFromProps(p);
  }

  function zoneKeyFromProps(p) {
    // Traffic Zone id in your data is `TTS2022`
    const cand =
      p?.TTS2022 ?? p?.tts2022 ??
      p?.ZONE ?? p?.Zone ?? p?.zone ?? p?.ZONE_NO ?? p?.zone_no ??
      p?.TAZ ?? p?.taz ?? p?.PZ ?? p?.pz ??
      p?.TZ ?? p?.tz ?? p?.id ?? p?.ID ?? null;
    if (cand != null) return String(cand).trim();
    return String(p?.name || p?.Name || 'Zone').trim();
  }

  // --------------------- Logo (bottom-left) ---------------------
  try {
    const LogoControl = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'logo-control');
        const imgPath = 'data/LEA_logo.png';
        div.innerHTML = `
          <div class="logo-inner">
            <img src="${imgPath}" alt="LEA Consulting" loading="lazy" />
          </div>
        `;
        stopMapEvents(div);
        return div;
      }
    });
    map.addControl(new LogoControl());

    // Hard-hide logo when it overlaps the left-side control stack (no flicker)
    const logoEl = document.querySelector('.logo-control');
    let logoHidden = false;

    const rectsOverlap = (a, b) =>
      !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);

    function setLogoHidden(hidden) {
      if (!logoEl) return;
      const next = !!hidden;
      if (next === logoHidden) return;
      logoHidden = next;
      logoEl.classList.toggle('is-hidden', logoHidden);
    }

    function updateLogoOverlap() {
      if (!logoEl) return;
      const lr = logoEl.getBoundingClientRect();
      if (!lr.width || !lr.height) return;

      const leftStack = document.querySelectorAll('.leaflet-top.leaflet-left .leaflet-control');
      let conflict = false;
      leftStack.forEach(el => {
        if (conflict) return;
        if (!el || el === logoEl) return;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        if (rectsOverlap(lr, r)) conflict = true;
      });
      setLogoHidden(conflict);
    }

    const scheduleLogoCheck = (() => {
      let raf = 0;
      return () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          raf = 0;
          updateLogoOverlap();
        });
      };
    })();

    const ctrlContainer = document.querySelector('.leaflet-control-container');
    if (ctrlContainer && window.MutationObserver) {
      const obs = new MutationObserver(scheduleLogoCheck);
      obs.observe(ctrlContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    }
    window.addEventListener('resize', scheduleLogoCheck);
    setTimeout(scheduleLogoCheck, 120);
  } catch (e) {
    console.warn('Logo control failed:', e);
  }

  // --------------------- PDs: base layer + selection ---------------------
  const PD_URL = 'data/tts_pds.json?v=' + Date.now();

  const PD_BASE_STYLE = {
    color: '#ffb347',      // light orange border
    weight: 3.5,
    opacity: 0.95,
    fillColor: '#ffd7a8',  // light orange fill
    fillOpacity: 0.22
  };

  const PD_SELECTED_STYLE = {
    color: '#ff3b30',
    weight: 7.5,
    opacity: 1,
    fillColor: '#ff3b30',
    fillOpacity: 0.30
  };

  const pdGroup = L.layerGroup().addTo(map);
  const pdLabelGroup = L.layerGroup().addTo(map);

  
  function computeScaleByZoom(zoom, minZoom, maxZoom, maxIncrease) {
    const t = Math.max(0, Math.min(1, (zoom - minZoom) / Math.max(1, (maxZoom - minZoom))));
    return 1 + (maxIncrease * t);
  }
const PD_LABEL_MAX_INCREASE = 0.40;  // +40% max at max zoom
  const PD_LABEL_MIN_ZOOM = 10;        // show labels when closer         // show labels when closer
  const PD_LABEL_MAX_FS   = 18;
  const PD_LABEL_MIN_FS   = 11;

  const selectedPDs = new Set(); // set of pdKey strings
  let zonesEngaged = false;

  // Registry consumed by routing.js
  const PD_REGISTRY = Object.create(null);
  window.PD_REGISTRY = PD_REGISTRY;

  // DOM refs (filled once PD control exists)
  let pdListEl = null;
  let pdToggleBtn = null;
  let pdControlDiv = null;


  // Debounced label updates (prevents lag from repeated DOM work)
  let _labelRaf = 0;
  function scheduleLabelUpdate() {
    if (_labelRaf) cancelAnimationFrame(_labelRaf);
    _labelRaf = requestAnimationFrame(() => {
      _labelRaf = 0;
      updatePDLabels();
      updatePZLabels();
      updateSelectedZoneLabel();
    });
  }

  // Create / update label markers (PDs)
  const pdLabelMarkers = new Map(); // key -> marker

  function pdLabelFontSize(zoom) {
    // Exponential growth per zoom level (noticeable but capped)
    const dz = Math.max(0, zoom - PD_LABEL_MIN_ZOOM);
    const scaleCap = PD_LABEL_MAX_FS / PD_LABEL_MIN_FS;
    const scale = Math.min(Math.pow(1.40, dz), scaleCap); // ~18% per zoom level
    const fs = PD_LABEL_MIN_FS * scale;
    return clamp(fs, PD_LABEL_MIN_FS, PD_LABEL_MAX_FS);
  }

  function updatePDLabels() {
    const z = map.getZoom();
    const show = z >= PD_LABEL_MIN_ZOOM;

    for (const [key, marker] of pdLabelMarkers.entries()) {
      const el = marker.getElement();
      if (!el) continue;
      const labelEl = el.querySelector('.map-label');
      if (!labelEl) continue;

      // Hide the PD label for the PD currently being used to display zones (to make room)
      const hideBecauseZones = zonesEngaged && activeZonePDKey && String(activeZonePDKey) === String(key);
if (!show || hideBecauseZones) {
        labelEl.classList.add('is-hidden');
      } else {
        labelEl.classList.remove('is-hidden');
        labelEl.style.fontSize = `${pdLabelFontSize(z)}px`;
      }
    }
  }

  function makePDLabel(key, name, centerLatLng) {
    const marker = L.marker(centerLatLng, {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: '',
        html: `<div class="map-label pd-label" data-pd="${encodeURIComponent(key)}" style="font-size:${pdLabelFontSize(map.getZoom())}px">${name}</div>`,
        iconSize: [1, 1]
      })
    });
    marker.addTo(pdLabelGroup);
    pdLabelMarkers.set(key, marker);
  }

  // Selection helpers (sync map + list)
  function setPDSelected(key, state) {
    const reg = PD_REGISTRY[key];
    if (!reg || !reg.layer) return;

    const willSelect = !!state;

    if (willSelect) selectedPDs.add(key);
    else selectedPDs.delete(key);

    reg.layer.setStyle(willSelect ? PD_SELECTED_STYLE : PD_BASE_STYLE);

    
    if (state && reg.layer.bringToFront) reg.layer.bringToFront();
// Sync checkbox if present
    if (pdListEl) {
      const row = pdListEl.querySelector(`.pd-item[data-key="${encodeURIComponent(key)}"]`);
      const cbx = row ? row.querySelector('.pd-cbx') : null;
      if (cbx) cbx.checked = willSelect;
    }
  }

  function clearAllPDSelection(keepBaseLayer = true) {
    // keepBaseLayer is here for readability; base layer always stays on.
    for (const key of Array.from(selectedPDs)) setPDSelected(key, false);
    selectedPDs.clear();
    scheduleLabelUpdate();
      updateSelectedZoneLabel();
    updateSelectedZoneLabel();
  }

  function selectAllPDs() {
    for (const key of Object.keys(PD_REGISTRY)) setPDSelected(key, true);
    scheduleLabelUpdate();
  }

  function handlePDClick(key, additive) {
    if (!additive) {
      // single-select behavior:
      // - if this is the only selected PD already, toggle it OFF (for list checkbox usability)
      // - otherwise clear others and select this
      const alreadyOnly = (selectedPDs.size === 1 && selectedPDs.has(key));
      if (alreadyOnly) {
        setPDSelected(key, false);
        selectedPDs.delete(key);
      } else {
        clearAllPDSelection(true);
        setPDSelected(key, true);
      }
    } else {
      // ctrl/cmd: toggle
      const isSel = selectedPDs.has(key);
      setPDSelected(key, !isSel);
    }
    scheduleLabelUpdate();
  }

  function buildPDControl(pdFeaturesInOrder) {
    const PDControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control');
        div.dataset.role = 'pd';

        div.innerHTML = `
          <div class="pd-header"><strong>Planning Districts</strong></div>
          <div class="pd-actions">
            <button type="button" id="pd-select-all">Select all</button>
            <button type="button" id="pd-clear-all">Clear all</button>
            <button type="button" id="pd-toggle" class="grow">Collapse ▴</button>
          </div>
          <div class="pd-list" id="pd-list"></div>
        `;

        stopMapEvents(div);
        return div;
      }
    });

    map.addControl(new PDControl());

    pdListEl = document.getElementById('pd-list');
    pdToggleBtn = document.getElementById('pd-toggle');
    pdControlDiv = pdListEl ? pdListEl.closest('.pd-control') : null;

    // Wheel behavior: scroll list/panel without zooming map
    if (pdControlDiv && pdListEl) {
      // Stop map zoom when wheel over panel
      if (L.DomEvent && L.DomEvent.disableScrollPropagation) {
        L.DomEvent.disableScrollPropagation(pdControlDiv);
        L.DomEvent.disableScrollPropagation(pdListEl);
      }
      // Scroll list when wheel used over header/buttons area
      pdControlDiv.addEventListener('wheel', (e) => {
        if (e.target && pdListEl.contains(e.target)) return; // let native list scroll
        e.preventDefault();
        e.stopPropagation();
        pdListEl.scrollTop += e.deltaY;
      }, { passive: false });
    }

    // Populate PD list in the SAME order as the GeoJSON features (Toronto first, etc.)
    if (pdListEl) {
      pdListEl.innerHTML = '';
      for (const f of pdFeaturesInOrder) {
        const props = f.properties || {};
        const key = pdKeyFromProps(props);
        const name = pdNameFromProps(props);

        const row = document.createElement('div');
        row.className = 'pd-item';
        row.dataset.key = encodeURIComponent(key);
        row.innerHTML = `
          <input class="pd-cbx" type="checkbox" data-key="${encodeURIComponent(key)}">
          <div class="pd-name">${name}</div>
          <input class="pd-route-count" type="number" min="0" max="3" step="1" value="1" />
        `;
        pdListEl.appendChild(row);

        const cbx = row.querySelector('.pd-cbx');
        const nameEl = row.querySelector('.pd-name');

        // Click on checkbox OR name selects
        const clickHandler = (ev) => {
          const additive = !!(ev.ctrlKey || ev.metaKey);
          handlePDClick(key, additive);
        };

        cbx.addEventListener('change', (ev) => {
          // Checkbox toggles this PD only (like ctrl/cmd toggle on the map).
          // This lets you check/uncheck multiple PDs without affecting the rest.
          ev.stopPropagation();
          const checked = !!cbx.checked;

          setPDSelected(key, checked);
          if (checked) selectedPDs.add(key);
          else selectedPDs.delete(key);

          scheduleLabelUpdate();
        });

        // Clicking the name/row selects (supports ctrl/cmd add/remove) (supports ctrl/cmd add/remove)
        cbx.addEventListener('click', (ev) => { ev.stopPropagation(); });
nameEl.addEventListener('click', clickHandler);
        row.addEventListener('click', (ev) => {
          // Clicking empty space in row should also select
          if (ev.target && (ev.target.classList.contains('pd-route-count') || ev.target.classList.contains('pd-cbx'))) return;
          clickHandler(ev);
        });
      }
    }

    // Buttons
    const btnAll = document.getElementById('pd-select-all');
    const btnClr = document.getElementById('pd-clear-all');

    if (btnAll) btnAll.addEventListener('click', () => { selectAllPDs(); });
    if (btnClr) btnClr.addEventListener('click', () => { clearAllPDSelection(true); });

    // Collapse logic: just hide the list (keeps header/actions visible)
    let pdCollapsed = false;
    function setCollapsed(v) {
      pdCollapsed = !!v;
      if (!pdListEl || !pdToggleBtn) return;
      pdListEl.style.display = pdCollapsed ? 'none' : '';
      pdToggleBtn.textContent = pdCollapsed ? 'Expand ▾' : 'Collapse ▴';
    }
    setCollapsed(false);

    if (pdToggleBtn) {
      pdToggleBtn.addEventListener('click', () => setCollapsed(!pdCollapsed));
    }
  }

  // Load PDs and build polygons
  fetch(PD_URL)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || PD_URL}`);
      return r.text();
    })
    .then(txt => safeJSONParse(txt, 'PD GeoJSON'))
    .then(geojson => {
      const feats = Array.isArray(geojson.features) ? geojson.features : [];

      // Build polygons and registry, keep feature order for list
      const pdFeaturesInOrder = [];

      L.geoJSON(geojson, {
        style: PD_BASE_STYLE,
        onEachFeature: (feature, layer) => {
          const props = feature.properties || {};
          const key = pdKeyFromProps(props);
          const name = pdNameFromProps(props);

          // Store
          PD_REGISTRY[key] = {
            key,
            name,
            layer,
            bounds: layer.getBounds ? layer.getBounds() : null,
            geom: feature.geometry || null
          };

          pdFeaturesInOrder.push(feature);

          // Add to group
          layer.addTo(pdGroup);

          // PD label marker
          try {
            const c = layer.getBounds().getCenter();
            makePDLabel(key, name, c);
          } catch {}

          // Map click selection (paused if zones engaged)
          layer.on('click', (ev) => {
            const additive = !!(ev.originalEvent && (ev.originalEvent.ctrlKey || ev.originalEvent.metaKey));

            if (zonesEngaged) {
              // In zone mode: PD clicking does NOT select PDs.
              // Instead, show zones for that PD and clear any PD selections (map + list).
              showZonesForPD(key);
              // Hide label for this PD while its zones are visible (handled by scheduleLabelUpdate)
              scheduleLabelUpdate();
              return;
            }

            handlePDClick(key, additive);
          });
}
      });

      buildPDControl(pdFeaturesInOrder);

      map.on('zoomend', () => {
        scheduleLabelUpdate();
        updatePZLabels();
      });
      map.on('moveend', () => {
        // keep label sizes/visibility in sync after pan/zoom animations
        scheduleLabelUpdate();
      });
      map.on('zoom', () => {
        scheduleLabelUpdate();
        updatePZLabels();
      });
      scheduleLabelUpdate();

      // Provide PD target centers for routing.js (used in some modes)
      // routing.js already reads PD_REGISTRY + DOM, so no extra exports needed.

    })
    .catch(err => {
      console.error('Failed to load PDs:', err);
      alert('Could not load Planning Districts. See console for details.');
    });


  // --------------------- Geometry helpers (zone->PD mapping) ---------------------
  function pointInRing(pt, ring) {
    // Ray casting algorithm. pt = [lng,lat], ring = [[lng,lat],...]
    let x = pt[0], y = pt[1];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(pt, polyCoords) {
    // polyCoords: [ [ring1], [hole1], ... ]
    if (!polyCoords || !polyCoords.length) return false;
    if (!pointInRing(pt, polyCoords[0])) return false; // outside outer ring
    // holes
    for (let i = 1; i < polyCoords.length; i++) {
      if (pointInRing(pt, polyCoords[i])) return false;
    }
    return true;
  }

  function pointInGeoJSON(pt, geom) {
    if (!geom) return false;
    const t = geom.type;
    const c = geom.coordinates;
    if (!t || !c) return false;

    if (t === 'Polygon') return pointInPolygon(pt, c);
    if (t === 'MultiPolygon') {
      for (const poly of c) {
        if (pointInPolygon(pt, poly)) return true;
      }
      return false;
    }
    return false;
  }

  function buildZonesByPD(zoneEntries) {
    // zoneEntries: [{feature, center:[lng,lat], zKey}]
    zonesByKey.clear();

    const pdKeys = Object.keys(PD_REGISTRY);
    if (!pdKeys.length) return;

    // Pre-build arrays for faster checks
    const pdList = pdKeys.map(k => {
      const r = PD_REGISTRY[k];
      return { key: k, bounds: r?.bounds, geom: r?.geom };
    });

    let assigned = 0;

    for (const z of zoneEntries) {
      const pt = z.center;
      let matched = null;

      // bounds prefilter
      for (const pd of pdList) {
        if (pd.bounds && !pd.bounds.contains(L.latLng(pt[1], pt[0]))) continue;
        if (pointInGeoJSON(pt, pd.geom)) { matched = pd.key; break; }
      }

      if (matched) {
        if (!zonesByKey.has(matched)) zonesByKey.set(matched, []);
        zonesByKey.get(matched).push(z.feature);
        assigned++;
      }
    }

    // console for sanity
    console.log(`Zones indexed to PDs: ${assigned}/${zoneEntries.length}`);
  }

  // --------------------- Planning Zones (Traffic Zones) ---------------------
  const ZONES_URL = 'data/tts_zones.json?v=' + Date.now();

  const zoneGroup = L.layerGroup(); // not added until engaged
  const pzLabelGroup = L.layerGroup().addTo(map);

  const ZONE_BASE_STYLE = {
    color: '#0b5fff',
    weight: 3.5,
    opacity: 0.65,
    fillColor: '#0b5fff',
    fillOpacity: 0.06
  };

  const ZONE_SELECTED_STYLE = {
    color: '#0b5fff',
    weight: 7.5,
    opacity: 1,
    fillColor: '#0b5fff',
    fillOpacity: 0.10
  };

  const PZ_LABEL_MAX_INCREASE = 0.20;  // +20% max at max zoom
  const PZ_LABEL_MIN_ZOOM = 13;
  const PZ_LABEL_MIN_FS   = 10;
  const PZ_LABEL_MAX_FS   = 15;

  const pzLabelMarkers = new Map(); // zoneKey -> marker
  let selectedZoneLayer = null;
  // Persistent selected zone overlay (stays even when zones are disengaged)
  const selectedZonePersistGroup = L.layerGroup().addTo(map);

  const selectedZoneLabelGroup = L.layerGroup().addTo(map);
  let selectedZonePersistLayer = null;
  let selectedZoneId = null;
  let selectedZoneLabelMarker = null;

  // Zone lookup by id (TTS2022)
  const zonesById = new Map(); // zoneId -> feature


  function pzLabelFontSize(z) {
    // Exponential growth per zoom level (noticeable but capped)
    const dz = Math.max(0, z - PZ_LABEL_MIN_ZOOM);
    const scaleCap = PZ_LABEL_MAX_FS / PZ_LABEL_MIN_FS;
    const scale = Math.min(Math.pow(1.80, dz), scaleCap); // ~14% per zoom level
    const fs = PZ_LABEL_MIN_FS * scale;
    return clamp(fs, PZ_LABEL_MIN_FS, PZ_LABEL_MAX_FS);
  }

  function updatePZLabels() {
    const z = map.getZoom();
    const show = zonesEngaged && !!activeZonePDKey && z >= PZ_LABEL_MIN_ZOOM;

    for (const [zKey, marker] of pzLabelMarkers.entries()) {
      const el = marker.getElement();
      if (!el) continue;
      const labelEl = el.querySelector('.map-label');
      if (!labelEl) continue;

      if (!show) {
        labelEl.classList.add('is-hidden');
        continue;
      }

      labelEl.classList.remove('is-hidden');
      labelEl.style.fontSize = `${pzLabelFontSize(z)}px`;

      // selected zone emphasis
      const isSel = selectedZoneLayer && selectedZoneLayer.feature &&
                    zoneKeyFromProps((selectedZoneLayer.feature.properties || {})) === zKey;
      labelEl.classList.toggle('is-selected', !!isSel);
    }
  }

  function updateSelectedZoneLabel() {
    // Keep label for the persist-selected TZ even when zones are disengaged
    if (selectedZoneLabelMarker) {
      try { selectedZoneLabelGroup.removeLayer(selectedZoneLabelMarker); } catch {}
      selectedZoneLabelMarker = null;
    }
    if (!selectedZonePersistLayer || !selectedZoneId) return;

    const z = map.getZoom();
    if (z < PZ_LABEL_MIN_ZOOM) return;

    let center = null;
    try {
      const b = selectedZonePersistLayer.getBounds && selectedZonePersistLayer.getBounds();
      if (b && b.isValid && b.isValid()) center = b.getCenter();
    } catch {}
    if (!center) return;

    const zKeySafe = String(selectedZoneId).trim();
    selectedZoneLabelMarker = L.marker(center, {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: '',
        html: `<div class="map-label pz-label is-selected" data-pz="${encodeURIComponent(zKeySafe)}" style="font-size:${pzLabelFontSize(z)}px">TZ ${zKeySafe}</div>`,
        iconSize: [1, 1]
      })
    });
    selectedZoneLabelGroup.addLayer(selectedZoneLabelMarker);
  }


  function centerOfZoneFeature(f) {
    try {
      const tmp = L.geoJSON(f);
      const layers = tmp.getLayers ? tmp.getLayers() : [];
      const layer = layers[0];
      if (!layer || !layer.getBounds) return null;
      return layer.getBounds().getCenter();
    } catch {
      return null;
    }
  }

  function clearZoneSelection() {
    if (selectedZoneLayer) selectedZoneLayer.setStyle(ZONE_BASE_STYLE);
    selectedZoneLayer = null;
    try { map.closePopup(); } catch {}
    updatePZLabels();
  }

  function clearPersistentZoneSelection() {
    if (selectedZonePersistLayer) {
      try { selectedZonePersistGroup.removeLayer(selectedZonePersistLayer); } catch {}
    }
    selectedZonePersistLayer = null;
    selectedZoneId = null;
    if (selectedZoneLabelMarker) {
      try { selectedZoneLabelGroup.removeLayer(selectedZoneLabelMarker); } catch {}
      selectedZoneLabelMarker = null;
    }
  }

  function setPersistentZoneSelection(feature, { zoomTo = true } = {}) {
    if (!feature) return;

    const zKey = zoneKeyFromProps(feature.properties || {});
    const zId = String(zKey).trim();

    // Toggle off if selecting the same zone again
    if (selectedZoneId && zId && selectedZoneId === zId) {
      clearPersistentZoneSelection();
      return;
    }

    clearPersistentZoneSelection();

    selectedZoneId = zId || null;

    // Build a dedicated layer for the selected zone so it can remain visible even if zones are disengaged
    selectedZonePersistLayer = L.geoJSON(feature, {
      style: ZONE_SELECTED_STYLE,
      interactive: true
    });

    selectedZonePersistLayer.eachLayer((lyr) => {
      // clicking again toggles it off (works even when zones are disengaged)
      lyr.on('click', () => {
        // only toggle if this is still the selected id
        if (selectedZoneId === zId) clearPersistentZoneSelection();
      });
      if (lyr.bringToFront) lyr.bringToFront();
    });

    selectedZonePersistGroup.addLayer(selectedZonePersistLayer);

    // Selecting a zone clears all PD selections (list + map)
    clearAllPDSelection(true);
    scheduleLabelUpdate();

    // Zoom to zone
    if (zoomTo) {
      try {
        const b = selectedZonePersistLayer.getBounds && selectedZonePersistLayer.getBounds();
        if (b && b.isValid && b.isValid()) {
          map.fitBounds(b.pad(0.15));
          if (map.getZoom() < PZ_LABEL_MIN_ZOOM) map.setZoom(PZ_LABEL_MIN_ZOOM);
        }
      } catch {}
    }
  }


  function selectZone(layer) {
    if (selectedZoneLayer === layer) {
      clearZoneSelection();
      return;
    }
    if (selectedZoneLayer) selectedZoneLayer.setStyle(ZONE_BASE_STYLE);
    selectedZoneLayer = layer;
    if (selectedZoneLayer) selectedZoneLayer.setStyle(ZONE_SELECTED_STYLE);

    
    
    // Persist selection so it remains after disengaging zones
    try { if (layer && layer.feature) setPersistentZoneSelection(layer.feature, { zoomTo: false }); } catch {}
if (selectedZoneLayer && selectedZoneLayer.bringToFront) selectedZoneLayer.bringToFront();
// Selecting a zone clears all PD selections (list + map)
    clearAllPDSelection(true);

    scheduleLabelUpdate();
    updatePZLabels();
  }

  // Map from PD key -> array of zone features inside it (precomputed from properties if available)
  const zonesByKey = new Map(); // pdKey -> features
  let activeZonePDKey = null;      // PD key currently showing zones for
  let currentZonesLayer = null;    // L.GeoJSON layer for active PD


  // Export functions required by routing.js
  window.getZoneTargetsForPD = function (pdKey) {
    const feats = zonesByKey.get(String(pdKey)) || [];
    const out = [];
    for (const f of feats) {
      const c = centerOfZoneFeature(f);
      if (!c) continue;
      const label = 'Zone ' + zoneKeyFromProps(f.properties || {});
      // Try to carry a layer (optional) – routing doesn't require it, but report can use it
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

  function clearZonesView() {
    activeZonePDKey = null;
    if (currentZonesLayer) {
      try { zoneGroup.removeLayer(currentZonesLayer); } catch {}
      currentZonesLayer = null;
    }
    zoneGroup.clearLayers();
    pzLabelGroup.clearLayers();
    pzLabelMarkers.clear();
    clearZoneSelection();
  }

  function showZonesForPD(pdKey) {
    if (!zonesEngaged) return;
    clearZonesView();
    if (!zonesEngaged) return;

    const key = String(pdKey);
    activeZonePDKey = key;

    // NOTE: In zone mode, browsing zones should NOT change PD selection.

    // Rebuild the zone layer only for this PD
    zoneGroup.clearLayers();
    pzLabelGroup.clearLayers();
    pzLabelMarkers.clear();
    clearZoneSelection();

    const feats = zonesByKey.get(key) || [];
    if (!feats.length) {
      scheduleLabelUpdate();
      return;
    }

    const fc = { type: 'FeatureCollection', features: feats };

    currentZonesLayer = L.geoJSON(fc, {
      style: ZONE_BASE_STYLE,
      onEachFeature: (feature, layer) => {
        layer.on('click', () => {
          if (!zonesEngaged) return;
          selectZone(layer);
        });

        // Create a label marker for this zone (centered)
        const zKey = zoneKeyFromProps(feature.properties || {});
        const zKeySafe = (zKey && String(zKey).trim()) ? String(zKey).trim() : '?';
let c = null;
        try {
          if (layer.getBounds) c = layer.getBounds().getCenter();
        } catch {}
        if (c && !pzLabelMarkers.has(zKeySafe)) {
          const marker = L.marker(c, {
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: '',
              html: `<div class="map-label pz-label" data-pz="${encodeURIComponent(zKeySafe)}" style="font-size:${pzLabelFontSize(map.getZoom())}px">TZ ${zKeySafe}</div>`,
              iconSize: [1, 1]
            })
          }).addTo(pzLabelGroup);
          pzLabelMarkers.set(zKeySafe, marker);
        }
      }
    });

    currentZonesLayer.addTo(zoneGroup);

    // Ensure labels refresh immediately
    scheduleLabelUpdate();
    updatePZLabels();
  }



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

  // Zones control (Engage / Disengage + search)
  const ZonesControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'pd-control');
      div.dataset.role = 'zones';
      div.innerHTML = `
        <div class="pd-header"><strong>Traffic Zones</strong></div>
        <div class="zone-actions">
          <button type="button" id="zone-engage">Engage</button>
          <button type="button" id="zone-disengage" class="is-active">Disengage</button>
          <input id="zone-search" type="text" placeholder="Zone #" />
        </div>
      `;
      stopMapEvents(div);
      return div;
    }
  });
  map.addControl(new ZonesControl());

  const btnEngage = document.getElementById('zone-engage');
  const btnDisengage = document.getElementById('zone-disengage');
  const inpZoneSearch = document.getElementById('zone-search');

  function setZonesEngaged(state) {
    zonesEngaged = !!state;

    if (btnEngage) btnEngage.classList.toggle('is-active', zonesEngaged);
    if (btnDisengage) btnDisengage.classList.toggle('is-active', !zonesEngaged);

    if (zonesEngaged) {
      // Engage zone browsing mode (do NOT show zones until a PD is clicked)
      if (!map.hasLayer(zoneGroup)) zoneGroup.addTo(map);
      clearZonesView();
      scheduleLabelUpdate();
    } else {
      // Disengage: remove zones & restore PD labels behavior
      clearZonesView();
      try { map.removeLayer(zoneGroup); } catch {}
      scheduleLabelUpdate();
    }
  }

  if (btnEngage) btnEngage.addEventListener('click', () => setZonesEngaged(true));
  if (btnDisengage) btnDisengage.addEventListener('click', () => setZonesEngaged(false));

  if (inpZoneSearch) {
    inpZoneSearch.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;

      const raw = (inpZoneSearch.value || '').trim();
      if (!raw) return;

      // Accept "TZ 1006" or "1006"
      const id = (raw.match(/\d+/g) || []).join('');
      if (!id) {
        alert('Enter a zone number, e.g. 1006 or TZ 1006');
        return;
      }

      const feature = zonesById.get(String(id));
      if (!feature) {
        alert('Zone not found: ' + id);
        return;
      }

      // Ensure selection persists even if zones are disengaged
      setPersistentZoneSelection(feature, { zoomTo: true });

      // If zones are engaged, also show the PD's zones so labels appear and user can click zones.
      if (zonesEngaged) {
        const pdKey = String((feature.properties && (feature.properties.PD_no ?? feature.properties.pd_no)) ?? '');
        if (pdKey) showZonesForPD(pdKey);
      }
    });
  }

  // Load zones and build layer + labels
  fetch(ZONES_URL)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || ZONES_URL}`);
      return r.text();
    })
    .then(txt => safeJSONParse(txt, 'Zones GeoJSON'))
    .then(geojson => {
      const feats = Array.isArray(geojson.features) ? geojson.features : [];

      // Build zone entries (feature + center + key). We'll spatially assign zones to PDs
      // using zone centers (bounds center) inside PD polygons (with PD bounds prefilter).
      const zoneEntries = [];
      for (const f of feats) {
        let center = null;
        try {
          const tmp = L.geoJSON(f);
          const layers = tmp.getLayers ? tmp.getLayers() : [];
          const layer0 = layers[0];
          center = (layer0 && layer0.getBounds) ? layer0.getBounds().getCenter() : null;
        } catch {}
        if (!center) continue;

        const zKey = zoneKeyFromProps(f.properties || {});
        zoneEntries.push({ feature: f, center: [center.lng, center.lat], zKey });
        try { zonesById.set(String(zKey), f); } catch {}
      }

      // Wait for PDs to be loaded, then build index (PD key -> zone features)
      (function waitForPDThenIndex() {
        if (Object.keys(PD_REGISTRY).length) {
          buildZonesByPD(zoneEntries);
          console.log('Zones loaded:', zoneEntries.length);
          scheduleLabelUpdate();
        } else {
          setTimeout(waitForPDThenIndex, 120);
        }
      })();
    })
    .catch(err => {
      console.error('Failed to load zones:', err);
      // Zones are optional; don't block the rest of the app
    });

  // --------------------- Address search (geocoder) ---------------------
  const geocoder = L.Control.geocoder({
    position: 'topleft',
    defaultMarkGeocode: false,
    placeholder: 'Search...'
  }).on('markgeocode', function (e) {
    const ll = e.geocode && e.geocode.center;
    const name = (e.geocode && e.geocode.name) ? e.geocode.name : 'Origin';

    if (!ll) return;
    map.setView(ll, Math.max(map.getZoom(), 13));

    // Store origin in the format routing.js understands
    // Keep a marker so user sees it.
    if (window._originMarker) {
      try { map.removeLayer(window._originMarker); } catch {}
    }
    window._originMarker = L.marker(ll).addTo(map).bindPopup(name);
    window.ROUTING_ORIGIN = window._originMarker;
    window.ROUTING_ORIGIN.label = name;

  }).addTo(map);

  // Put geocoder at top-left, and stop it from affecting map scroll while hovered
  try {
    const el = geocoder.getContainer ? geocoder.getContainer() : document.querySelector('.leaflet-control-geocoder');
    stopMapEvents(el);
  } catch {}

  // --------------------- Control ordering (search, PD, zones, trips, report) ---------------------
  function tryReorder() {
    const container = document.querySelector('.leaflet-top.leaflet-left');
    if (!container) return false;

    const geocoderEl = container.querySelector('.leaflet-control-geocoder');
    const pdCtl      = container.querySelector('.pd-control[data-role="pd"]');
    const tzCtl      = container.querySelector('.pd-control[data-role="zones"]');
    const tripCtl    = container.querySelector('.routing-control');
    const repCtl     = container.querySelector('.report-control');

    if (!geocoderEl || !pdCtl || !tzCtl || !tripCtl || !repCtl) return false;

    container.appendChild(geocoderEl);
    container.appendChild(pdCtl);
    container.appendChild(tzCtl);
    container.appendChild(tripCtl);
    container.appendChild(repCtl);
    return true;
  }

  (function reorderLoop() {
    if (tryReorder()) return;
    setTimeout(reorderLoop, 120);
  })();
})();
