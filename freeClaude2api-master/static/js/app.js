const $ = id => document.getElementById(id);
let lastLogLen = 0;

const I18N = {
  en: {
    subtitle: "Claude API key balancer · auto-rotation on rate limits",
    proxy_live: "Proxy live",
    st_active: "Active keys", st_expired: "Expired", st_requests: "Requests", st_uptime: "Uptime",
    api_keys: "API Keys",
    ph_key: "Paste API key (fe_oa_…)",
    add_key: "Add key",
    launch_claude: "Launch Claude",
    work_dir: "Working directory",
    run_key: "API key", run_key_auto: "Auto-rotate (all keys)",
    live_activity: "Live Activity",
    analytics: "Analytics",
    success_rate: "Success rate", avg_latency: "Avg latency", total_responses: "Total responses",
    req_over_time: "Requests over time", last60: "last 60 min",
    resp_statuses: "Response statuses", load_per_key: "Load per key",
    footer_pre: "Created with", footer_post: "by",
    tip_test: "Test all keys", tip_mail: "Temp Mail", tip_freemodel: "FreeModel",
    tip_lang: "Language", tip_top: "Scroll to top",
    empty_keys: "No keys yet",
    empty_log: "Waiting for requests…",
    empty_load: "No traffic yet",
    pill_active: "Active", pill_expired: "Expired", pill_error: "Error",
    pill_dead: "Invalid", pill_exhausted: "No balance",
    idle: "idle", unit_req: "req", unit_err: "err",
    t_key_added: "Key added", t_key_removed: "Key removed", t_cool_cleared: "Cooldown cleared",
    t_log_cleared: "Log cleared", t_testing: "Testing all keys…",
    t_paste_first: "Paste a key first", t_launched: "Claude launched",
    t_test_failed: "Test failed",
    confirm_delete: "Delete this key?",
    run_launching: "Launching…", run_launched: "Launched", run_enter_dir: "Enter a directory",
    err_exists: "Key already exists", err_empty: "Empty key", err_dir: "Directory not found",
    err_no_claude: "Claude CLI not installed",
    claude_missing: "Claude CLI not found on PATH. Install it to launch sessions.",
    legend_2xx: "Success (2xx)", legend_429: "Rate-limited (429)",
    legend_4xx: "Client error (4xx)", legend_5xx: "Server error (5xx)",
    test_result: (n, a, e, er) => `Tested ${n}: ${a} active · ${e} expired · ${er} error`,
    peak: n => `${n} req/min peak`,
  },
  ru: {
    subtitle: "Балансировщик ключей Claude API · авто-ротация при лимитах",
    proxy_live: "Прокси активен",
    st_active: "Активные ключи", st_expired: "Истекли", st_requests: "Запросы", st_uptime: "Аптайм",
    api_keys: "API ключи",
    ph_key: "Вставьте API ключ (fe_oa_…)",
    add_key: "Добавить",
    launch_claude: "Запустить Claude",
    work_dir: "Рабочая директория",
    run_key: "API ключ", run_key_auto: "Авто-ротация (все ключи)",
    live_activity: "Активность",
    analytics: "Аналитика",
    success_rate: "Успешность", avg_latency: "Ср. задержка", total_responses: "Всего ответов",
    req_over_time: "Запросы по времени", last60: "за 60 мин",
    resp_statuses: "Статусы ответов", load_per_key: "Нагрузка по ключам",
    footer_pre: "Сделано с", footer_post: "·",
    tip_test: "Проверить все ключи", tip_mail: "Временная почта", tip_freemodel: "FreeModel",
    tip_lang: "Язык", tip_top: "Наверх",
    empty_keys: "Пока нет ключей",
    empty_log: "Ожидание запросов…",
    empty_load: "Пока нет трафика",
    pill_active: "Активен", pill_expired: "Истёк", pill_error: "Ошибка",
    pill_dead: "Неверный", pill_exhausted: "Нет баланса",
    idle: "простаивает", unit_req: "зап", unit_err: "ош",
    t_key_added: "Ключ добавлен", t_key_removed: "Ключ удалён", t_cool_cleared: "Кулдаун снят",
    t_log_cleared: "Лог очищен", t_testing: "Проверяю все ключи…",
    t_paste_first: "Сначала вставьте ключ", t_launched: "Claude запущен",
    t_test_failed: "Тест не удался",
    confirm_delete: "Удалить этот ключ?",
    run_launching: "Запуск…", run_launched: "Запущено", run_enter_dir: "Укажите директорию",
    err_exists: "Ключ уже существует", err_empty: "Пустой ключ", err_dir: "Директория не найдена",
    err_no_claude: "Claude CLI не установлен",
    claude_missing: "Claude CLI не найден в PATH. Установите его, чтобы запускать сессии.",
    legend_2xx: "Успех (2xx)", legend_429: "Лимит (429)",
    legend_4xx: "Ошибка клиента (4xx)", legend_5xx: "Ошибка сервера (5xx)",
    test_result: (n, a, e, er) => `Проверено ${n}: ${a} активны · ${e} истекли · ${er} ошибок`,
    peak: n => `${n} зап/мин пик`,
  },
};

