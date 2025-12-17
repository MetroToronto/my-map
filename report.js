(function (global) {

  /**************************************************************
   * Report.js
   * - Builds a new-tab report using window.ROUTING_CACHE only
   * - Street-by-street extraction and merging logic
   **************************************************************/

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cleanHtml(str) {
    return String(str || '').replace(/<[^>]*>/g, '').trim();
  }

  function fmtKm(km) {
    const n = Number(km);
    if (!Number.isFinite(n)) return '';
    return n.toFixed(2);
  }

  function fmtMin(min) {
    const n = Number(min);
    if (!Number.isFinite(n)) return '';
    return Math.round(n).toString();
  }

  // --- Direction helpers ---
  function bearingDeg(a, b) {
    const toRad = (x) => x * Math.PI / 180;
    const toDeg = (x) => x * 180 / Math.PI;

    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const dLng = toRad(b[0] - a[0]);

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const brng = Math.atan2(y, x);
    return (toDeg(brng) + 360) % 360;
  }

  function dirFromBearing(brng) {
    // 0=N, 90=E, 180=S, 270=W
    if (brng >= 315 || brng < 45) return 'NB';
    if (brng >= 45 && brng < 135) return 'EB';
    if (brng >= 135 && brng < 225) return 'SB';
    return 'WB';
  }

  function distanceMeters(a, b) {
    const R = 6371000;
    const toRad = (x) => x * Math.PI / 180;
    const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);

    const s1 = Math.sin(dLat / 2);
    const s2 = Math.sin(dLng / 2);
    const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function measurePolylineMeters(coords) {
    let m = 0;
    for (let i = 1; i < coords.length; i++) {
      m += distanceMeters(coords[i - 1], coords[i]);
    }
    return m;
  }

  function pointAtDistance(coords, distMeters) {
    // returns index+fraction interpolation point at approx cumulative distance along polyline
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const seg = distanceMeters(coords[i - 1], coords[i]);
      if (acc + seg >= distMeters) {
        const t = (distMeters - acc) / Math.max(1e-9, seg);
        const x = coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t;
        const y = coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t;
        return [x, y];
      }
      acc += seg;
    }
    return coords[coords.length - 1];
  }

  function averageBearingOverWindow(coords, startM, endM, samples) {
    const s = Math.max(0, startM);
    const e = Math.max(s, endM);
    const n = Math.max(2, samples || 3);

    let sumX = 0;
    let sumY = 0;

    for (let i = 0; i < n; i++) {
      const t1 = s + (e - s) * (i / n);
      const t2 = s + (e - s) * ((i + 1) / n);
      const p1 = pointAtDistance(coords, t1);
      const p2 = pointAtDistance(coords, t2);
      const br = bearingDeg(p1, p2);
      const rad = br * Math.PI / 180;
      sumX += Math.cos(rad);
      sumY += Math.sin(rad);
    }

    const avg = Math.atan2(sumY, sumX) * 180 / Math.PI;
    return (avg + 360) % 360;
  }

  // --- Street name cleanup ---
  function cleanStreetName(name) {
    let s = String(name || '').trim();
    if (!s) return '';
    // remove "Route" prefix if present
    s = s.replace(/^Route:\s*/i, '');

    // drop trailing ", 55" style for streets (but keep HIGHWAY numbers)
    if (!/HIGHWAY\s+\d+/i.test(s)) {
      s = s.replace(/,\s*\d+\s*$/g, '');
    }
    return s.trim();
  }

  // --- Highway naming via centerlines dataset ---
  let highwayData = null;
  async function loadHighwayDataOnce() {
    if (highwayData) return highwayData;
    try {
      const res = await fetch('data/highway_centrelines.json');
      highwayData = await res.json();
      return highwayData;
    } catch (e) {
      console.warn('Could not load highway_centrelines.json', e);
      highwayData = null;
      return null;
    }
  }

  function closestHighwayName(ptLngLat, data) {
    if (!data || !data.features || !data.features.length) return '';
    let best = null;
    let bestD = Infinity;

    for (const f of data.features) {
      const name = f && f.properties && (f.properties.Name || f.properties.name);
      const geom = f && f.geometry;
      if (!name || !geom) continue;

      const coords = geom.coordinates;
      if (!coords) continue;

      // handle LineString and MultiLineString
      const lines = (geom.type === 'MultiLineString') ? coords : [coords];

      for (const line of lines) {
        for (let i = 0; i < line.length; i++) {
          const p = line[i];
          const d = distanceMeters(ptLngLat, p);
          if (d < bestD) {
            bestD = d;
            best = name;
          }
        }
      }
    }
    // only accept within ~120m
    if (bestD <= 120) return String(best).trim();
    return '';
  }

  // --- Extract street-by-street from ORS GeoJSON ---
  async function extractStreetMoves(routeFeatureCollection) {
    const hw = await loadHighwayDataOnce();

    // ORS route is stored as FeatureCollection with one Feature
    const feature = routeFeatureCollection && routeFeatureCollection.features && routeFeatureCollection.features[0];
    const props = feature && feature.properties;
    const segments = props && props.segments;

    const geom = feature && feature.geometry;
    const coords = geom && geom.coordinates;

    if (!segments || !segments.length || !coords || coords.length < 2) {
      return { moves: [], totalKm: 0, totalMin: 0 };
    }

    // total
    const summary = props && props.summary;
    const totalKm = summary && Number.isFinite(summary.distance) ? summary.distance : 0;
    const totalMin = summary && Number.isFinite(summary.duration) ? summary.duration / 60 : 0;

    const moves = [];

    // ORS step "way_points" indexes into geometry coords
    segments.forEach(seg => {
      (seg.steps || []).forEach(step => {
        const stepNameRaw = (step.name || '').trim();
        const wp = step.way_points || [];
        const i0 = wp[0], i1 = wp[1];

        if (typeof i0 !== 'number' || typeof i1 !== 'number' || i1 <= i0) return;

        const segCoords = coords.slice(i0, i1 + 1);
        if (!segCoords || segCoords.length < 2) return;

        let name = cleanStreetName(stepNameRaw);

        // If unnamed and looks like highway, try snap to centerlines
        if (!name || name === '-' || /^Unnamed/i.test(name)) {
          const mid = pointAtDistance(segCoords, measurePolylineMeters(segCoords) / 2);
          const hwName = closestHighwayName(mid, hw);
          if (hwName) name = hwName;
        }

        // distance for this step (km)
        const stepKm = Number.isFinite(step.distance) ? (step.distance / 1000) : (measurePolylineMeters(segCoords) / 1000);

        // direction per step:
        const lenM = measurePolylineMeters(segCoords);

        // window rule: long segments sample 200m-500m, short segments 20-50m
        let startM = 200, endM = 500, samples = 4;

        if (lenM < 200) {
          startM = Math.min(20, lenM * 0.2);
          endM   = Math.min(50, lenM * 0.6);
          samples = 3;
        } else if (lenM < 600) {
          startM = 100;
          endM   = Math.min(300, lenM * 0.7);
          samples = 4;
        }

        const avgBr = averageBearingOverWindow(segCoords, startM, endM, samples);
        const dir = dirFromBearing(avgBr);

        moves.push({ dir, name: name || 'Unnamed', km: stepKm });
      });
    });

    // merge consecutive duplicates
    const merged = [];
    for (const m of moves) {
      const prev = merged[merged.length - 1];

      // normalize for highways: direction-insensitive merge for HIGHWAY & Gardiner patterns
      const isHighway = /HIGHWAY\s+\d+/i.test(m.name) || /GARDINER/i.test(m.name) || /EXPRESSWAY/i.test(m.name);

      const sameName = prev && (prev.name === m.name);
      const sameDir  = prev && (prev.dir === m.dir);

      if (prev && sameName && (sameDir || isHighway)) {
        prev.km += m.km;
      } else {
        merged.push({ ...m });
      }
    }

    return { moves: merged, totalKm, totalMin };
  }

  // --- Build report HTML ---
  function buildReportHtml(cache) {
    const kindLabel = cache.kind === 'pd' ? 'Planning Districts' : 'Traffic Zones';

    const originLabel = cleanHtml(cache.origin && cache.origin.label ? cache.origin.label : '');
    const title = `Trip Route Distribution for ${escapeHtml(originLabel)} to ${kindLabel}`;

    const reverse = !!cache.reverse;

    // Build tables
    const rowsHtml = cache.items.map(item => {
      const key = item.key;
      const name = item.name || key;
      const muni = item.muni || '';
      const destLabel =
        cache.kind === 'pd'
          ? `PD ${escapeHtml(key)}${muni ? `, ${escapeHtml(muni)}` : ''}`
          : `Zone ${escapeHtml(key)}${muni ? `, ${escapeHtml(muni)}` : ''}`;

      const fromLine = reverse ? `From: ${escapeHtml(destLabel)}` : `From: ${escapeHtml(originLabel)}`;
      const toLine   = reverse ? `To: ${escapeHtml(originLabel)}`   : `To: ${escapeHtml(destLabel)}`;

      // Use first route as the "primary" (alt index 0)
      const primary = (item.routes || []).find(r => r.alternativesIndex === 0) || (item.routes || [])[0];

      return `
        <section class="dest-block">
          <h2>${escapeHtml(name)}</h2>
          <div class="meta">${fromLine}<br>${toLine}</div>
          <table class="report-table" data-key="${escapeHtml(key)}" data-muni="${escapeHtml(muni)}">
            <thead>
              <tr>
                <th>Trip dir</th>
                <th>Street-by-street</th>
                <th>Total km</th>
                <th>Total min</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="tripdir">${escapeHtml(item.tripDir || '')}</td>
                <td class="streets" data-has-km="1">(building…)</td>
                <td class="totalkm"></td>
                <td class="totalmin"></td>
              </tr>
            </tbody>
          </table>
          <div class="alt-note">${(item.routes && item.routes.length > 1) ? `Includes ${item.routes.length} route alternatives (primary shown).` : ''}</div>
          <script type="application/json" class="route-json">${escapeHtml(JSON.stringify(primary && primary.geojson ? primary.geojson : null))}</script>
        </section>
      `;
    }).join('\n');

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 18px; }
    h1 { font-size: 20px; margin: 0 0 10px 0; }
    .topbar { display:flex; gap:10px; align-items:center; margin-bottom: 14px; }
    button { padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
    button:hover { background: #f7f7f7; }
    .dest-block { margin: 18px 0 22px 0; padding-top: 8px; border-top: 1px solid #ddd; }
    .dest-block h2 { font-size: 16px; margin: 0 0 6px 0; }
    .meta { font-size: 12.5px; color:#333; margin-bottom: 8px; }
    .report-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .report-table th, .report-table td { border:1px solid #ddd; padding: 8px; vertical-align: top; font-size: 12.5px; }
    .report-table th { background:#f5f5f5; }
    .report-table td.tripdir { width: 60px; text-align:center; font-weight:700; }
    .report-table td.totalkm, .report-table td.totalmin { width: 80px; text-align:right; font-variant-numeric: tabular-nums; }
    .alt-note { font-size: 12px; opacity: 0.85; margin-top: 6px; }
    .streets { word-wrap: break-word; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="topbar">
    <button id="btn-toggle-km" type="button">Toggle segment km</button>
    <button id="btn-copy" type="button">Copy to spreadsheet</button>
    <button id="btn-print" type="button">Print</button>
  </div>

  ${rowsHtml}

  <script>
    const cacheKind = ${JSON.stringify(cache.kind)};
    const showKmState = { enabled: true };

    function formatMoves(moves, includeKm) {
      return moves.map(m => {
        const base = (m.dir ? m.dir + ' ' : '') + (m.name || 'Unnamed');
        if (!includeKm) return base;
        return base + ' (' + (Number(m.km).toFixed(2)) + ' km)';
      }).join(', ');
    }

    async function hydrateTables() {
      const blocks = document.querySelectorAll('section.dest-block');
      for (const blk of blocks) {
        const tbl = blk.querySelector('table.report-table');
        const jsonEl = blk.querySelector('script.route-json');
        if (!tbl || !jsonEl) continue;

        let geo = null;
        try { geo = JSON.parse(jsonEl.textContent || 'null'); } catch(e) {}

        if (!geo) {
          tbl.querySelector('.streets').textContent = '';
          continue;
        }

        const payload = await window._extractStreetMoves(geo);
        tbl.querySelector('.streets').textContent = formatMoves(payload.moves, showKmState.enabled);
        tbl.querySelector('.totalkm').textContent = (Number(payload.totalKm).toFixed(2));
        tbl.querySelector('.totalmin').textContent = (Math.round(payload.totalMin));
      }
    }

    function buildClipboardTSV() {
      const tables = document.querySelectorAll('table.report-table');
      const lines = [];
      lines.push(['Key','Municipality','Trip dir','Street-by-street','Total km','Total min'].join('\\t'));

      tables.forEach(tbl => {
        const key = tbl.getAttribute('data-key') || '';
        const muni = tbl.getAttribute('data-muni') || '';
        const tripdir = (tbl.querySelector('.tripdir')?.textContent || '').trim();
        const streets = (tbl.querySelector('.streets')?.textContent || '').trim();
        const km = (tbl.querySelector('.totalkm')?.textContent || '').trim();
        const min = (tbl.querySelector('.totalmin')?.textContent || '').trim();
        lines.push([key, muni, tripdir, streets, km, min].join('\\t'));
      });

      return lines.join('\\n');
    }

    document.getElementById('btn-toggle-km')?.addEventListener('click', () => {
      showKmState.enabled = !showKmState.enabled;
      hydrateTables();
    });

    document.getElementById('btn-copy')?.addEventListener('click', async () => {
      const tsv = buildClipboardTSV();
      try {
        await navigator.clipboard.writeText(tsv);
        alert('Copied table to clipboard.');
      } catch(e) {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = tsv;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        alert('Copied table to clipboard.');
      }
    });

    document.getElementById('btn-print')?.addEventListener('click', () => window.print());
  </script>
</body>
</html>
    `;
    return html;
  }

  async function printReport() {
    const cache = global.ROUTING_CACHE;
    if (!cache || !cache.items || !cache.items.length) {
      alert('No generated trips found. Generate trips first.');
      return;
    }

    const html = buildReportHtml(cache);
    const win = window.open('', '_blank');
    if (!win) {
      alert('Popup blocked. Please allow popups for this site.');
      return;
    }

    // expose extractor into the new window
    win._extractStreetMoves = extractStreetMoves;

    win.document.open();
    win.document.write(html);
    win.document.close();

    // hydrate after load
    setTimeout(() => {
      try { win.document.querySelector('script'); } catch(e) {}
      try { win.eval('hydrateTables && hydrateTables()'); } catch(e) {}
    }, 200);
  }

  /**************************************************************
   * Leaflet Control (one-button compact)
   **************************************************************/
  const ReportControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'report-control');
      div.innerHTML = `
        <div class="routing-row">
          <button type="button" id="rt-print-report">Print Report</button>
        </div>
      `;
      const btn = div.querySelector('#rt-print-report');
      if (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          printReport();
        });
      }

      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    }
  });

  function initWhenReady() {
    if (global.L && global.map) {
      try {
        global.map.addControl(new ReportControl());
      } catch (e) {
        console.error('Failed to add Report control:', e);
      }
    } else {
      setTimeout(initWhenReady, 80);
    }
  }

  global.Report = { print: printReport };

  document.addEventListener('DOMContentLoaded', function () {
    initWhenReady();
  });

})(window);
