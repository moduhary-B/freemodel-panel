const ICON_PATHS = {
  logo:        '<path d="M12 2v5M12 17v5M2 12h5M17 12h5M4.9 4.9l3.5 3.5M15.6 15.6l3.5 3.5M19.1 4.9l-3.5 3.5M8.4 15.6l-3.5 3.5M7.0 3.2l2.3 4.6M14.7 16.2l2.3 4.6M20.8 7.0l-4.6 2.3M7.8 14.7l-4.6 2.3M17.0 3.2l-2.3 4.6M9.3 16.2l-2.3 4.6M20.8 17.0l-4.6-2.3M7.8 9.3l-4.6-2.3"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>',
  zap:         '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  clock:       '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  repeat:      '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  timer:       '<path d="M10 2h4"/><path d="M12 14v-4"/><circle cx="12" cy="14" r="8"/>',
  chart:       '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
  database:    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  inbox:       '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>',
  trend:       '<path d="M22 7 13.5 15.5l-5-5L2 17"/><path d="M16 7h6v6"/>',
  heart:       '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>',
  plus:        '<path d="M12 5v14M5 12h14"/>',
  play:        '<path d="m6 3 14 9-14 9V3Z"/>',
  trash:       '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  rotate:      '<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8"/><path d="M3 3v5h5"/>',
  x:           '<path d="M18 6 6 18M6 6l12 12"/>',
  check:       '<path d="M20 6 9 17l-5-5"/>',
  alert:       '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  mail:        '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  link:        '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  sun:         '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:        '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  arrowUp:     '<path d="M12 19V6M5 12l7-7 7 7"/>',
  flask:       '<path d="M9 3h6"/><path d="M10 3v6l-5.5 9A2 2 0 0 0 6 21h12a2 2 0 0 0 1.5-3.5L14 9V3"/><path d="M7 15h10"/>',
  message:     '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  cpu:         '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v2M15 1v2M9 21v2M15 21v2M1 9h2M1 15h2M21 9h2M21 15h2"/>',
  user:        '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  sparkle:     '<path d="M12 2 9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2Z"/>',
  globe:       '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>',
  info:        '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
};

function icon(name, extra = '') {
  const p = ICON_PATHS[name] || '';
  return `<svg class="ic ${extra}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-ic]').forEach(el => {
    el.innerHTML = icon(el.dataset.ic, el.dataset.icClass || '');
  });
}