let LANG = 'en';
function getSavedLang() {
  try { return localStorage.getItem('fms-lang') === 'ru' ? 'ru' : 'en'; } catch (e) { return 'en'; }
}
function t(key, ...args) {
  const v = (I18N[LANG] && I18N[LANG][key]) ?? (I18N.en[key]) ?? key;
  return typeof v === 'function' ? v(...args) : v;
}
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  const lbl = $('lang-label'); if (lbl) lbl.textContent = LANG.toUpperCase();
  document.documentElement.lang = LANG;
}
function setLang(lang) {
  LANG = (lang === 'ru') ? 'ru' : 'en';
  try { localStorage.setItem('fms-lang', LANG); } catch (e) {}
  applyI18n();
  poll();
}
function toggleLang() { setLang(LANG === 'en' ? 'ru' : 'en'); }

function mapErr(msg) {
  const m = {
    "Key already exists": 'err_exists', "Empty key": 'err_empty',
    "Directory not found": 'err_dir', "Claude CLI not installed": 'err_no_claude',
  };
  return m[msg] ? t(m[msg]) : (msg || t('t_test_failed'));
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function shortModel(m) {
  if (!m) return '';
  return m.replace(/-\d{6,}$/, '').replace(/^anthropic\//, '');
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('fms-theme', next); } catch (e) {}
}
function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function toast(msg, type = 'success') {
  const t = $('toast');
  const ic = type === 'error' ? 'alert' : type === 'info' ? 'info' : 'check';
  t.className = '';
  void t.offsetWidth;
  t.innerHTML = `<span class="toast-ic">${icon(ic)}</span><span class="toast-msg">${escapeHtml(msg)}</span>`;
  t.classList.add('show', type);
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2800);
}

async function poll() {
  try {
    const r = await fetch('/_api/status');
    const d = await r.json();
    renderStats(d.summary);
    renderKeys(d.keys);
    renderRunKeys(d.keys);
    renderLog(d.log);
    renderAnalytics(d.analytics);
  } catch (e) {}
}

function renderStats(s) {
  $('s-active').textContent = s.active;
  $('s-exp').textContent = s.expired;
  $('s-reqs').textContent = s.requests;
  $('s-up').textContent = fmtUptime(s.uptime);
  $('hdr-port').textContent = 'localhost:' + s.port;
  $('key-count').textContent = s.total;
  const badge = $('hdr-model');
  if (s.model) { badge.style.display = ''; $('hdr-model-text').textContent = shortModel(s.model); }
  else badge.style.display = 'none';
  const warn = $('claude-warn');
  if (warn) warn.style.display = (s.claude_installed === false) ? '' : 'none';
}

function statusPill(k) {
  if (k.status === 'expired') {
    return `<span class="pill expired">${icon('clock')} ${t('pill_expired')} · ${k.remaining_str}</span>`;
  }
  if (k.status === 'error') {
    const lbl = k.kind === 'dead' ? t('pill_dead')
              : k.kind === 'exhausted' ? t('pill_exhausted')
              : t('pill_error');
    const code = k.code ? ` · ${k.code}` : '';
    return `<span class="pill error">${icon('alert')} ${lbl}${code}</span>`;
  }
  return `<span class="pill active"><span class="d"></span>${t('pill_active')}</span>`;
}

