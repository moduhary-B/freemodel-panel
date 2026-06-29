'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
// Хранилище аккаунтов. В контейнере DATA_FILE указывает в именованный том
// (/app/data/accounts.json), чтобы данные переживали пересборку и миграцию.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'accounts.json');
const BASE = 'https://freemodel.dev';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0';
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

// Generic authenticated call to the freemodel API. `body` (when provided) is
// sent as JSON; GET/DELETE pass no body. DELETE returns "{ok:true}" but we also
// tolerate an empty response. Used by apiGet plus the key-rotation helpers.
async function apiCall(method, pathName, cookie, body) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://freemodel.dev/dashboard/keys',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Cookie': cookie,
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + pathName, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ' — ' + text.slice(0, 120) : ''}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function apiGet(pathName, cookie) {
  return apiCall('GET', pathName, cookie);
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

// ---------- api key rotation ----------
// Rotate an account's freemodel API key: create a fresh key, store its secret,
// then delete the old one. We create-then-delete so there's never a window with
// no key. The old key's id comes from acc.apiKeyId; for keys added before we
// tracked ids, we fall back to matching the stored key's suffix (last 4 chars)
// against GET /api/keys. Returns the new secret.
async function rotateApiKey(id, name) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Not found');
  if (!acc.cookie) throw new Error('No cookie set');

  // Figure out which existing key to drop afterwards.
  let oldId = acc.apiKeyId || null;
  if (!oldId && acc.apiKey) {
    const suffix = acc.apiKey.trim().slice(-4);
    try {
      const list = await apiGet('/api/keys', acc.cookie);
      const match = (list.keys || []).find((k) => k.suffix === suffix);
      if (match) oldId = match.id;
    } catch (e) {
      console.error(`[rotate] ${acc.email || acc.id}: list failed — ${e.message}`);
    }
  }

  // Create the new key. freemodel returns the full secret exactly once here.
  const keyName = (name && String(name).trim()) || 'panel';
  const created = await apiCall('POST', '/api/keys', acc.cookie, { name: keyName });
  const secret = created.secret;
  const newId = created.key && created.key.id;
  if (!secret) throw new Error('No secret returned: ' + JSON.stringify(created).slice(0, 120));

  // Delete the previous key (never the one we just made).
  if (oldId && oldId !== newId) {
    try {
      await apiCall('DELETE', `/api/keys/${oldId}`, acc.cookie);
    } catch (e) {
      console.error(`[rotate] ${acc.email || acc.id}: delete old #${oldId} failed — ${e.message}`);
    }
  }

  acc.apiKey = secret;
  acc.apiKeyId = newId || null;
  acc.lastUpdated = Date.now();
  saveAccounts(accounts);
  console.log(`[rotate] ${acc.email || acc.id}: new key ...${secret.slice(-4)} (#${newId})${oldId ? `, removed old #${oldId}` : ''}`);
  return acc;
}

// ---------- session re-login via email OTP ----------
// freemodel logs in only via email one-time code or Google. When a stored
// bm_session dies (401), we mint a fresh one with the OTP flow: send a code to
// the account email, then exchange it for a new session cookie. This is
// independent of however the user logs in elsewhere (Google on their own PC),
// so the panel's session is no longer collateral damage.

async function freemodelSendOtp(email) {
  const res = await fetch(BASE + '/api/auth/send-otp', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Content-Type': 'application/json',
      'Referer': BASE + '/',
    },
    body: JSON.stringify({ email }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`send-otp HTTP ${res.status}${text ? ' — ' + text.slice(0, 120) : ''}`);
  return text ? JSON.parse(text) : {};
}

// Exchange an OTP code for a session. Returns the new cookie string built from
// the Set-Cookie headers (we keep bm_session and anything else freemodel sets).
async function freemodelVerifyOtp(email, code) {
  const res = await fetch(BASE + '/api/auth/verify-otp', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Content-Type': 'application/json',
      'Referer': BASE + '/',
    },
    body: JSON.stringify({ email, code }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let msg = `verify-otp HTTP ${res.status}`;
    try { const j = JSON.parse(text); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const pairs = [];
  for (const sc of setCookies) {
    const m = sc.match(/^\s*([^=;\s]+)=([^;]*)/);
    if (m) pairs.push(`${m[1]}=${m[2]}`);
  }
  return { cookie: pairs.join('; ') };
}

// Step 1: ask freemodel to email a login code to the account address.
async function reloginSendOtp(id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Not found');
  if (!acc.email) throw new Error('No email on account — add it first');
  await freemodelSendOtp(acc.email);
  console.log(`[relogin] ${acc.email}: OTP sent`);
  return acc.email;
}

// Step 2: exchange the code the user typed for a fresh session, store it, and
// validate by pulling a snapshot.
async function reloginVerifyOtp(id, code) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Not found');
  if (!acc.email) throw new Error('No email on account');
  const { cookie } = await freemodelVerifyOtp(acc.email, String(code).trim());
  if (!/(^|;\s*)bm_session=/.test(cookie)) {
    throw new Error('Logged in but no session cookie returned');
  }
  acc.cookie = normalizeCookie(cookie);
  saveAccounts(accounts);
  console.log(`[relogin] ${acc.email}: new session stored`);
  await refreshOne(id);
  return accounts.find((a) => a.id === id);
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
        apiKeyId: null,
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

  // --- rotate api key: make a new freemodel key, drop the old one ---
  if (req.method === 'POST' && pathname.startsWith('/api/rotate-key/')) {
    try {
      const id = pathname.split('/').pop();
      const b = await readBody(req).catch(() => ({}));
      const acc = await rotateApiKey(id, b && b.name);
      sendJson(res, 200, { ok: true, account: acc });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // --- relogin step 1: send OTP code to the account email ---
  if (req.method === 'POST' && pathname.startsWith('/api/otp/send/')) {
    try {
      const id = pathname.split('/').pop();
      const email = await reloginSendOtp(id);
      sendJson(res, 200, { ok: true, email });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // --- relogin step 2: verify OTP code, store the fresh session ---
  if (req.method === 'POST' && pathname.startsWith('/api/otp/verify/')) {
    try {
      const id = pathname.split('/').pop();
      const b = await readBody(req);
      if (!b || !b.code) throw new Error('No code');
      const acc = await reloginVerifyOtp(id, b.code);
      sendJson(res, 200, { ok: true, account: acc });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
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
