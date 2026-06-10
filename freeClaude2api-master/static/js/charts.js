const STATUS_LABEL_KEYS = { "2xx": "legend_2xx", "429": "legend_429", "4xx": "legend_4xx", "5xx": "legend_5xx" };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawSeries(series) {
  const svg = document.getElementById('chart-series');
  const W = 600, H = 180, pad = 8;
  const max = Math.max(1, ...series.map(p => p.v));
  const n = series.length;
  const stepX = (W - pad * 2) / (n - 1);
  const y = v => H - pad - (v / max) * (H - pad * 2 - 14);
  const x = i => pad + i * stepX;
  let line = '';
  series.forEach((p, i) => {
    line += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1) + ' ';
  });
  const area = line + `L${x(n - 1).toFixed(1)} ${H - pad} L${x(0).toFixed(1)} ${H - pad} Z`;
  const coral = cssVar('--coral'), cd = cssVar('--coral-deep');
  svg.innerHTML = `
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${coral}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${coral}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#areaGrad)"/>
    <path d="${line}" fill="none" stroke="${cd}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <text class="axis-label" x="8" y="14">${t('peak', max)}</text>
  `;
}

function drawDonut(buckets) {
  const svg = document.getElementById('chart-donut'), legend = document.getElementById('donut-legend');
  const order = ["2xx", "429", "4xx", "5xx"];
  const colors = { "2xx": cssVar('--green'), "429": cssVar('--amber'), "4xx": cssVar('--coral'), "5xx": cssVar('--red') };
  const total = order.reduce((s, k) => s + buckets[k], 0);
  const r = 15.915, cx = 21, cy = 21, sw = 5;
  let off = 25;
  let segs = '';
  if (total === 0) {
    segs = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${cssVar('--surface-sunk')}" stroke-width="${sw}"/>`;
  } else {
    order.forEach(k => {
      const pct = (buckets[k] / total) * 100;
      if (pct <= 0) return;
      segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[k]}" stroke-width="${sw}"
        stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>`;
      off -= pct;
    });
  }
  svg.innerHTML = `<g transform="rotate(0 21 21)">${segs}</g>
    <text x="21" y="20" text-anchor="middle" style="font-family:'Fraunces',serif;font-size:7px;font-weight:600;fill:${cssVar('--ink')}">${total}</text>
    <text x="21" y="26" text-anchor="middle" style="font-size:2.6px;fill:${cssVar('--ink-faint')};letter-spacing:.3px">RESPONSES</text>`;
  legend.innerHTML = order.map(k => `
    <div class="legend-item">
      <span class="sw" style="background:${colors[k]}"></span>
      <span class="lk">${t(STATUS_LABEL_KEYS[k])}</span>
      <span class="lv">${buckets[k]}</span>
    </div>`).join('');
}

function drawLoad(load) {
  const el = document.getElementById('loadbars');
  if (!load || !load.length) {
    el.innerHTML = `<div class="empty" style="padding:20px 0"><div class="big">${icon('trend')}</div>${t('empty_load')}</div>`;
    return;
  }
  const max = Math.max(1, ...load.map(l => l.total));
  el.innerHTML = load.slice(0, 12).map(l => {
    const pct = (l.total / max) * 100;
    return `<div class="loadbar">
      <span class="lname">${l.short}</span>
      <div class="ltrack"><div class="lfill" style="width:${pct}%"></div></div>
      <span class="lval">${l.total}</span>
    </div>`;
  }).join('');
}