function renderKeys(keys) {
  const el = $('keys');
  $('key-count').textContent = keys.length;
  if (!keys.length) {
    el.innerHTML = `<div class="empty"><div class="big">${icon('database')}</div>${t('empty_keys')}</div>`;
    cscroll && cscroll.sync();
    return;
  }
  el.innerHTML = keys.map(k => {
    const cool = k.status === 'expired';
    const meta = k.total ? `${k.total} ${t('unit_req')}${k.errors ? ` · ${k.errors} ${t('unit_err')}` : ''}` : t('idle');
    let sub, actions;
    if (cool) {
      const total = k.window || (5 * 3600);
      const pct = Math.max(0, Math.min(100, (k.remaining / total) * 100));
      const lbl = k.window_label ? `<span class="meta limit">${escapeHtml(k.window_label)}</span>` : '';
      sub = `<div class="bar"><i style="width:${pct}%"></i></div>${lbl}<span class="meta">${meta}</span>`;
      actions = `<button class="icon-btn warm" title="${t('t_cool_cleared')}" onclick="clearCool(${k.index})">${icon('rotate')}</button>
        <button class="icon-btn danger" onclick="delKey(${k.index})">${icon('x')}</button>`;
    } else {
      sub = `<span class="meta">${meta}</span>`;
      actions = `<button class="icon-btn danger" onclick="delKey(${k.index})">${icon('x')}</button>`;
    }
    return `<div class="key ${cool ? 'cool' : ''}">
      <span class="idx">${k.index + 1}</span>
      <div class="body">
        <div class="mono">${k.short}</div>
        <div class="sub">${sub}</div>
      </div>
      ${statusPill(k)}
      <div class="actions">${actions}</div>
    </div>`;
  }).join('');
  cscroll && cscroll.sync();
}

let lastRunKeysSig = '';
function renderRunKeys(keys) {
  const sel = $('run-key');
  if (!sel) return;
  const sig = LANG + '|' + (keys || []).map(k => `${k.index}:${k.short}:${k.status}`).join('|');
  if (sig === lastRunKeysSig) return;
  lastRunKeysSig = sig;
  const prev = sel.value;
  let html = `<option value="">${t('run_key_auto')}</option>`;
  html += (keys || []).map(k => {
    const tag = k.status === 'expired' ? ` · ${t('pill_expired')}`
              : k.status === 'error' ? ` · ${t('pill_error')}` : '';
    return `<option value="${k.index}">${k.index + 1} · ${escapeHtml(k.short)}${tag}</option>`;
  }).join('');
  sel.innerHTML = html;
  if (prev && (keys || []).some(k => String(k.index) === prev)) sel.value = prev;
}

function renderLog(log) {
  const el = $('log');
  $('log-count').textContent = log.length;
  if (!log.length) {
    el.innerHTML = `<div class="empty"><div class="big">${icon('inbox')}</div>${t('empty_log')}</div>`;
    lastLogLen = 0;
    return;
  }
  const grew = log.length !== lastLogLen;
  lastLogLen = log.length;
  el.innerHTML = log.map((r, i) => {
    const sc = r.status;
    const cls = sc >= 500 ? 'err' : sc >= 400 ? (sc === 429 ? 'warn' : 'err') : 'ok';
    const noAnim = grew && i === 0 ? '' : 'style="animation:none"';
    return `<div class="log-row" ${noAnim}>
      <span class="log-time">${r.time}</span>
      <div class="log-mid">
        <div class="log-path">${escapeHtml(r.path)}</div>
        <div class="log-key">${escapeHtml(r.key)}</div>
      </div>
      <div class="log-right">
        <span class="log-dur">${r.duration_ms}ms</span>
        <span class="code ${cls}">${sc}</span>
      </div>
    </div>`;
  }).join('');
}

function renderAnalytics(a) {
  if (!a) return;
  $('m-success').textContent = a.success_rate;
  $('m-latency').textContent = a.avg_latency;
  $('m-total').textContent = Object.values(a.buckets).reduce((s, v) => s + v, 0);
  drawSeries(a.series);
  drawDonut(a.buckets);
  drawLoad(a.load);
}

