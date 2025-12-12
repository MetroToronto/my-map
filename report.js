(function (global) {
  'use strict';

  /******************************************************************
   * Basic helpers
   ******************************************************************/
  function toRad(d) { return d * Math.PI / 180; }

  function isFiniteNum(n) {
    return Number.isFinite(n) && !Number.isNaN(n);
  }

  function haversineMeters(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const R = 6371000; // m
    const lon1 = toRad(a[0]), lat1 = toRad(a[1]);
    const lon2 = toRad(b[0]), lat2 = toRad(b[1]);
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    const sa = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
    return R * c;
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

  /******************************************************************
   * Highway centreline support
   ******************************************************************/
  let HIGHWAYS = null;
  let HIGHWAYS_PROMISE = null;

  async function ensureHighwaysLoaded() {
    if (HIGHWAYS !== null) return;
    if (!HIGHWAYS_PROMISE) {
      const candidates = [
        'data/highway_centrelines.json',   // your file
        'data/highway_centerlines.json',
        'data/highway_centreline.json'
      ];
      HIGHWAYS_PROMISE = (async () => {
        for (const path of candidates) {
          try {
            const res = await fetch(path);
            if (!res.ok) continue;
            const json = await res.json();
            HIGHWAYS = Array.isArray(json.features) ? json.features : [];
            return;
          } catch (e) {
            // try next
          }
        }
        HIGHWAYS = [];
      })();
    }
    await HIGHWAYS_PROMISE;
  }

  function nearestHighwayName(lon, lat) {
    if (!HIGHWAYS || !HIGHWAYS.length) return '';

    let bestName = '';
    let bestD2 = Infinity;

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
        if (d2 < bestD2) {
          bestD2 = d2;
          bestName = candName;
        }
      }
    }

    // Require being reasonably close (~500 m in rough degree units)
    const MAX_DEG2 = 0.005 * 0.005;
    if (bestName && bestD2 <= MAX_DEG2) return bestName;
    return '';
  }

  /******************************************************************
   * Direction + street-name helpers
   ******************************************************************/
  // Axis-based N/E/S/W from two lon/lat points
  function axisCardinal(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return '';
    const dLon = b[0] - a[0];
    const dLat = b[1] - a[1];
    if (Math.abs(dLon) < 1e-8 && Math.abs(dLat) < 1e-8) return '';
    if (Math.abs(dLat) >= Math.abs(dLon)) {
      return dLat >= 0 ? 'NB' : 'SB';
    }
    return dLon >= 0 ? 'EB' : 'WB';
  }

  // Decide direction from roughly the first 100 m of a subsegment
  function directionFromFirst100m(segCoords) {
    if (!segCoords || segCoords.length < 2) return '';
    const TARGET_M = 100;
    let acc = 0;
    const first = segCoords[0];
    for (let i = 1; i < segCoords.length; i++) {
      acc += haversineMeters(segCoords[i - 1], segCoords[i]);
      if (acc >= TARGET_M) {
        return axisCardinal(first, segCoords[i]);
      }
    }
    // If shorter than 100 m, just use start → end
    return axisCardinal(first, segCoords[segCoords.length - 1]);
  }

  const GENERIC_INSTR_RE = /^(keep (left|right)|slight (left|right)|turn (left|right)|continue\b|take (the )?ramp\b|enter (the )?roundabout\b)$/i;

  // Try to get a usable street name from ORS step (without highways yet)
  function stepNameNatural(step) {
    if (!step) return '';
    let name = normalizeName(step.name || step.road);
    if (name && GENERIC_INSTR_RE.test(name)) return '';

    if (!name) {
      const instr = cleanHtml(step.instruction || '');
      if (instr) {
        let m = instr.match(/\bonto\s+([^,]+?)(?:\s+for\b|,|$)/i);
        if (!m) m = instr.match(/\bvia\s+([^,]+?)(?:\s+for\b|,|$)/i);
        if (!m) m = instr.match(/\bonto\s+(.+)$/i);
        if (!m) m = instr.match(/\bvia\s+(.+)$/i);
        const cand = m ? m[1] : instr;
        name = normalizeName(cand);
        if (name && GENERIC_INSTR_RE.test(name)) return '';
      }
    }

    return name;
  }

  function mergeConsecutive(movs) {
    const out = [];
    for (const m of movs) {
      if (!m || !m.name || !m.km || m.km <= 0) continue;
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

  /******************************************************************
   * ORS → movements
   ******************************************************************/
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

  // coords: [ [lon,lat], ... ]
  // steps: ORS steps with way_points + distance (in km)
  function buildMovementsFromDirections(coords, steps) {
    if (!coords || !coords.length || !steps || !steps.length) return [];

    const MIN_SEG_KM = 0.03; // < 30 m → ghost
    const rows = [];

    for (const step of steps) {
      if (!step) continue;

      const wp = step.way_points || step.wayPoints || [];
      const len = coords.length;
      const a = wp[0] ?? 0;
      const b = wp[1] ?? (len - 1);
      const startIdx = Math.max(0, Math.min(len - 1, a));
      const endIdx   = Math.max(startIdx, Math.min(len - 1, b));
      if (endIdx <= startIdx) continue;

      // Distance: ORS uses km because we call with units='km'
      let km = Number(step.distance);
      if (!isFiniteNum(km) || km <= 0) {
        let meters = 0;
        for (let i = startIdx + 1; i <= endIdx; i++) {
          meters += haversineMeters(coords[i - 1], coords[i]);
        }
        km = meters / 1000;
      }
      if (!isFiniteNum(km) || km < MIN_SEG_KM) continue;

      const segCoords = coords.slice(startIdx, endIdx + 1);
      const dir = directionFromFirst100m(segCoords) || '';

      // Base name from ORS
      let name = stepNameNatural(step);

      // If still unnamed, try nearest highway centreline
      if (!name) {
        const midIdx = Math.floor((startIdx + endIdx) / 2);
        const mid = coords[midIdx] || coords[startIdx] || coords[endIdx];
        if (mid && mid.length >= 2) {
          const hName = nearestHighwayName(mid[0], mid[1]);
          if (hName) name = hName;
        }
      }

      // If *still* unnamed, finally fall back to generic instruction text
      if (!name) {
        const instr = cleanHtml(step.instruction || '');
        name = instr || 'Unnamed segment';
      }

      rows.push({ dir, name, km });
    }

    return mergeConsecutive(rows);
  }

  /******************************************************************
   * Build HTML for one trip
   ******************************************************************/
  function buildTablesForTrip(trip) {
    const features = Array.isArray(trip.features) ? trip.features : [];
    if (!features.length) return '';

    const pieces = [];

    features.forEach((feat, idx) => {
      const coords = feat.geometry && Array.isArray(feat.geometry.coordinates)
        ? feat.geometry.coordinates
        : [];
      const steps = extractStepsFromFeature(feat);
      const movs  = buildMovementsFromDirections(coords, steps);

      const props   = feat.properties || {};
      const summary = props.summary ||
                      (Array.isArray(props.segments) && props.segments[0]) ||
                      {};

      // distance already in km (units='km')
      let distKm = Number(summary.distance);
      if (!isFiniteNum(distKm) || distKm <= 0) {
        distKm = 0;
        if (coords && coords.length > 1) {
          for (let i = 1; i < coords.length; i++) {
            distKm += haversineMeters(coords[i - 1], coords[i]) / 1000;
          }
        } else {
          distKm = NaN;
        }
      }
      const durMin = isFiniteNum(summary.duration)
        ? Number(summary.duration) / 60
        : NaN;

      const routeLabel =
        features.length === 1
          ? 'Route'
          : (idx === 0 ? 'Route 1 (fastest)' : `Route ${idx + 1}`);

      const metaPieces = [];
      if (isFiniteNum(distKm)) metaPieces.push(`${km2(distKm)} km`);
      if (isFiniteNum(durMin)) metaPieces.push(`${durMin.toFixed(1)} min`);
      const meta = metaPieces.length ? metaPieces.join(' · ') : '';

      let bodyHtml;
      if (!movs.length) {
        bodyHtml = `
          <tr>
            <td colspan="3" style="font-style:italic;color:#777;">
              (No named street segments found for this route.)
            </td>
          </tr>`;
      } else {
        bodyHtml = movs.map(m =>
          `<tr>
             <td>${escapeHtml(m.dir || '')}</td>
             <td>${escapeHtml(m.name || '')}</td>
             <td style="text-align:right">${km2(m.km)}</td>
           </tr>`
        ).join('');
      }

      pieces.push(`
        <h3>${escapeHtml(routeLabel)}</h3>
        ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}
        <table>
          <thead>
            <tr><th>Dir</th><th>Street</th><th style="text-align:right">km</th></tr>
          </thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      `);
    });

    return pieces.join('');
  }

  function buildCardsHtml(cache) {
    if (!cache || !Array.isArray(cache.trips) || !cache.trips.length) return '';

    return cache.trips.map(trip => {
      const isPD  = trip.type === 'PD';
      const title = isPD
        ? (trip.name || trip.key || 'Planning District')
        : (trip.label || 'Planning Zone');

      const originLabel = trip.origin && (trip.origin.label ||
        `${trip.origin.lon}, ${trip.origin.lat}`) || '';
      const destLabel   = trip.destination && (trip.destination.label ||
        `${trip.destination.lon}, ${trip.destination.lat}`) || '';
      const dirLabel    = trip.reverse ? 'Destination → Origin' : 'Origin → Destination';

      const metaLine = originLabel && destLabel
        ? `${originLabel} → ${destLabel} (${dirLabel})`
        : '';

      const tables = buildTablesForTrip(trip);
      if (!tables) return '';

      return `
        <div class="card">
          <h2>${escapeHtml(title)}</h2>
          ${metaLine ? `<p class="meta">${escapeHtml(metaLine)}</p>` : ''}
          ${tables}
        </div>
      `;
    }).join('');
  }

  /******************************************************************
   * Print / open report
   ******************************************************************/
  async function printReport() {
    const cache = global.ROUTING_CACHE;
    if (!cache || !cache.trips || !cache.trips.length) {
      alert('No trips available. Please generate trips first.');
      return;
    }

    // Make sure highway centreline data is ready (for naming)
    await ensureHighwaysLoaded().catch(() => {});

    const cardsHtml = buildCardsHtml(cache);
    if (!cardsHtml) {
      alert('Unable to build report. Trip data is missing or incomplete.');
      return;
    }

    const css = `
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 16px 20px;
          font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI",
                Roboto, Helvetica, Arial, sans-serif;
          background: #fafafa;
        }
        h1 {
          font-size: 20px;
          margin: 0 0 16px 0;
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
          padding-bottom: 8px;
          border-bottom: 1px solid #eee;
          background: #fff;
          box-shadow: 0 1px 3px rgba(0,0,0,0.04);
          padding: 10px 12px 12px 12px;
        }
      </style>
    `;

    const w = window.open('', '_blank');
    if (!w) {
      alert('Popup blocked. Please allow popups for this site to print the report.');
      return;
    }

    const originObj = global.ROUTING_ORIGIN || {};
    const originLabel =
      originObj.label || originObj.name || originObj.address ||
      originObj.query || 'selected origin';

    const title = `Trip Route Distribution for ${originLabel}`;

    w.document.write(
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>' + escapeHtml(title) + '</title>' +
      css +
      '</head><body>' +
      '<h1>' + escapeHtml(title) + '</h1>' +
      cardsHtml +
      '</body></html>'
    );
    w.document.close();
  }

  /******************************************************************
   * Leaflet control wiring
   ******************************************************************/
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
          Uses the most recently generated trips from the Trip Generator.
        </small>
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

  // Simple API if you ever need it
  global.Report = {
    print: printReport
  };

  document.addEventListener('DOMContentLoaded', function () {
    initWhenReady();
  });

})(window);
