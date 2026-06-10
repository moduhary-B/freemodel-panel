'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'accounts.json');
const BASE = 'https://freemodel.dev';
const POLL_INTERVAL_MS = 60 * 1000;       // one full cycle per minute (while the panel is open)
const GAP_BETWEEN_ACCOUNTS_MS = 3000;     // delay between accounts so we don't hammer the IP
const GAP_BETWEEN_CALLS_MS = 400;         // small pause between the per-account endpoint calls
const PRESENCE_WINDOW_MS = 15 * 1000;     // panel counts as "open" if seen within this window
const IDLE_CHECK_MS = 5 * 1000;           // how often we re-check for the panel while idle

// Updated every time the open panel pings /api/accounts. Polling only runs
// while the panel is open, so nothing hits freemodel when the browser is closed.
let lastPanelSeen = 0;
function panelIsOpen() {
  return Date.now() - lastPanelSeen < PRESENCE_WINDOW_MS;
}

// ---------- storage ----------

function loadAccounts() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAccounts(accounts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}

let accounts = loadAccounts();

// ---------- cookie normalization ----------
// Accept whatever the user pastes (raw header, full curl, PowerShell, a bare
// token, multi-line) and reduce it to a clean "name=value; name=value" string.
function normalizeCookie(input) {
  if (!input) return '';
  let s = String(input).trim();

  // 1. PowerShell: $session.Cookies.Add(New-Object System.Net.Cookie("name","value",...))
  const psPairs = [...s.matchAll(/System\.Net\.Cookie\(\s*"([^"]+)"\s*,\s*"([^"]*)"/g)];
  if (psPairs.length) {
    return psPairs.map((m) => `${m[1]}=${m[2].replace(/`/g, '')}`).join('; ');
  }

  // 2. A "Cookie:" header line (curl -H 'Cookie: ...' or raw header) — keep only
  //    the value part, then fall through to generic pair parsing below.
  const headerMatch = s.match(/Cookie:\s*([^\r\n'"]+)/i);
  if (headerMatch) s = headerMatch[1].trim();

  // 3. Generic pairs. Split on ';' or newlines, accept '=' OR ':' as the
  //    separator (some exports use "name:value"), rebuild as "name=value".
  const pairs = [];
  for (const piece of s.split(/[;\n\r]+/)) {
    const m = piece.match(/^\s*([\w.-]+)\s*[=:]\s*(.+?)\s*$/);
    if (m) pairs.push(`${m[1]}=${m[2]}`);
  }
  if (pairs.length) return pairs.join('; ');

  // 4. A bare token with no separator — assume it's the session cookie value.
  return `bm_session=${s.replace(/\s+/g, '')}`;
}

// Re-normalize any cookies that were stored before normalization existed
// (or in an old format), so existing accounts get fixed on restart.
function renormalizeStored() {
  let changed = false;
  for (const acc of accounts) {
    const fixed = normalizeCookie(acc.cookie);
    if (fixed !== acc.cookie) { acc.cookie = fixed; changed = true; }
  }
  if (changed) saveAccounts(accounts);
}

// ---------- freemodel API ----------

async function apiGet(pathName, cookie) {
  const res = await fetch(BASE + pathName, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
      'Accept': '*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': 'https://freemodel.dev/dashboard/usage',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Cookie': cookie,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ' — ' + text.slice(0, 120) : ''}`);
  }
  return res.json();
}