async function addKey() {
  const inp = $('new-key');
  const key = inp.value.trim();
  if (!key) { toast(t('t_paste_first'), 'error'); return; }
  const r = await fetch('/_api/keys/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  const d = await r.json();
  if (d.ok) { inp.value = ''; toast(t('t_key_added')); poll(); }
  else toast(mapErr(d.error), 'error');
}

async function delKey(i) {
  if (!confirm(t('confirm_delete'))) return;
  await fetch('/_api/keys/' + i, { method: 'DELETE' });
  toast(t('t_key_removed')); poll();
}

async function clearCool(i) {
  await fetch('/_api/keys/' + i + '/cooldown', { method: 'DELETE' });
  toast(t('t_cool_cleared')); poll();
}

async function testKeys() {
  const btn = $('dock-test');
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  toast(t('t_testing'), 'info');
  try {
    const r = await fetch('/_api/keys/test', { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      const s = d.summary;
      toast(t('test_result', d.results.length, s.active, s.expired, s.error),
            s.error ? 'info' : 'success');
    } else toast(t('t_test_failed'), 'error');
  } catch (e) { toast(t('t_test_failed'), 'error'); }
  finally { btn.classList.remove('busy'); poll(); }
}

const DIR_HISTORY_KEY = 'fms-dir-history';
const DIR_HISTORY_MAX = 12;

function loadDirHistory() {
  try { return JSON.parse(localStorage.getItem(DIR_HISTORY_KEY)) || []; }
  catch (e) { return []; }
}
function saveDir(dir) {
  if (!dir) return;
  let list = loadDirHistory().filter(d => d.toLowerCase() !== dir.toLowerCase());
  list.unshift(dir);
  list = list.slice(0, DIR_HISTORY_MAX);
  try { localStorage.setItem(DIR_HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  renderDirHistory(list);
}
function renderDirHistory(list) {
  const dl = $('dir-history');
  if (!dl) return;
  list = list || loadDirHistory();
  dl.innerHTML = list.map(d => `<option value="${escapeHtml(d)}"></option>`).join('');
}

async function runClaude() {
  const dir = $('work-dir').value.trim();
  const msg = $('run-msg');
  if (!dir) { msg.style.color = 'var(--red)'; msg.textContent = t('run_enter_dir'); return; }
  msg.style.color = 'var(--ink-faint)'; msg.textContent = t('run_launching');
  const sel = $('run-key');
  const keyIndex = sel && sel.value !== '' ? parseInt(sel.value, 10) : null;
  const r = await fetch('/_api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir, keyIndex }) });
  const d = await r.json();
  if (d.ok) {
    msg.style.color = 'var(--green)'; msg.innerHTML = icon('check') + ' ' + t('run_launched');
    toast(t('t_launched'));
    saveDir(dir);
  }
  else { msg.style.color = 'var(--red)'; msg.textContent = mapErr(d.error); }
}

function clearLog() {
  fetch('/_api/log/clear', { method: 'POST' }).then(() => { toast(t('t_log_cleared')); poll(); });
}

class CScroll {
  constructor(view, thumb, bar) {
    this.view = view; this.thumb = thumb; this.bar = bar;
    this.view.addEventListener('scroll', () => this.sync());
    window.addEventListener('resize', () => this.sync());
    thumb.addEventListener('mousedown', e => this.startDrag(e));
    this.sync();
  }
  sync() {
    const v = this.view;
    const ratio = v.clientHeight / v.scrollHeight;
    if (ratio >= 1) { this.bar.style.display = 'none'; return; }
    this.bar.style.display = '';
    const trackH = v.clientHeight;
    const thumbH = Math.max(24, ratio * trackH);
    const maxTop = trackH - thumbH;
    const top = (v.scrollTop / (v.scrollHeight - v.clientHeight)) * maxTop;
    this.thumb.style.height = thumbH + 'px';
    this.thumb.style.transform = `translateY(${top}px)`;
  }
  startDrag(e) {
    e.preventDefault();
    const v = this.view;
    const startY = e.clientY, startScroll = v.scrollTop;
    const trackH = v.clientHeight, thumbH = this.thumb.offsetHeight;
    const scrollable = v.scrollHeight - v.clientHeight, maxTop = trackH - thumbH;
    this.bar.classList.add('dragging');
    const move = ev => { v.scrollTop = startScroll + ((ev.clientY - startY) / maxTop) * scrollable; };
    const up = () => {
      this.bar.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
}
let cscroll = null;

document.addEventListener('DOMContentLoaded', () => {
  LANG = getSavedLang();
  hydrateIcons();
  applyI18n();
  cscroll = new CScroll($('keys-view'), $('keys-thumb'), $('keys-bar'));
  $('new-key').addEventListener('keydown', e => { if (e.key === 'Enter') addKey(); });
  $('work-dir').addEventListener('keydown', e => { if (e.key === 'Enter') runClaude(); });
  const hist = loadDirHistory();
  renderDirHistory(hist);
  if (hist.length && !$('work-dir').value) $('work-dir').value = hist[0];
  poll();
  setInterval(poll, 1500);
});
