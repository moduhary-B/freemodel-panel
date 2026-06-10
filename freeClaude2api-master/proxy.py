import asyncio
import json
import os
import subprocess
import sys
import time
import shutil
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

import db

UPSTREAM = "https://cc.freemodel.dev"
BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
INDEX_FILE = STATIC_DIR / "index.html"
PORT = 8742
PROBE_PATH = "/_api/chat"
CHECK_INTERVAL = 600

request_log: deque = deque(maxlen=200)
started_at = time.time()
total_requests = 0
last_seen_model: str | None = None

status_buckets = {"2xx": 0, "429": 0, "4xx": 0, "5xx": 0}
latency_sum = 0
latency_count = 0
timeline: dict[int, int] = {}


@asynccontextmanager
async def lifespan(_app: "FastAPI"):
    task = asyncio.create_task(auto_check_loop()) if CHECK_INTERVAL > 0 else None
    try:
        yield
    finally:
        if task:
            task.cancel()
            try:
                await task
            except BaseException:
                pass


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

if sys.platform == "win32":
    try:
        import ctypes
        k = ctypes.windll.kernel32
        k.SetConsoleOutputCP(65001)
        k.SetConsoleCP(65001)
        h = k.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if k.GetConsoleMode(h, ctypes.byref(mode)):
            k.SetConsoleMode(h, mode.value | 0x0004)
    except Exception:
        os.system("")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
else:
    os.system("")
R = "\033[0m"; B = "\033[1m"; DIM = "\033[90m"
GREEN = "\033[32m"; YEL = "\033[33m"; RED = "\033[31m"; CYAN = "\033[36m"
ORANGE = "\033[38;5;173m"; BLUE = "\033[38;5;110m"

short_key = db.short_key


def banner():
    statuses = db.keys_status()
    active = sum(1 for s in statuses if s["status"] == "active")
    total = len(statuses)
    print(f"""{ORANGE}{B}
   ███████╗███╗   ███╗███████╗
   ██╔════╝████╗ ████║██╔════╝   FreeModel Swapper
   █████╗  ██╔████╔██║███████╗   Claude API key balancer
   ██╔══╝  ██║╚██╔╝██║╚════██║
   ██║     ██║ ╚═╝ ██║███████║
   ╚═╝     ╚═╝     ╚═╝╚══════╝{R}

  {DIM}Proxy     {R}{CYAN}http://localhost:{PORT}{R}
  {DIM}Dashboard {R}{CYAN}http://localhost:{PORT}/{R}
  {DIM}Upstream  {R}{UPSTREAM}
  {DIM}Keys      {R}{B}{total}{R} total · {GREEN}{active} active{R}
  {DIM}Database  {R}{db.DB_FILE.name}
  {DIM}Creator   {R}{CYAN}TG: @Kryv1x{R}
  {DIM}{'─' * 60}{R}""", flush=True)


def event(icon_color: str, icon: str, msg: str):
    ts = time.strftime("%H:%M:%S")
    print(f"  {DIM}{ts}{R}  {icon_color}{icon}{R}  {msg}", flush=True)


def kill_existing_on_port(port: int):
    if sys.platform != "win32":
        return
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return
    me = os.getpid()
    pids: set[str] = set()
    needle = f":{port}"
    for line in out.splitlines():
        if needle not in line or "LISTENING" not in line.upper():
            continue
        parts = line.split()
        if parts and parts[-1].isdigit() and int(parts[-1]) != me:
            pids.add(parts[-1])
    for pid in pids:
        try:
            subprocess.run(
                ["taskkill", "/PID", pid, "/F"],
                capture_output=True, timeout=10,
            )
            event(YEL, "✗", f"Killed stale proxy on port {port} (PID {pid})")
        except Exception:
            pass


def get_free_key(exclude: set[str] | None = None) -> str | None:
    key, expired = db.get_free_key(exclude)
    for k in expired:
        event(GREEN, "✓", f"Key {B}{short_key(k)}{R} cooldown expired — back in pool")
    return key


def _parse_retry_after(v: str | None) -> float | None:
    if not v:
        return None
    v = str(v).strip()
    try:
        n = float(v)
        return n if n > 0 else None
    except Exception:
        pass
    try:
        from email.utils import parsedate_to_datetime
        secs = parsedate_to_datetime(v).timestamp() - time.time()
        return secs if secs > 0 else None
    except Exception:
        return None