// Fetch everything we care about for one account. Returns a flat snapshot.
async function fetchSnapshot(cookie) {
  const usage = await apiGet('/api/usage', cookie);
  if (!usage || !usage.window5h || !usage.windowWeek) {
    throw new Error('Unexpected /api/usage shape (cookie expired?): ' + JSON.stringify(usage).slice(0, 120));
  }
  await sleep(GAP_BETWEEN_CALLS_MS);

  // The remaining endpoints are best-effort: if one fails we still keep usage.
  let me = null, referral = null, billing = null;
  try { me = await apiGet('/api/auth/me', cookie); } catch (e) { console.error('  me:', e.message); }
  await sleep(GAP_BETWEEN_CALLS_MS);
  try { referral = await apiGet('/api/referral', cookie); } catch (e) { console.error('  referral:', e.message); }
  await sleep(GAP_BETWEEN_CALLS_MS);
  try { billing = await apiGet('/api/billing', cookie); } catch (e) { console.error('  billing:', e.message); }

  const u = (me && me.user) || {};
  const sub = (billing && billing.subscription) || null;

  return {
    usage: {
      window5h: usage.window5h,
      windowWeek: usage.windowWeek,
      totalRequests: usage.totalRequests,
      totalTokens: usage.totalTokens,
    },
    profile: me && me.user ? {
      userId: u.id,
      email: u.email,
      name: u.name,
      referralCode: u.referral_code,
      verified: !!u.verified_at,
      verifiedAt: u.verified_at || null,
      isAbuser: !!u.is_abuser,
      isPartner: !!u.is_partner,
    } : null,
    referral: referral ? {
      code: referral.code,
      count: referral.count,
      creditsCents: referral.credits,
      usedDollars: referral.used,
      pendingCents: referral.pendingCents,
      recent: Array.isArray(referral.recent) ? referral.recent : [],
    } : null,
    billing: billing ? {
      plan: sub ? sub.planId : 'free',
      status: sub ? sub.status : null,
      currentPeriodEnd: sub ? sub.currentPeriodEnd : null,
      cancelAtPeriodEnd: sub ? !!sub.cancelAtPeriodEnd : false,
      renewalType: sub ? sub.renewalType : null,
      creditCents: billing.creditCents,
    } : null,
  };
}

// Apply a fetched snapshot onto an account object, auto-filling blank fields.
function applySnapshot(acc, snap) {
  acc.usage = snap.usage;
  acc.profile = snap.profile;
  acc.referral = snap.referral;
  acc.billing = snap.billing;
  // Auto-fill email / referral code from the profile if the user left them blank.
  if (snap.profile) {
    if (!acc.email && snap.profile.email) acc.email = snap.profile.email;
    if (snap.profile.referralCode) acc.referralCode = snap.profile.referralCode;
  }
}

