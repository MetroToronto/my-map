(function (global) {
  'use strict';

  // ===== Basic geo helpers =====
  function toRad(d) { return d * Math.PI / 180; }
  function isFiniteNum(n) { return Number.isFinite(n) && !Number.isNaN(n); }

  function haversineMeters(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const R = 6371000; // metres
    const lon1 = toRad(a[0]), lat1 = toRad(a[1]);
    const lon2 = toRad(b[0]), lat2 = toRad(b[1]);
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    const sa = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
    return R * c;
  }

  function bearingDeg(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const lon1 = toRad(a[0]), lat1 = toRad(a[1]);
    const lon2 = toRad(b[0]), lat2 = toRad(b[1]);
    const dLon = lon2 - lon1;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.cos(lat2) -
              Math.sin(lat1) * Math.sin(lat2) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    if (!isFiniteNum(brng)) return 0;
    brng = (brng + 360) % 360;
    return brng;
  }

  function boundFrom(deg) {
    if (deg >= 315 || deg < 45) return 'NB';
    if (deg >= 45 && deg < 135) return 'EB';
    if (deg >= 135 && deg < 225) return 'SB';
    return 'WB';
  }

  function km2(v) {
    return (v || 0).toFixed(2);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cleanHtml(s) {
    return String(s || '').replace(/<[^>]*>/g, '').trim();
  }

  function normalizeName(raw) {
    if (!raw) return '';
    const s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s || /^unnamed\b/i.test(s) || /^[-–]+$/.test(s)) return '';
    return s;
  }

  // ===== Highway centreline support =====
  let HIGHWAYS = null;
  let HIGHWAYS_PROMISE = null;

  async function loadHighways() {
    if (HIGHWAYS !== null) return HIGHWAYS;
    if (HIGHWAYS_PROMISE) return HIGHWAYS_PROMISE;

    const candidates = [
      'data/highway_centerlines.json',
      'data/highway_centrelines.json',
      'data/highway_centreline.json'
    ];

    HIGHWAYS_PROMISE = (async () => {
      for (const path of candidates) {
        try {
          const res = await fetch(path);
          if (!res.ok) continue;
          const json = await res.json();
          const feats = Array.isArray(json.features) ? json.features : [];
          HIGHWAYS = feats;
          return HIGHWAYS;
        } catch (e) {
          // try next candidate
        }
      }
      HIGHWAYS = [];
      return HIGHWAYS;
    })();

    return HIGHWAYS_PROMISE;
  }

  function nearestHighwayName(lon, lat) {
    if (!HIGHWAYS || !HIGHWAYS.length) return '';

    let bestName = '';
    let bestDist2 = Infinity;

    for (const f of HIGHWAYS) {
      if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) continue;
      const coords = f.geometry.coordinates;
      const props = f.properties || {};
      const candName = normalizeName(props.Name || props.name);
      if (!candName) continue;

      for (const c of coords) {
        if (!Array.isArray(c) || c.length < 2) continue;
        const dx = c[0] - lon;
        const dy = c[1] - lat;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestName = candName;
        }
      }
    }

    // Only accept if reasonably near (~1 km in degree-space rough units)
    const MAX_DEG2 = 0.01 * 0.01;
    if (bestName && bestDist2 <= MAX_DEG2) return bestName;
    return '';
  }

  // Prefer ORS step.name / road; otherwise try to parse a road from instruction
  // (e.g. "Turn left onto Queen St W"). We *don't* return generic phrases
  // like "Keep left" anymore.
  function stepNameNatural(step) {
    if (!step) return '';
    const primary = normalizeName(step.name || step.road);
    if (primary) return primary;

    const instr = cleanHtml(step.instruction || '');
    if (!instr) return '';

    // Look for "onto NAME", "on NAME", or "via NAME".
    let m = instr.match(/\bonto\s+([^,]+?)(?=\s+for\b|,|$)/i);
    if (!m) m = instr.match(/\bon\s+([^,]+?)(?=\s+for\b|,|$)/i);
    if (!m) m = instr.match(/\bvia\s+([^,]+?)(?=\s+for\b|,|$)/i);
    if (!m) return '';
    return normalizeName(m[1]);
  }

  function mergeConsecutive(movs) {
    const out = [];
    for (const m of movs) {
      if (!m) continue;
      if (!m.name || !m.km || m.km <= 0) continue;
      if (out.length) {
        const last = out[out.length - 1];
        if (last.name === m.name && last.dir === m.dir) {
          last.km += m.km;
          continue;
        }
      }
      out.push({ dir: m.dir, name: m.name, km: m.km });
    }
    return out;
  }

  function extractStepsFromFeature(feature) {
    if (!feature || !feature.properties) return [];
    const props = feature.properties;
    if (Array.isArray(props.steps) && props.steps.length) return props.steps;
    const segments = Array.isArray(props.segments) ? props.segments : [];
    const out = [];
    for (const seg of segments) {
      if (seg && Array.isArray(seg.steps)) out.push(...seg.steps);
    }
    return out;
  }

  /**
   * Build NB/EB/SB/WB street movements for a route.
   * - Uses ORS step.distance for segment length.
   * - Uses step.name OR parsed road from instruction.
   * - Falls back to nearest highway for unnamed segments.
   */
  function buildMovementsFromDirections(coords, steps) {
    if (!coords || !coords.length || !steps || !steps.length) return [];

    const MIN_SEG_KM = 0.03; // drop < 30 m
    const lastIdx = coords.length - 1;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    const result = [];

    for (const step of steps) {
      if (!step) continue;

      let km = Number(step.distance) / 1000;
      if (!isFiniteNum(km) || km <= 0) {
        km = 0;
        const wp = step.way_points || step.wayPoints || [];
        const a = wp[0] ?? 0;
        const b = wp[1] ?? lastIdx;
        const startIdx = clamp(a, 0, lastIdx);
        const endIdx   = clamp(b, startIdx, lastIdx);
        for (let i = startIdx + 1; i <= endIdx; i++) {
          km += haversineMeters(coords[i - 1], coords[i]) / 1000;
        }
      }
      if (!isFiniteNum(km) || km < MIN_SEG_KM) continue;

      const wp = step.way_points || step.wayPoints || [];
      let sIdx = clamp(wp[0] ?? 0, 0, lastIdx);
      let eIdx = clamp(wp[1] ?? lastIdx, sIdx, lastIdx);
      if (eIdx === sIdx && eIdx < lastIdx) eIdx = sIdx + 1;

      let bearing = 0;
      let found = false;
      for (let i = eIdx; i > sIdx; i--) {
        const bDeg = bearingDeg(coords[i - 1], coords[i]);
        if (isFiniteNum(bDeg)) {
          bearing = bDeg;
          found = true;
          break;
        }
      }
      if (!found) bearing = bearingDeg(coords[sIdx], coords[eIdx]);
      const dir = boundFrom(bearing);

      let name = stepNameNatural(step);

      if (!name || name === 'Unnamed segment') {
        const midIdx = Math.floor((sIdx + eIdx) / 2);
        const mid = coords[midIdx] || coords[sIdx] || coords[eIdx];
        if (mid && mid.length >= 2) {
          const hName = nearestHighwayName(mid[0], mid[1]);
          if (hName) name = hName;
        }
      }

      if (!name) name = 'Unnamed segment';

      result.push({ dir, name, km });
    }

    return mergeConsecutive(result);
  }

  // Turn movements into text like "WB Queen St W; NB Spadina Rd; ..."
  function movementsToText(movs) {
    return movs.map(m => `${m.dir} ${m.name}`).join('; ');
  }

  // Split zone labels into city + numeric id, if possible
  function splitZoneLabel(label) {
    if (!label) return { name: '', id: '' };
    const s = String(label);
    const m = s.match(/(\d+)/);
    if (!m) return { name: s.trim(), id: '' };
    const id = m[1];
    const name = s.replace(m[0], '').replace(/[-#:]/, '').trim() || s.trim();
    return { name, id };
  }

  // ===== Convert a single trip into HTML + CSV row =====
  function buildTripHtmlAndRow(trip) {
    const features = Array.isArray(trip.features) ? trip.features : [];
    if (!features.length) return null;

    const isPD = trip.type === 'PD';
    const title = isPD
      ? (trip.name || trip.key || 'Planning District')
      : (trip.label || 'Planning Zone');

    const originLabel = trip.origin && (trip.origin.label ||
      `${trip.origin.lon}, ${trip.origin.lat}`) || '';
    const destLabel = trip.destination && (trip.destination.label ||
      `${trip.destination.lon}, ${trip.destination.lat}`) || '';
    const dirLabel = trip.reverse ? 'Destination → Origin' : 'Origin → Destination';

    const routeHtmlPieces = [];
    const perRouteTexts = [];

    features.forEach((feat, idx) => {
      const coords = feat.geometry && Array.isArray(feat.geometry.coordinates)
        ? feat.geometry.coordinates
        : [];
      const steps  = extractStepsFromFeature(feat);
      const movs   = buildMovementsFromDirections(coords, steps);

      const props   = feat.properties || {};
      const summary = props.summary ||
                      (Array.isArray(props.segments) && props.segments[0]) ||
                      {};
      const distKm = Number(summary.distance) / 1000;
      const durMin = Number(summary.duration) / 60;

      const routeLabel =
        features.length === 1
          ? 'Route'
          : (idx === 0 ? 'Route 1 (fastest)' : `Route ${idx + 1}`);

      const metaPieces = [];
      if (isFiniteNum(distKm)) metaPieces.push(`${km2(distKm)} km`);
      if (isFiniteNum(durMin)) metaPieces.push(`${durMin.toFixed(1)} min`);
      const meta = metaPieces.length ? metaPieces.join(' · ') : '';

      let directionsText = '';
      if (movs.length) {
        directionsText = movementsToText(movs);
      } else {
        directionsText = '(No named street segments found for this route.)';
      }

      routeHtmlPieces.push(`
        <h3>${escapeHtml(routeLabel)}</h3>
        ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}
        <table>
          <thead>
            <tr><th style="width:90px;">Route</th><th>Street-by-street</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>${escapeHtml(routeLabel)}</td>
              <td>${escapeHtml(directionsText)}</td>
            </tr>
          </tbody>
        </table>
      `);

      perRouteTexts.push(directionsText);
    });

    if (!routeHtmlPieces.length) {
      // still show card with a note
      routeHtmlPieces.push('<p class="meta">(No route details available.)</p>');
    }

    const metaLine = originLabel && destLabel
      ? `${originLabel} → ${destLabel} (${dirLabel})`
      : '';

    // CSV row data
    let name, id;
    if (isPD) {
      name = trip.name || trip.key || 'Planning District';
      id   = trip.key || '';
    } else {
      const sp = splitZoneLabel(trip.label || '');
      name = sp.name || trip.label || 'Planning Zone';
      id   = sp.id;
    }

    const directionsForCsv = perRouteTexts.map((txt, i) => {
      if (perRouteTexts.length === 1) return txt;
      return `Route ${i + 1}: ${txt}`;
    }).join(' | ');

    const cardHtml = `
      <div class="card">
        <h2>${escapeHtml(title)}</h2>
        ${metaLine ? `<p class="meta">${escapeHtml(metaLine)}</p>` : ''}
        ${routeHtmlPieces.join('')}
      </div>
    `;

    return {
      html: cardHtml,
      csvRow: { name, id, directions: directionsForCsv }
    };
  }

  function buildReport(cache) {
    if (!cache || !Array.isArray(cache.trips) || !cache.trips.length) {
      return { html: '', rows: [] };
    }

    const cards = [];
    const rows  = [];

    cache.trips.forEach(trip => {
      const built = buildTripHtmlAndRow(trip);
      if (!built) return;
      cards.push(built.html);
      rows.push(built.csvRow);
    });

    return { html: cards.join(''), rows };
  }

  // ===== Main print / open-tab logic =====

  async function buildReportWindow(targetWindow) {
    const cache = global.ROUTING_CACHE;
    if (!cache || !cache.trips || !cache.trips.length) {
      targetWindow.document.write('<p>No trips available.</p>');
      targetWindow.document.close();
      alert('No trips available. Please generate trips first.');
      return;
    }

    // preload highway data so unnamed segments can snap to it
    await loadHighways();

    const { html: cardsHtml, rows } = buildReport(cache);
    if (!cardsHtml) {
      targetWindow.document.write('<p>Unable to build report. Trip data is missing or incomplete.</p>');
      targetWindow.document.close();
      alert('Unable to build report. Trip data is missing or incomplete.');
      return;
    }

    const originObj = global.ROUTING_ORIGIN || {};
    const originLabel =
      originObj.label ||
      originObj.name ||
      originObj.address ||
      originObj.query ||
      'selected origin';

    const now   = new Date();
    const dtStr = now.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    const reverse = !!cache.reverse;
    const directionLine = reverse
      ? 'Direction: PD/PZ → Origin'
      : 'Direction: Origin → PD/PZ';

    const pageTitle = `Trip Route Distribution for ${originLabel}`;

    const css = `
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 16px 20px 32px 20px;
          font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI",
                Roboto, Helvetica, Arial, sans-serif;
          background: #fafafa;
        }
        h1 {
          font-size: 20px;
          margin: 0 0 8px 0;
        }
        h2 {
          font-size: 16px;
          margin: 14px 0 6px 0;
        }
        h3 {
          font-size: 14px;
          margin: 10px 0 4px 0;
        }
        p.meta {
          margin: 0 0 8px 0;
          font-size: 12px;
          color: #555;
        }
        .top-bar {
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 1px solid #ddd;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .top-bar-buttons {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        button {
          border-radius: 999px;
          border: 1px solid #ccc;
          padding: 6px 14px;
          background: #fff;
          cursor: pointer;
          font-size: 13px;
        }
        button:hover {
          background: #f3f3f3;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 16px;
          background: #fff;
        }
        th, td {
          border: 1px solid #ddd;
          padding: 6px 8px;
          font-size: 12px;
          vertical-align: top;
        }
        thead th {
          background: #f7f7f7;
        }
        .card {
          page-break-inside: avoid;
          margin-bottom: 22px;
          padding: 10px 12px 12px 12px;
          border-radius: 8px;
          background: #fff;
          box-shadow: 0 1px 3px rgba(0,0,0,0.06);
        }
      </style>
    `;

    const doc = targetWindow.document;
    doc.open();
    doc.write(
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>' + escapeHtml(pageTitle) + '</title>' +
      css +
      '</head><body>' +
      '<div class="top-bar">' +
        '<div>' +
          '<h1>' + escapeHtml(pageTitle) + '</h1>' +
          '<p class="meta">' + escapeHtml(dtStr) + ' · ' +
            escapeHtml(directionLine) + '</p>' +
        '</div>' +
        '<div class="top-bar-buttons">' +
          '<button id="copy-csv">Copy to spreadsheet</button>' +
          '<button id="print-page">Print page</button>' +
        '</div>' +
      '</div>' +
      cardsHtml +
      '<script>' +
        'window.__REPORT_ROWS__ = ' + JSON.stringify(rows) + ';' +
        '(function(){' +
          'function toCsv(rows){' +
            'var lines = ["Name,ID,Directions"];' +
            'rows.forEach(function(r){' +
              'var cells = [r.name, r.id, r.directions].map(function(v){' +
                'v = v == null ? "" : String(v);' +
                'return "\\""+ v.replace(/"/g, "\\"\\"") +"\\"";' +
              '});' +
              'lines.push(cells.join(","));' +
            '});' +
            'return lines.join("\\n");' +
          '}' +
          'var btn = document.getElementById("copy-csv");' +
          'if (btn){' +
            'btn.addEventListener("click", function(){' +
              'var rows = window.__REPORT_ROWS__ || [];' +
              'var csv = toCsv(rows);' +
              'if (navigator.clipboard && navigator.clipboard.writeText){' +
                'navigator.clipboard.writeText(csv).then(function(){' +
                  'alert("Copied to clipboard as CSV. Paste into Excel or Sheets.");' +
                '}, function(){' +
                  'alert("Unable to write to clipboard.");' +
                '});' +
              '} else {' +
                'var ta = document.createElement("textarea");' +
                'ta.style.position = "fixed";' +
                'ta.style.top = "0"; ta.style.left = "0";' +
                'ta.style.width = "1px"; ta.style.height = "1px";' +
                'ta.value = csv;' +
                'document.body.appendChild(ta);' +
                'ta.focus(); ta.select();' +
                'try { document.execCommand("copy"); alert("Copied to clipboard as CSV. Paste into Excel or Sheets."); }' +
                'catch(e) { alert("Unable to copy CSV."); }' +
                'document.body.removeChild(ta);' +
              '}' +
            '});' +
          '}' +
          'var pb = document.getElementById("print-page");' +
          'if (pb){ pb.addEventListener("click", function(){ window.print(); }); }' +
        '})();' +
      '<\/script>' +
      '</body></html>'
    );
    doc.close();
  }

  function openReportTab() {
    const cache = global.ROUTING_CACHE;
    if (!cache || !cache.trips || !cache.trips.length) {
      alert('No trips available. Please generate trips first.');
      return;
    }

    const w = window.open('', '_blank');
    if (!w) {
      alert('Popup blocked. Please allow popups for this site to open the report.');
      return;
    }

    buildReportWindow(w).catch(function (e) {
      console.error('Report build failed:', e);
      try {
        w.document.write('<p>Failed to build report.</p>');
        w.document.close();
      } catch {}
      alert('Failed to build report: ' + (e && e.message ? e.message : e));
    });
  }

  // ===== Leaflet Report control =====
  const ReportControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'report-control');
      div.innerHTML = `
        <div class="routing-header"><strong>Report</strong></div>
        <div class="routing-row">
          <button type="button" id="rt-print-report">Print Report</button>
        </div>
        <small style="font-size:11px;color:#555;display:block;margin-top:6px;">
          Opens a new tab using the most recently generated trips from the Trip Generator.
        </small>
      `;
      const btn = div.querySelector('#rt-print-report');
      if (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openReportTab();
        });
      }
      L.DomEvent.disableClickPropagation(div);
      return div;
    }
  });

  function initWhenReady() {
    if (global.map && (global.map._loaded || global.map._size)) {
      try {
        global.map.addControl(new ReportControl());
      } catch (e) {
        console.error('Failed to add Report control:', e);
      }
    } else {
      setTimeout(initWhenReady, 80);
    }
  }

  // Public hook if you ever want to open programmatically
  global.Report = {
    open: openReportTab,
    print: openReportTab
  };

  document.addEventListener('DOMContentLoaded', function () {
    initWhenReady();
  });

})(window);