def _parse_reset(v: str | None) -> float | None:
    if not v:
        return None
    v = str(v).strip()
    try:
        n = float(v)
        if n > 1e12:
            n /= 1000
        if n > 1e9:
            secs = n - time.time()
            return secs if secs > 0 else None
        return n if n > 0 else None
    except Exception:
        pass
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        secs = dt.timestamp() - time.time()
        return secs if secs > 0 else None
    except Exception:
        return None


def _parse_duration_text(msg: str) -> float | None:
    if not msg:
        return None
    import re
    m = re.search(r"(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)", msg.lower())
    if m:
        n = float(m.group(1))
        unit = m.group(2)
        mult = (604800 if unit.startswith("week") else
                86400 if unit.startswith("day") else
                3600 if unit.startswith(("hour", "hr")) else
                60 if unit.startswith(("min",)) else 1)
        return n * mult
    if "week" in msg.lower():
        return 7 * 86400
    return None


def compute_cooldown(resp) -> float | None:
    try:
        h = resp.headers
        secs = _parse_retry_after(h.get("retry-after"))
        if secs:
            return secs
        for name in h.keys():
            if name.lower().endswith("reset"):
                secs = _parse_reset(h.get(name))
                if secs:
                    return secs
        body = resp.content
        msg = ""
        try:
            msg = (json.loads(body).get("error", {}) or {}).get("message", "") or ""
        except Exception:
            msg = body.decode("utf-8", "ignore") if body else ""
        return _parse_duration_text(msg)
    except Exception:
        return None


def apply_cooldown_429(key: str, resp):
    secs = compute_cooldown(resp)
    until, total = db.apply_cooldown(key, secs)
    label = db.window_label(total)
    until_str = time.strftime("%H:%M", time.localtime(until))
    detected = "" if secs else f" {DIM}(default){R}"
    event(YEL, "⏸",
          f"Key {B}{short_key(key)}{R} hit {RED}429{R} — {label}{detected}, back at {until_str}")