// Poll each account one at a time, with a gap between them.
async function pollOnce() {
  for (const acc of accounts) {
    if (!acc.cookie) {
      acc.error = 'No cookie set';
      acc.lastUpdated = Date.now();
      continue;
    }
    try {
      const snap = await fetchSnapshot(acc.cookie);
      applySnapshot(acc, snap);
      acc.error = null;
      console.log(`[poll] ${acc.email || acc.id}: ok ($${(acc.usage.window5h.usedCents/100).toFixed(2)}/5h, plan ${acc.billing ? acc.billing.plan : '?'}, refs ${acc.referral ? acc.referral.count : '?'})`);
    } catch (err) {
      acc.error = err.message;
      console.error(`[poll] ${acc.email || acc.id}: ERROR — ${err.message}`);
    }
    acc.lastUpdated = Date.now();
    saveAccounts(accounts);
    await sleep(GAP_BETWEEN_ACCOUNTS_MS);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollLoop() {
  let wasIdle = true;
  for (;;) {
    if (!panelIsOpen()) {
      // Panel closed — stay quiet, don't touch freemodel. Re-check periodically.
      if (!wasIdle) { console.log('[poll] panel closed — pausing polling'); wasIdle = true; }
      await sleep(IDLE_CHECK_MS);
      continue;
    }
    if (wasIdle) { console.log('[poll] panel open — resuming polling'); wasIdle = false; }
    try {
      await pollOnce();
    } catch (err) {
      console.error('Poll cycle error:', err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------- referral linking ----------
// freemodel masks referred emails like "xh******@legenmail.com" (first 2 chars
// + domain). Match those against accounts we manage to flag "this referral is
// one of my own accounts in the panel".
function maskedMatchesEmail(masked, email) {
  if (!masked || !email) return false;
  const mi = masked.indexOf('@'), ei = email.indexOf('@');
  if (mi < 0 || ei < 0) return false;
  const mDomain = masked.slice(mi + 1).toLowerCase();
  const eDomain = email.slice(ei + 1).toLowerCase();
  if (mDomain !== eDomain) return false;
  const prefix = masked.slice(0, mi).replace(/\*+$/, '').toLowerCase(); // visible chars before stars
  return email.slice(0, ei).toLowerCase().startsWith(prefix);
}

// Return a shallow copy of accounts where each referral.recent entry is tagged
// with the panel account id it corresponds to (if any).
function withReferralLinks(accs) {
  return accs.map((acc) => {
    if (!acc.referral || !Array.isArray(acc.referral.recent)) return acc;
    const recent = acc.referral.recent.map((r) => {
      const match = accs.find(
        (other) => other.id !== acc.id && maskedMatchesEmail(r.emailMasked, other.email)
      );
      return { ...r, linkedId: match ? match.id : null, linkedEmail: match ? match.email : null };
    });
    return { ...acc, referral: { ...acc.referral, recent } };
  });
}

// ---------- http server ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // --- static index ---
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // --- list accounts (with usage + computed referral links) ---
  if (req.method === 'GET' && pathname === '/api/accounts') {
    lastPanelSeen = Date.now(); // the panel is open and watching
    sendJson(res, 200, { accounts: withReferralLinks(accounts), serverTime: Date.now() });
    return;
  }

  // --- add account ---
  if (req.method === 'POST' && pathname === '/api/accounts') {
    try {
      const b = await readBody(req);
      const acc = {
        id: crypto.randomUUID(),
        email: (b.email || '').trim(),
        password: (b.password || '').trim(),
        apiKey: (b.apiKey || '').trim(),
        note: (b.note || '').trim(),
        cookie: normalizeCookie(b.cookie),
        referralCode: '',
        usage: null,
        profile: null,
        referral: null,
        billing: null,
        error: null,
        lastUpdated: null,
      };
      accounts.push(acc);
      saveAccounts(accounts);
      // Fetch the first snapshot before responding so email/plan/referral
      // auto-fill immediately ("paste cookie → it figures out the rest").
      await refreshOne(acc.id);
      sendJson(res, 200, { ok: true, account: acc });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // --- update account ---
  if (req.method === 'PUT' && pathname.startsWith('/api/accounts/')) {
    try {
      const id = pathname.split('/').pop();
      const acc = accounts.find((a) => a.id === id);
      if (!acc) return sendJson(res, 404, { error: 'Not found' });
      const b = await readBody(req);
      for (const f of ['email', 'password', 'apiKey', 'note']) {
        if (typeof b[f] === 'string') acc[f] = b[f].trim();
      }
      if (typeof b.cookie === 'string') acc.cookie = normalizeCookie(b.cookie);
      saveAccounts(accounts);
      sendJson(res, 200, { ok: true, account: acc });
      refreshOne(acc.id);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // --- delete account ---
  if (req.method === 'DELETE' && pathname.startsWith('/api/accounts/')) {
    const id = pathname.split('/').pop();
    accounts = accounts.filter((a) => a.id !== id);
    saveAccounts(accounts);
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- force refresh one account now ---
  if (req.method === 'POST' && pathname.startsWith('/api/refresh/')) {
    const id = pathname.split('/').pop();
    await refreshOne(id);
    const acc = accounts.find((a) => a.id === id);
    sendJson(res, 200, { ok: true, account: acc || null });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

async function refreshOne(id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  if (!acc.cookie) {
    acc.error = 'No cookie set';
    acc.usage = null;
    acc.lastUpdated = Date.now();
    saveAccounts(accounts);
    return;
  }
  try {
    const snap = await fetchSnapshot(acc.cookie);
    applySnapshot(acc, snap);
    acc.error = null;
    console.log(`[refresh] ${acc.email || acc.id}: ok`);
  } catch (err) {
    acc.error = err.message;
    console.error(`[refresh] ${acc.email || acc.id}: ERROR — ${err.message}`);
  }
  acc.lastUpdated = Date.now();
  saveAccounts(accounts);
}

renormalizeStored();

server.listen(PORT, () => {
  console.log(`\n  FreeModel token manager running:  http://localhost:${PORT}\n`);
  console.log(`  Loaded ${accounts.length} account(s). Polling one at a time, full cycle ~${POLL_INTERVAL_MS/1000}s.\n`);
  pollLoop();
});
