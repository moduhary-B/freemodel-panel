import json
import sqlite3
import time
from pathlib import Path

BASE_DIR = Path(__file__).parent
DB_FILE = BASE_DIR / "fms.db"
KEYS_FILE = BASE_DIR / "keys.txt"
COOLDOWNS_FILE = BASE_DIR / "cooldowns.json"

COOLDOWN_SECONDS = 5 * 60 * 60


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def short_key(key: str) -> str:
    return f"{key[:10]}…{key[-6:]}" if key and len(key) > 18 else (key or "—")


def init_db():
    with _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS keys (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                key            TEXT UNIQUE NOT NULL,
                added_at       REAL NOT NULL,
                cooldown_until REAL NOT NULL DEFAULT 0,
                cooldown_total REAL NOT NULL DEFAULT 0,
                total          INTEGER NOT NULL DEFAULT 0,
                errors         INTEGER NOT NULL DEFAULT 0
            );
            DROP TABLE IF EXISTS chats;
            """
        )
        cols = {r["name"] for r in c.execute("PRAGMA table_info(keys)")}
        post_release = (
            ("cooldown_total", "REAL NOT NULL DEFAULT 0"),
            ("last_code", "INTEGER NOT NULL DEFAULT 0"),
            ("last_status", "TEXT NOT NULL DEFAULT ''"),
            ("last_check", "REAL NOT NULL DEFAULT 0"),
        )
        for col, ddl in post_release:
            if col not in cols:
                c.execute(f"ALTER TABLE keys ADD COLUMN {col} {ddl}")
    _migrate_legacy()


def _migrate_legacy():
    with _conn() as c:
        already = c.execute("SELECT COUNT(*) AS n FROM keys").fetchone()["n"]
    if already:
        return
    if not KEYS_FILE.exists():
        return

    keys = [l.strip() for l in KEYS_FILE.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not keys:
        return

    cooldowns = {}
    if COOLDOWNS_FILE.exists():
        try:
            cooldowns = json.loads(COOLDOWNS_FILE.read_text(encoding="utf-8"))
        except Exception:
            cooldowns = {}

    now = time.time()
    with _conn() as c:
        for i, k in enumerate(keys):
            c.execute(
                "INSERT OR IGNORE INTO keys (key, added_at, cooldown_until) VALUES (?, ?, ?)",
                (k, now + i * 1e-6, float(cooldowns.get(k, 0))),
            )


def load_keys() -> list[str]:
    with _conn() as c:
        return [r["key"] for r in c.execute("SELECT key FROM keys ORDER BY id")]


def add_key(key: str) -> tuple[bool, str]:
    key = key.strip()
    if not key:
        return False, "Empty key"
    with _conn() as c:
        exists = c.execute("SELECT 1 FROM keys WHERE key = ?", (key,)).fetchone()
        if exists:
            return False, "Key already exists"
        c.execute(
            "INSERT INTO keys (key, added_at) VALUES (?, ?)", (key, time.time())
        )
    return True, ""


def _key_at_index(c: sqlite3.Connection, index: int) -> str | None:
    rows = c.execute("SELECT key FROM keys ORDER BY id").fetchall()
    if not (0 <= index < len(rows)):
        return None
    return rows[index]["key"]


def key_by_index(index: int) -> str | None:
    with _conn() as c:
        return _key_at_index(c, index)


def delete_key_by_index(index: int) -> str | None:
    with _conn() as c:
        key = _key_at_index(c, index)
        if key is None:
            return None
        c.execute("DELETE FROM keys WHERE key = ?", (key,))
    return key


def clear_cooldown_by_index(index: int) -> str | None:
    with _conn() as c:
        key = _key_at_index(c, index)
        if key is None:
            return None
        c.execute("UPDATE keys SET cooldown_until = 0, cooldown_total = 0 WHERE key = ?", (key,))
    return key


def get_free_key(exclude: set[str] | None = None) -> tuple[str | None, list[str]]:
    exclude = exclude or set()
    now = time.time()
    expired: list[str] = []
    with _conn() as c:
        rows = c.execute("SELECT key, cooldown_until FROM keys ORDER BY id").fetchall()
        for r in rows:
            if 0 < r["cooldown_until"] <= now:
                expired.append(r["key"])
        if expired:
            c.executemany(
                "UPDATE keys SET cooldown_until = 0, cooldown_total = 0 WHERE key = ?",
                [(k,) for k in expired],
            )
    for r in rows:
        k = r["key"]
        if k in exclude:
            continue
        if r["cooldown_until"] > now:
            continue
        return k, expired
    return None, expired


def cooldown_remaining(key: str) -> int:
    now = time.time()
    with _conn() as c:
        row = c.execute("SELECT cooldown_until FROM keys WHERE key = ?", (key,)).fetchone()
    if not row:
        return 0
    rem = int(row["cooldown_until"] - now)
    return rem if rem > 0 else 0


def apply_cooldown(key: str, seconds: float | None = None) -> tuple[float, float]:
    total = float(seconds) if seconds and seconds > 0 else float(COOLDOWN_SECONDS)
    until = time.time() + total
    with _conn() as c:
        c.execute(
            "UPDATE keys SET cooldown_until = ?, cooldown_total = ? WHERE key = ?",
            (until, total, key),
        )
    return until, total


def clear_cooldown(key: str):
    with _conn() as c:
        c.execute(
            "UPDATE keys SET cooldown_until = 0, cooldown_total = 0 WHERE key = ?", (key,)
        )


def record_check(key: str, code: int, status: str):
    with _conn() as c:
        c.execute(
            "UPDATE keys SET last_code = ?, last_status = ?, last_check = ? WHERE key = ?",
            (int(code or 0), status or "", time.time(), key),
        )


def mark_cooldown(key: str) -> float:
    until, _ = apply_cooldown(key)
    return until


def set_cooldown(key: str, until: float):
    if until <= 0:
        clear_cooldown(key)
    else:
        with _conn() as c:
            c.execute("UPDATE keys SET cooldown_until = ? WHERE key = ?", (until, key))


def incr_stats(key: str, is_error: bool):
    with _conn() as c:
        c.execute(
            "UPDATE keys SET total = total + 1, errors = errors + ? WHERE key = ?",
            (1 if is_error else 0, key),
        )


def next_cooldown_expiry() -> float | None:
    now = time.time()
    with _conn() as c:
        row = c.execute(
            "SELECT MIN(cooldown_until) AS m FROM keys WHERE cooldown_until > ?", (now,)
        ).fetchone()
    return row["m"] if row and row["m"] else None


def fmt_remaining(secs: int) -> str:
    d = secs // 86400
    h = (secs % 86400) // 3600
    m = (secs % 3600) // 60
    s = secs % 60
    if d:
        return f"{d}d {h:02d}h {m:02d}m"
    if h:
        return f"{h}h {m:02d}m {s:02d}s"
    return f"{m}m {s:02d}s"


def window_label(total: float) -> str:
    if total <= 0:
        return ""
    if total >= 6 * 86400:
        return f"{round(total / 86400)}-day limit"
    if total >= 86400:
        return f"{round(total / 86400)}-day limit"
    if total >= 3600:
        return f"{round(total / 3600)}h limit"
    return f"{max(1, round(total / 60))}m limit"


def keys_status() -> list[dict]:
    now = time.time()
    result = []
    with _conn() as c:
        rows = c.execute(
            "SELECT key, cooldown_until, cooldown_total, total, errors, "
            "last_code, last_status, last_check FROM keys ORDER BY id"
        ).fetchall()
    for i, r in enumerate(rows):
        key = r["key"]
        entry = {
            "index": i,
            "key": key,
            "short": short_key(key),
            "total": r["total"],
            "errors": r["errors"],
            "last_code": r["last_code"],
            "last_check": r["last_check"],
        }
        remaining = int(r["cooldown_until"] - now)
        if r["cooldown_until"] > now and remaining > 0:
            window = r["cooldown_total"] or COOLDOWN_SECONDS
            entry.update(
                {
                    "status": "expired",
                    "remaining": remaining,
                    "remaining_str": fmt_remaining(remaining),
                    "window": int(window),
                    "window_label": window_label(window),
                }
            )
        elif r["last_status"] in ("dead", "exhausted"):
            entry["status"] = "error"
            entry["kind"] = r["last_status"]
            entry["code"] = r["last_code"]
        else:
            entry["status"] = "active"
        result.append(entry)
    return result