def log_request(key: str, path: str, status: int, duration_ms: int):
    global total_requests, latency_sum, latency_count
    total_requests += 1

    if status == 429:
        status_buckets["429"] += 1
    elif status >= 500:
        status_buckets["5xx"] += 1
    elif status >= 400:
        status_buckets["4xx"] += 1
    else:
        status_buckets["2xx"] += 1
        latency_sum += duration_ms
        latency_count += 1

    minute = int(time.time() // 60) * 60
    timeline[minute] = timeline.get(minute, 0) + 1
    cutoff = minute - 60 * 60
    for m in [m for m in timeline if m < cutoff]:
        del timeline[m]

    request_log.appendleft({
        "time": time.strftime("%H:%M:%S"),
        "key": short_key(key) if key else "—",
        "path": path,
        "status": status,
        "duration_ms": duration_ms,
    })
    if key:
        db.incr_stats(key, status >= 400)
    if status == 429:
        pass
    elif status >= 400:
        event(RED, "✗", f"{short_key(key)} {DIM}→{R} {path} {RED}{status}{R} {DIM}{duration_ms}ms{R}")
    else:
        event(GREEN, "→", f"{short_key(key)} {DIM}→{R} {path} {GREEN}{status}{R} {DIM}{duration_ms}ms{R}")


def extract_model(body: bytes) -> str | None:
    try:
        return json.loads(body).get("model")
    except Exception:
        return None


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return INDEX_FILE.read_text(encoding="utf-8")


@app.get("/_api/status")
async def api_status():
    keys = db.keys_status()
    active = sum(1 for k in keys if k["status"] == "active")
    uptime = int(time.time() - started_at)

    now_min = int(time.time() // 60) * 60
    series = [{"t": (now_min - (59 - i) * 60), "v": timeline.get(now_min - (59 - i) * 60, 0)}
              for i in range(60)]

    avg_latency = round(latency_sum / latency_count) if latency_count else 0
    errors = status_buckets["429"] + status_buckets["4xx"] + status_buckets["5xx"]
    success_rate = round((status_buckets["2xx"] / total_requests) * 100) if total_requests else 100

    load = sorted(
        [{"short": k["short"], "total": k.get("total", 0), "errors": k.get("errors", 0)}
         for k in keys if k.get("total", 0) > 0],
        key=lambda x: x["total"], reverse=True,
    )

    return {
        "keys": keys,
        "log": list(request_log),
        "summary": {
            "total": len(keys),
            "active": active,
            "expired": len(keys) - active,
            "requests": total_requests,
            "uptime": uptime,
            "upstream": UPSTREAM,
            "port": PORT,
            "model": last_seen_model,
            "claude_installed": claude_path() is not None,
        },
        "analytics": {
            "series": series,
            "buckets": status_buckets,
            "avg_latency": avg_latency,
            "success_rate": success_rate,
            "errors": errors,
            "load": load,
        },
    }


@app.post("/_api/keys/add")
async def api_add_key(request: Request):
    body = await request.json()
    ok, err = db.add_key(body.get("key", ""))
    if ok:
        event(BLUE, "+", f"Key {B}{short_key(body.get('key', '').strip())}{R} added via dashboard")
        return {"ok": True}
    return {"ok": False, "error": err}


@app.delete("/_api/keys/{index}")
async def api_delete_key(index: int):
    removed = db.delete_key_by_index(index)
    if removed is None:
        return Response(status_code=404)
    event(BLUE, "−", f"Key {B}{short_key(removed)}{R} removed via dashboard")
    return {"ok": True}


@app.delete("/_api/keys/{index}/cooldown")
async def api_clear_cooldown(index: int):
    key = db.clear_cooldown_by_index(index)
    if key is None:
        return Response(status_code=404)
    event(GREEN, "✓", f"Key {B}{short_key(key)}{R} cooldown cleared manually")
    return {"ok": True}


async def _probe_key(client: httpx.AsyncClient, key: str,
                     sem: asyncio.Semaphore) -> dict:
    short = short_key(key)
    try:
        async with sem:
            resp = await client.post(
                UPSTREAM + PROBE_PATH,
                headers={"x-api-key": key, "content-type": "application/json"},
                json={"messages": [{"role": "user", "content": "ping"}]},
            )
        code = resp.status_code
        if code == 429:
            apply_cooldown_429(key, resp)
            db.record_check(key, code, "limited")
            entry = next((e for e in db.keys_status() if e["key"] == key), {})
            return {"short": short, "status": "expired", "code": 429,
                    "remaining_str": entry.get("remaining_str", ""),
                    "window_label": entry.get("window_label", "")}
        if code == 305 or 200 <= code < 300:
            db.clear_cooldown(key)
            db.record_check(key, code, "active")
            return {"short": short, "status": "active", "code": code}
        if code in (401, 403):
            db.record_check(key, code, "dead")
            return {"short": short, "status": "error", "code": code,
                    "kind": "dead", "detail": "invalid key"}
        if code == 402:
            db.record_check(key, code, "exhausted")
            return {"short": short, "status": "error", "code": code,
                    "kind": "exhausted", "detail": "no balance"}
        db.record_check(key, code, "error")
        return {"short": short, "status": "error", "code": code}
    except Exception as e:
        return {"short": short, "status": "error", "code": 0,
                "detail": (str(e) or type(e).__name__)[:80]}


async def probe_all_keys(reason: str = "manual") -> tuple[list[dict], dict]:
    statuses = {e["key"]: e for e in db.keys_status()}
    keys = db.load_keys()
    to_probe = [k for k in keys if statuses.get(k, {}).get("status") != "expired"]
    cooled = [k for k in keys if statuses.get(k, {}).get("status") == "expired"]

    results: list[dict] = []
    sem = asyncio.Semaphore(5)
    async with httpx.AsyncClient(timeout=15) as client:
        raw = await asyncio.gather(
            *[_probe_key(client, k, sem) for k in to_probe],
            return_exceptions=True,
        )
    for k, r in zip(to_probe, raw):
        if isinstance(r, dict):
            results.append(r)
        else:
            results.append({"short": short_key(k), "status": "error", "code": 0,
                            "detail": (str(r) or type(r).__name__)[:80]})
    for k in cooled:
        e = statuses[k]
        results.append({"short": e["short"], "status": "expired", "code": 429,
                        "remaining_str": e.get("remaining_str", ""),
                        "window_label": e.get("window_label", "")})

    summary = {"active": 0, "expired": 0, "error": 0}
    for r in results:
        summary[r["status"]] = summary.get(r["status"], 0) + 1
    tag = "Auto-check" if reason == "auto" else "Test"
    event(GREEN, "✓",
          f"{tag} done — {GREEN}{summary['active']} active{R}, "
          f"{YEL}{summary['expired']} expired{R}, {RED}{summary['error']} error{R}")
    return results, summary


async def auto_check_loop():
    await asyncio.sleep(8)
    while True:
        try:
            keys = db.load_keys()
            if keys:
                event(CYAN, "⚙", f"Auto-checking {B}{len(keys)}{R} key(s)…")
                await probe_all_keys(reason="auto")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            event(RED, "✗", f"Auto-check failed: {e}")
        await asyncio.sleep(CHECK_INTERVAL)


@app.post("/_api/keys/test")
async def api_test_keys():
    keys = db.load_keys()
    if not keys:
        return {"ok": True, "results": [], "summary": {"active": 0, "expired": 0, "error": 0}}
    event(CYAN, "⚙", f"Testing {B}{len(keys)}{R} key(s) against upstream…")
    try:
        results, summary = await probe_all_keys(reason="manual")
    except Exception as e:
        event(RED, "✗", f"Test failed: {e}")
        return {"ok": False, "error": str(e) or "test failed"}
    return {"ok": True, "results": results, "summary": summary}


def claude_path() -> str | None:
    for name in ("claude", "claude.cmd", "claude.exe", "claude.bat", "claude.ps1"):
        p = shutil.which(name)
        if p:
            return p
    return None


@app.post("/_api/run")
async def api_run(request: Request):
    body = await request.json()
    work_dir = body.get("dir", "").strip()
    if not work_dir or not Path(work_dir).exists():
        return {"ok": False, "error": "Directory not found"}
    if claude_path() is None:
        event(RED, "✗", "Claude CLI not found on PATH — cannot launch")
        return {"ok": False, "error": "Claude CLI not installed"}

    api_key = "proxy-managed"
    key_index = body.get("keyIndex")
    if key_index is not None and str(key_index) != "":
        try:
            idx = int(key_index)
        except (TypeError, ValueError):
            return {"ok": False, "error": "Invalid key selection"}
        chosen = db.key_by_index(idx)
        if chosen is None:
            return {"ok": False, "error": "Key not found"}
        api_key = chosen

    env = os.environ.copy()
    env["ANTHROPIC_API_KEY"] = api_key
    env["ANTHROPIC_BASE_URL"] = f"http://localhost:{PORT}"
    for var in ("ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
                "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_REGION",
                "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS"):
        env.pop(var, None)
    try:
        subprocess.Popen(
            ["cmd", "/c", "start", "cmd", "/k", "claude"],
            cwd=work_dir, env=env,
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
        suffix = f" {DIM}· pinned key {short_key(api_key)}{R}" if api_key != "proxy-managed" else ""
        event(CYAN, "▶", f"Claude launched in {B}{work_dir}{R}{suffix}")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/_api/log/clear")
async def api_log_clear():
    global total_requests, latency_sum, latency_count
    request_log.clear()
    timeline.clear()
    for k in status_buckets:
        status_buckets[k] = 0
    total_requests = latency_sum = latency_count = 0
    return {"ok": True}


async def proxy_request(request: Request, tried: set[str] | None = None):
    tried = tried or set()

    incoming = request.headers.get("x-api-key", "")
    pinned = incoming if incoming and incoming in set(db.load_keys()) else None

    if pinned:
        key = pinned
        rem = db.cooldown_remaining(key)
        if rem > 0:
            h, m, s = rem // 3600, (rem % 3600) // 60, rem % 60
            msg = f"Selected key is rate-limited. Free in {h}h {m:02d}m {s:02d}s"
            event(RED, "✗", f"{RED}Pinned key {short_key(key)} busy{R} — free in {h}h {m:02d}m {s:02d}s")
            log_request(key, request.url.path, 429, 0)
            return Response(
                content=json.dumps({"error": {"message": msg, "type": "rate_limit_error"}}),
                status_code=429, media_type="application/json",
            )
    else:
        key = get_free_key(exclude=tried)
        if key is None:
            soonest = db.next_cooldown_expiry() or time.time()
            wait = max(0, int(soonest - time.time()))
            h, m, s = wait // 3600, (wait % 3600) // 60, wait % 60
            msg = f"All keys on cooldown. Next free in {h}h {m:02d}m {s:02d}s"
            event(RED, "✗", f"{RED}All keys busy{R} — next free in {h}h {m:02d}m {s:02d}s")
            log_request("", request.url.path, 429, 0)
            return Response(
                content=json.dumps({"error": {"message": msg, "type": "rate_limit_error"}}),
                status_code=429, media_type="application/json",
            )

    body = await request.body()
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "authorization", "x-api-key",
                             "accept-encoding")
    }
    headers["x-api-key"] = key
    headers.setdefault("anthropic-version", "2023-06-01")

    url = UPSTREAM + request.url.path
    if request.url.query:
        url += "?" + request.url.query

    is_messages = request.method == "POST" and request.url.path.endswith("/v1/messages")
    if is_messages:
        m = extract_model(body)
        if m:
            global last_seen_model
            last_seen_model = m

    is_stream = False
    try:
        is_stream = json.loads(body).get("stream", False)
    except Exception:
        pass

    t0 = time.time()

    if is_stream:
        client = httpx.AsyncClient(timeout=300)
        try:
            req = client.build_request(request.method, url, content=body, headers=headers)
            resp = await client.send(req, stream=True)
        except Exception:
            await client.aclose()
            raise

        if resp.status_code == 429:
            await resp.aread()
            apply_cooldown_429(key, resp)
            await resp.aclose()
            await client.aclose()
            log_request(key, request.url.path, 429, int((time.time() - t0) * 1000))
            if pinned:
                return Response(
                    content=resp.content, status_code=429,
                    media_type=resp.headers.get("content-type", "application/json"),
                )
            tried.add(key)
            if len(tried) < len(db.load_keys()):
                event(CYAN, "↻", "Retrying on next free key…")
            return await proxy_request(request, tried)

        resp_headers = {
            k: v for k, v in resp.headers.items()
            if k.lower() not in ("content-encoding", "transfer-encoding", "content-length")
        }
        status = resp.status_code
        if status < 400:
            db.record_check(key, status, "active")

        async def gen():
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()
                log_request(key, request.url.path, status, int((time.time() - t0) * 1000))

        return StreamingResponse(
            gen(), status_code=status, headers=resp_headers,
            media_type=resp.headers.get("content-type", "text/event-stream"),
        )
    else:
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.request(request.method, url, content=body, headers=headers)
            duration = int((time.time() - t0) * 1000)
            if resp.status_code == 429:
                apply_cooldown_429(key, resp)
                log_request(key, request.url.path, 429, duration)
                if pinned:
                    resp_headers = {
                        k: v for k, v in resp.headers.items()
                        if k.lower() not in ("content-encoding", "transfer-encoding", "content-length")
                    }
                    return Response(
                        content=resp.content, status_code=429,
                        headers=resp_headers,
                        media_type=resp.headers.get("content-type", "application/json"),
                    )
                tried.add(key)
                if len(tried) < len(db.load_keys()):
                    event(CYAN, "↻", "Retrying on next free key…")
                return await proxy_request(request, tried)

            resp_headers = {
                k: v for k, v in resp.headers.items()
                if k.lower() not in ("content-encoding", "transfer-encoding", "content-length")
            }
            if resp.status_code < 400:
                db.record_check(key, resp.status_code, "active")
            log_request(key, request.url.path, resp.status_code, duration)
            return Response(
                content=resp.content, status_code=resp.status_code,
                headers=resp_headers,
                media_type=resp.headers.get("content-type", "application/json"),
            )


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
async def catch_all(request: Request, path: str):
    return await proxy_request(request)


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    event(RED, "✗", f"Unhandled error on {request.url.path}: {exc}")
    return Response(
        content=json.dumps({"error": {"message": str(exc) or "internal error",
                                       "type": "internal_error"}}),
        status_code=500, media_type="application/json",
    )


if __name__ == "__main__":
    import uvicorn
    try:
        db.init_db()
        kill_existing_on_port(PORT)
        banner()
        uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="critical")
    except KeyboardInterrupt:
        pass
    except Exception:
        import traceback
        print(f"\n{RED}{B}  Proxy stopped due to an error:{R}\n", flush=True)
        traceback.print_exc()
        if sys.platform == "win32":
            try:
                input("\n  Press Enter to close… ")
            except Exception:
                pass
