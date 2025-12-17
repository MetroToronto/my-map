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

  function cleanHtml(str) {
    return String(str || '').replace(/<[^>]*>/g, '').trim();
  }

  function normalizeName(raw) {
    if (!raw) return '';
    const s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s || /^unnamed\b/i.test(s) || /^[-–]+$/.test(s)) return '';
    return s;
  }

  // Strip trailing ", number" (e.g., "Jane Street, 55" → "Jane Street")
  function stripTrailingCommaNumber(name) {
    if (!name) return name;
    const m = String(name).match(/^(.+?),\s*\d+\s*$/);
    if (m) return m[1].trim();
    return name;
  }

  function finalNameCleanup(name) {
    if (!name) return name;
    let n = stripTrailingCommaNumber(name);
    n = n.replace(/\s+/g, ' ').trim();
    return n;
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
        'data/highway_centrelines.json',
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

    const MAX_DEG2 = 0.005 * 0.005; // ~500m
    if (bestName && bestD2 <= MAX_DEG2) return bestName;
    return '';
  }

  /******************************************************************
   * Direction + street-name helpers
   ******************************************************************/
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

  // 3-tier rule:
  //  < 20 m      → simple start→end
  //  20–200 m    → window 20–50 m
  //  ≥ 200 m     → window 200–500 m
  function directionFromSegment(segCoords) {
    if (!segCoords || segCoords.length < 2) return '';

    const n = segCoords.length;
    const lens = new Array(n - 1);
    let total = 0;
    for (let i = 1; i < n; i++) {
      const d = haversineMeters(segCoords[i - 1], segCoords[i]);
      lens[i - 1] = d;
      total += d;
    }
    if (total < 1) return '';

    // Very tiny segments: just use start→end
    if (total < 20) {
      return axisCardinal(segCoords[0], segCoords[n - 1]);
    }

    let winStart, winEnd;
    if (total < 200) {
      // Short segments: 20–50 m window
      winStart = 20;
      winEnd   = Math.min(total, 50);
    } else {
      // Long segments: 200–500 m window
      winStart = 200;
      winEnd   = Math.min(total, 500);
    }

    if (winStart >= winEnd) {
      return axisCardinal(segCoords[0], segCoords[n - 1]);
    }

    let acc = 0;
    let dxSum = 0;
    let dySum = 0;

    for (let i = 1; i < n; i++) {
      const d = lens[i - 1];
      const mid = acc + d / 2;
      if (mid >= winStart && mid <= winEnd) {
        const a = segCoords[i - 1];
        const b = segCoords[i];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        dxSum += dx * d;
        dySum += dy * d;
      }
      acc += d;
    }

    // If we got no usable window, fall back
    if (Math.abs(dxSum) < 1e-12 && Math.abs(dySum) < 1e-12) {
      return axisCardinal(segCoords[0], segCoords[n - 1]);
    }

    if (Math.abs(dySum) >= Math.abs(dxSum)) {
      return dySum >= 0 ? 'NB' : 'SB';
    }
    return dxSum >= 0 ? 'EB' : 'WB';
  }

  const GENERIC_INSTR_RE =
    /^(keep (left|right)|slight (left|right)|turn (left|right)|continue\b|take (the )?ramp\b|enter (the )?roundabout\b)$/i;

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

    if (name) {
      name = finalNameCleanup(name);
    }

    return name;
  }

  // Normalize to a "highway group" name (for merging)
  function highwayBase(nameUpper) {
    let n = nameUpper;
    if (/GARDINER/.test(n)) {
      n = n
        .replace(/\bEXPRESSWAY\b/g, '')
        .replace(/\bEXPRESS\b/g, '')
        .replace(/\bCOLLECTOR\b/g, '')
        .replace(/\bF G\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return n || 'GARDINER';
    }
    if (/HIGHWAY\s+401\b/.test(n)) {
      return 'HIGHWAY 401';
    }
    return null;
  }

  // Key for merging consecutive movements
  // For highways (Gardiner + 401), ignore direction so they always merge
  function mergeKey(m) {
    const dir = m.dir || '';
    let nameUpper = (m.name || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const hw = highwayBase(nameUpper);
    if (hw) {
      return 'HW|' + hw;   // highway group, direction-insensitive
    }
    return dir + '|' + nameUpper;
  }

  function mergeConsecutive(movs) {
    const out = [];
    for (const m of movs) {
      if (!m || !m.name || !m.km || m.km <= 0) continue;
      if (out.length) {
        const last = out[out.length - 1];
        if (mergeKey(last) === mergeKey(m)) {
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

      let km = Number(step.distance); // ORS distance in km
      if (!isFiniteNum(km) || km <= 0) {
        let meters = 0;
        for (let i = startIdx + 1; i <= endIdx; i++) {
          meters += haversineMeters(coords[i - 1], coords[i]);
        }
        km = meters / 1000;
      }
      if (!isFiniteNum(km) || km < MIN_SEG_KM) continue;

      const segCoords = coords.slice(startIdx, endIdx + 1);
      const dir = directionFromSegment(segCoords) || '';

      let name = stepNameNatural(step);

      if (!name) {
        const midIdx = Math.floor((startIdx + endIdx) / 2);
        const mid = coords[midIdx] || coords[startIdx] || coords[endIdx];
        if (mid && mid.length >= 2) {
          const hName = nearestHighwayName(mid[0], mid[1]);
          if (hName) name = finalNameCleanup(hName);
        }
      }

      if (!name) {
        const instr = cleanHtml(step.instruction || '');
        name = finalNameCleanup(instr || 'Unnamed segment');
      }

      rows.push({ dir, name, km });
    }

    return mergeConsecutive(rows);
  }

  /******************************************************************
   * Origin parsing for titles/meta
   ******************************************************************/
  function parseOriginLabel(label) {
    if (!label) return { address: '', postal: '' };
    const parts = label.split(',').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return { address: label.trim(), postal: '' };

    // Detect postal code (Canadian style A1A 1A1)
    const postalIdx = parts.findIndex(p => /[A-Z]\d[A-Z]\s*\d[A-Z]\d/i.test(p));
    const postal = postalIdx >= 0 ? parts[postalIdx] : '';

    const addrParts = postalIdx >= 0 ? parts.slice(0, postalIdx) : parts.slice();
    if (!addrParts.length) return { address: label.trim(), postal };

    // Find first part with a digit
    let idx = addrParts.findIndex(p => /\d/.test(p));
    if (idx < 0) idx = 0;

    let addressMain = addrParts[idx];

    // Special case: Highway <num> , <num> , <Street>
    if (/Highway/i.test(addressMain) && idx + 2 < addrParts.length &&
        /^\d+$/.test(addrParts[idx + 1])) {
      addressMain = addressMain + ' ' + addrParts[idx + 1] + ' ' + addrParts[idx + 2];
    } else if (/^\d+$/.test(addressMain) && idx + 1 < addrParts.length) {
      // Pure number then street
      addressMain = addressMain + ' ' + addrParts[idx + 1];
    }

    addressMain = addressMain.replace(/\s+/g, ' ').trim();
    return { address: addressMain, postal: postal.replace(/\s+/g, ' ').trim() };
  }

  // Returns:
  //   label: "PD 1" (no colon)
  //   cityText: "City of Toronto"
  //   num: "1"
  //   cityBare: "Toronto"
  function pdCityMetaFromTitle(title) {
    if (!title) return { label: '', cityText: '', num: '', cityBare: '' };
    const t = title.trim();
    let pdNum = '';
    let cityName = '';

    const m = t.match(/^PD\s+(\d+)\s+of\s+(.+)$/i);
    if (m) {
      pdNum = m[1];
      cityName = m[2].trim();
    } else {
      const mNum = t.match(/(\d+)/);
      if (mNum) pdNum = mNum[1];
      const mOf = t.match(/\bof\s+(.+)$/i);
      cityName = (mOf ? mOf[1] : t).trim();
    }

    const cityBare = cityName.replace(/^(City|Town|Region|County)\s+of\s+/i, '').trim();
    let cityText = cityName;
    if (!/^(City|Town|Region|County)\s+of\s+/i.test(cityName)) {
      cityText = 'City of ' + cityName;
    }

    const label = pdNum ? ('PD ' + pdNum) : 'PD';
    return { label, cityText, num: pdNum, cityBare };
  }

  /******************************************************************
   * Build summary table for one trip
   ******************************************************************/
  function buildTablesForTrip(trip) {
    const features = Array.isArray(trip.features) ? trip.features : [];

    // Trip heading: based only on origin/destination lat/lon
    let headingChar = '';
    if (trip && trip.origin && trip.destination &&
        isFiniteNum(trip.origin.lon) && isFiniteNum(trip.origin.lat) &&
        isFiniteNum(trip.destination.lon) && isFiniteNum(trip.destination.lat)) {

      let a = [trip.origin.lon, trip.origin.lat];
      let b = [trip.destination.lon, trip.destination.lat];
      if (trip.reverse) {
        const tmp = a;
        a = b;
        b = tmp;
      }
      const h = axisCardinal(a, b);
      headingChar = h ? h.charAt(0) : '';
    }

    const rows = [];

    features.forEach((feat) => {
      const coords = feat.geometry && Array.isArray(feat.geometry.coordinates)
        ? feat.geometry.coordinates
        : [];
      if (!coords.length) return;

      const steps = extractStepsFromFeature(feat);
      const movs  = buildMovementsFromDirections(coords, steps);

      const props   = feat.properties || {};
      const summary = props.summary ||
                      (Array.isArray(props.segments) && props.segments[0]) ||
                      {};

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

      let descPlain;
      let descHtml;

      if (!movs.length) {
        const base = '(No named street segments found for this route.)';
        descPlain = base;
        descHtml  = escapeHtml(base);
      } else {
        const piecesPlain = [];
        const piecesHtml  = [];
        for (const m of movs) {
          const dirPart = m.dir ? (m.dir + ' ') : '';
          const plain = `${dirPart}${m.name} (${km2(m.km)} km)`;
          piecesPlain.push(plain);

          const dirEsc  = m.dir ? (escapeHtml(m.dir) + ' ') : '';
          const nameEsc = escapeHtml(m.name);
          const kmEsc   = km2(m.km);
          const htmlSeg = `${dirEsc}${nameEsc}<span class="seg-km"> (${kmEsc} km)</span>`;
          piecesHtml.push(htmlSeg);
        }
        // IMPORTANT CHANGE: no "Route:" prefix here
        descPlain = piecesPlain.join(', ');
        descHtml  = piecesHtml.join(', ');
      }

      rows.push({
        heading: headingChar,
        descPlain,
        descHtml,
        distKm,
        durMin
      });
    });

    if (!rows.length) {
      const rawErr = (trip && trip.error) ? String(trip.error) : '';
      // Try to keep the message short + user-friendly
      let msg = 'No routable path found near the target point (ORS code 2010).';
      if (rawErr && rawErr.includes('Could not find routable point')) {
        msg = 'No routable road near the target point. The tool tried snapping to a nearby road inside the area, but couldn’t find a valid route.';
      } else if (rawErr) {
        msg = 'Route unavailable for this destination.';
      }
      rows.push({
        heading: headingChar,
        descPlain: '(' + msg + ')',
        descHtml: escapeHtml('(' + msg + ')'),
        distKm: NaN,
        durMin: NaN
      });
    }

    const bodyHtml = rows.map(r => `
      <tr>
        <td>${escapeHtml(r.heading || '')}</td>
        <td data-desc="${escapeHtml(r.descPlain || '')}">${r.descHtml || ''}</td>
        <td style="text-align:right">${isFiniteNum(r.distKm) ? km2(r.distKm) : ''}</td>
        <td style="text-align:right">${isFiniteNum(r.durMin) ? r.durMin.toFixed(1) : ''}</td>
      </tr>
    `).join('');

    return `
      <h3>Routes</h3>
      <table>
        <thead>
          <tr>
            <th>Trip dir</th>
            <th>Street-by-street</th>
            <th style="text-align:right">Total km</th>
            <th style="text-align:right">Total min</th>
          </tr>
        </thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    `;
  }

  /******************************************************************
   * Build cards for all trips
   ******************************************************************/
  function buildCardsHtml(cache) {
    if (!cache || !Array.isArray(cache.trips) || !cache.trips.length) return '';

    return cache.trips.map(trip => {
      const isPD  = trip.type === 'PD';
      const title = isPD
        ? (trip.name || trip.key || 'Planning District')
        : (trip.label || 'Planning Zone');

      const originLabel = trip.origin && (trip.origin.label ||
        `${trip.origin.lon}, ${trip.origin.lat}`) || '';

      const { address: originAddr, postal: originPostal } =
        parseOriginLabel(originLabel);

      let areaLabel = '';
      let cityText = '';
      let areaNum = '';
      let cityBare = '';

      if (isPD) {
        const meta = pdCityMetaFromTitle(title);
        areaLabel = meta.label;       // "PD 1"
        cityText  = meta.cityText;    // "City of Toronto"
        areaNum   = meta.num || '';   // "1"
        cityBare  = meta.cityBare;    // "Toronto"
      } else {
        const num = trip.key != null ? String(trip.key) :
                    (trip.id != null ? String(trip.id) : '');
        areaNum   = num;
        areaLabel = num ? ('PZ ' + num) : 'PZ';

        const cityNameRaw = trip.label || title;
        cityBare = cityNameRaw.replace(/^(City|Town|Region|County)\s+of\s+/i, '').trim();
        let displayName = cityNameRaw;
        if (!/^(City|Town|Region|County)\s+of\s+/i.test(cityNameRaw)) {
          displayName = 'City of ' + cityNameRaw;
        }
        cityText = displayName;
      }

      const fromLine = originAddr
        ? `From: ${originAddr}${originPostal ? ', ' + originPostal : ''}`
        : '';
      const toLine = `To: ${areaLabel}${cityText ? ', ' + cityText : ''}`;

      const tableHtml = buildTablesForTrip(trip);
      if (!tableHtml) return '';

      return `
        <div class="card"
             data-area-type="${isPD ? 'PD' : 'PZ'}"
             data-area-num="${escapeHtml(areaNum)}"
             data-area-city="${escapeHtml(cityBare)}">
          <h2>${escapeHtml(title)}</h2>
          ${fromLine ? `<p class="meta-line">${escapeHtml(fromLine)}</p>` : ''}
          ${toLine ? `<p class="meta-line">${escapeHtml(toLine)}</p>` : ''}
          ${tableHtml}
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

    await ensureHighwaysLoaded().catch(() => {});

    const cardsHtml = buildCardsHtml(cache);
    if (!cardsHtml) {
      alert('Unable to build report. Trip data is missing or incomplete.');
      return;
    }

    // Determine whether these are PD or PZ trips
    let hasPD = false, hasPZ = false;
    for (const t of cache.trips) {
      if (t && t.type === 'PD') hasPD = true;
      if (t && t.type === 'PZ') hasPZ = true;
    }
    let targetLabel;
    if (hasPD && !hasPZ) targetLabel = 'Planning Districts';
    else if (!hasPD && hasPZ) targetLabel = 'Traffic Zones';
    else targetLabel = 'Planning Districts / Traffic Zones';

    const originObj = global.ROUTING_ORIGIN || {};
    const originLabel =
      originObj.label || originObj.name || originObj.address ||
      originObj.query || 'selected origin';

    const originParsed = parseOriginLabel(originLabel);
    const originShort = originParsed.address || originLabel;

    const title = `Trip Route Distribution for ${originShort} to ${targetLabel}`;

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
          margin: 0 0 10px 0;
        }
        h2 {
          font-size: 16px;
          margin: 14px 0 4px 0;
        }
        h3 {
          font-size: 14px;
          margin: 10px 0 4px 0;
        }
        p.meta-line {
          margin: 0;
          font-size: 12px;
          color: #555;
        }
        p.meta-line + p.meta-line {
          margin-top: 2px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 8px;
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
        .toolbar {
          margin: 0 0 14px 0;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .toolbar button {
          font-size: 12px;
          padding: 4px 10px;
          border-radius: 12px;
          border: 1px solid #ccc;
          background: #fff;
          cursor: pointer;
        }
        .toolbar button:hover {
          background: #f0f0f0;
        }
        .seg-km {
          white-space: nowrap;
        }
        body.km-disabled .seg-km {
          display: none;
        }
      </style>
    `;

    const w = window.open('', '_blank');
    if (!w) {
      alert('Popup blocked. Please allow popups for this site to print the report.');
      return;
    }

    const html =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>' + escapeHtml(title) + '</title>' +
      css +
      '</head><body>' +
      '<h1>' + escapeHtml(title) + '</h1>' +
      '<div class="toolbar">' +
        '<button id="btn-toggle-km">Hide km</button>' +
        '<button id="btn-copy-csv">Copy to spreadsheet</button>' +
        '<button id="btn-print">Print page</button>' +
      '</div>' +
      cardsHtml +
      '<script>' +
      '(function(){' +
        'var doc=document;' +
        'var toggleBtn=doc.getElementById("btn-toggle-km");' +
        'var copyBtn=doc.getElementById("btn-copy-csv");' +
        'var printBtn=doc.getElementById("btn-print");' +
        'var kmEnabled=true;' +

        'function setToggleLabel(){toggleBtn.textContent=kmEnabled?"Hide km":"Show km";}' +

        'if(toggleBtn){toggleBtn.addEventListener("click",function(){' +
          'kmEnabled=!kmEnabled;' +
          'if(kmEnabled){doc.body.classList.remove("km-disabled");}else{doc.body.classList.add("km-disabled");}' +
          'setToggleLabel();' +
        '});}' +

        'if(printBtn){printBtn.addEventListener("click",function(){window.print();});}' +

        'function fallbackCopy(text){' +
          'var ta=doc.createElement("textarea");' +
          'ta.value=text;ta.style.position="fixed";ta.style.left="-9999px";' +
          'doc.body.appendChild(ta);ta.focus();ta.select();' +
          'try{doc.execCommand("copy");}catch(e){}' +
          'doc.body.removeChild(ta);' +
          'alert("Copied trip routes. Paste directly into Excel or Sheets.");' +
        '}' +

        'if(copyBtn){copyBtn.addEventListener("click",function(){' +
          'var rows=[];' +
          'var cards=doc.querySelectorAll(".card");' +
          'cards.forEach(function(card){' +
            'var areaNum=card.getAttribute("data-area-num")||"";' +
            'var cityBare=card.getAttribute("data-area-city")||"";' +
            'var trs=card.querySelectorAll("tbody tr");' +
            'trs.forEach(function(tr){' +
              'var tds=tr.querySelectorAll("td");' +
              'if(tds.length<4)return;' +
              'var tripDir=tds[0].innerText.trim();' +
              'var descCell=tds[1];' +
              'var desc=descCell.getAttribute("data-desc")||descCell.innerText.trim();' +
              'var totalKm=tds[2].innerText.trim();' +
              'var totalMin=tds[3].innerText.trim();' +
              'rows.push([areaNum,cityBare,tripDir,desc,totalKm,totalMin]);' +
            '});' +
          '});' +
          'if(!rows.length){alert("No trip rows to copy.");return;}' +
          'var header=["Area","City","Trip dir","Street-by-street","Total km","Total min"];' +
          'var lines=[header].concat(rows).map(function(r){' +
            'return r.map(function(v){return String(v==null?"":v);}).join("\\t");' +  // TAB-separated
          '});' +
          'var text=lines.join("\\n");' +
          'if(navigator.clipboard&&navigator.clipboard.writeText){' +
            'navigator.clipboard.writeText(text).then(function(){' +
              'alert("Copied trip routes. Paste directly into Excel or Sheets.");' +
            '},function(){fallbackCopy(text);});' +
          '}else{fallbackCopy(text);}' +
        '});}' +

        'if(toggleBtn){setToggleLabel();}' +
      '})();' +
      '<\/script>' +
      '</body></html>';

    w.document.write(html);
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
          <button type="button" id="rt-print-report">Print / View Report</button>
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

  global.Report = { print: printReport };

  document.addEventListener('DOMContentLoaded', function () {
    initWhenReady();
  });

})(window);
