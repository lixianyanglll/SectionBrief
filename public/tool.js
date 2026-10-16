(() => {
  const CH = 'wb-section-brief';
  const LS_KEY = 'wb-section-target';

  const $ = (s) => document.querySelector(s);
  const el = {
    input: $('#targetInput'),
    open: $('#openBtn'),
    status: $('#status'),
    frame: $('#pageFrame'),
    empty: $('#stageEmpty'),
    selBadge: $('#selBadge'),
    selInfo: $('#selInfo'),
    exportBtn: $('#exportBtn'),
    copyBtn: $('#copyBtn'),
    clearSelBtn: $('#clearSelBtn'),
    intent: $('#intent'),
    promptOut: $('#promptOut'),
    copyPromptBtn: $('#copyPromptBtn'),
    promptBadge: $('#promptBadge'),
    list: $('#sectionList'),
    count: $('#countBadge'),
    sandboxCard: $('#sandboxCard'),
    sandboxName: $('#sandboxName'),
    sandboxFrame: $('#sandboxFrame'),
  };

  const state = { target: '', selection: null, sections: [], sandbox: null };

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const setStatus = (t) => { el.status.textContent = t; };

  /* ---------------- 通信 ---------------- */

  const bc = (() => { try { return new BroadcastChannel(CH); } catch { return null; } })();

  const frameWin = () => { try { return el.frame.contentWindow; } catch { return null; } };

  const send = (type, extra) => {
    const msg = { __wbFromTool: true, type, ...(extra || {}) };
    try { if (bc) bc.postMessage(msg); } catch { /* 忽略 */ }
    try { const w = frameWin(); if (w) w.postMessage(msg, '*'); } catch { /* 忽略 */ }
  };

  let everGotSections = false;
  let lastPick = null;
  let chan = '-';

  function handleMsg(m, via) {
    if (!m || !m.__wb) return;
    if (m.type === 'ready') {
      chan = via;
      setStatus(`页面已加载 · ${m.payload.count} 块`);
      send('refresh');
    }
    if (m.type === 'sections') {
      chan = via;
      everGotSections = true;
      state.sections = m.payload || [];
      renderSections();
      if (!state.selection) setStatus(`识别到 ${state.sections.length} 个板块`);
    }
    if (m.type === 'select') {
      chan = via;
      lastPick = m.payload.pickedAt;
      applySelection(m.payload);
    }
    if (m.type === 'clear') {
      chan = via;
      lastPick = null;
      applySelection(null);
    }
    if (m.type === 'select-error') {
      setStatus('选中失败：' + m.payload.message);
    }
  }

  if (bc) bc.onmessage = (ev) => handleMsg(ev.data, 'bc');
  window.addEventListener('message', (ev) => handleMsg(ev.data, 'pm'));

  /* 轮询兜底：内置预览面板里 BroadcastChannel / postMessage 都可能被隔断，
     只要本地服务读写通，选中结果就一定能同步到右栏 */
  setInterval(async () => {
    if (!state.target) return;
    try {
      const st = await fetch('/api/state?t=' + Date.now()).then((r) => r.json());
      const sel = st.selection;
      if (!sel) {
        if (state.selection) applySelection(null);
        return;
      }
      if (sel.pickedAt === lastPick) return;
      lastPick = sel.pickedAt;
      chan = 'poll';
      let full = sel;
      try {
        const f = await fetch('/api/selection?t=' + Date.now()).then((r) => r.json());
        if (f.ok && f.selection && f.selection.pickedAt === sel.pickedAt) full = f.selection;
      } catch { /* 退化为轻量数据 */ }
      applySelection(full);
    } catch { /* 服务未就绪，忽略 */ }
  }, 700);

  setInterval(() => {
    if (state.target && !everGotSections) send('refresh');
  }, 1500);

  function applySelection(sel) {
    state.selection = sel;
    renderSelection();
    refreshPrompt();
    const chip = document.getElementById('selChip');
    if (chip) {
      if (sel) {
        chip.hidden = false;
        chip.innerHTML = `已选中 <b>${esc(sel.name)}</b> <span class="dim">${sel.rect.w} × ${sel.rect.h}</span>`;
      } else {
        chip.hidden = true;
      }
    }
    setStatus(sel ? `已选中「${sel.name}」 · 通道 ${chan}` : `识别到 ${state.sections.length} 个板块`);
  }

  /* ---------------- 打开目标 ---------------- */

  async function open(src) {
    const val = String(src || '').trim().replace(/^"|"$/g, '');
    if (!val) return;
    state.target = val;
    state.selection = null;
    state.sections = [];
    everGotSections = false;
    lastPick = null;
    applySelection(null);
    localStorage.setItem(LS_KEY, val);
    el.input.value = val;
    setStatus('正在加载…');

    el.frame.onload = () => {
      el.empty.hidden = true;
      setStatus('预览已加载，正在分块…');
      watchLoaded();
    };

    try {
      const res = await fetch('/api/target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: val }),
      });
      const info = await res.json();
      if (!info.ok) throw new Error('设置目标失败');
      el.empty.hidden = true;
      el.frame.src = '/preview?src=' + encodeURIComponent(info.target) + '&t=' + Date.now();
      watchLoaded();
    } catch (err) {
      el.empty.hidden = false;
      setStatus('打开失败：' + err.message);
    }
  }

  let loadTimer = null;
  function watchLoaded() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      if (everGotSections) return;
      setStatus('预览已加载，但没收到分块数据 —— 脚本可能被预览环境拦了，换个路径或刷新试试');
    }, 4500);
  }

  el.open.onclick = () => open(el.input.value);
  el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(el.input.value); });

  /* ---------------- 渲染 ---------------- */

  function renderSelection() {
    const s = state.selection;
    if (!s) {
      el.selBadge.textContent = '未选中';
      el.selInfo.innerHTML = '<p class="sub">在左侧预览里点一个板块</p>';
      el.exportBtn.disabled = true;
      el.clearSelBtn.disabled = true;
      el.copyBtn.disabled = !state.sandbox;
      return;
    }
    const kb = (n) => (Number(n || 0) / 1024).toFixed(1) + ' KB';
    el.selBadge.textContent = s.name;
    el.selInfo.innerHTML = `
      <dl class="kv">
        <dt>元素</dt><dd>&lt;${esc(s.tag)}&gt;${s.id ? ' #' + esc(s.id) : ''}</dd>
        <dt>尺寸</dt><dd>${s.rect.w} × ${s.rect.h}</dd>
        <dt>纵坐标</dt><dd>y = ${s.rect.y} / 页高 ${s.docHeight}</dd>
        <dt>子元素</dt><dd>${s.childCount}</dd>
        <dt>选择器</dt><dd title="${esc(s.selector)}">${esc(s.selector)}</dd>
      </dl>
      ${s.textSample ? `<p class="sub">${esc(s.textSample.slice(0, 100))}</p>` : ''}
      <p class="sub">HTML ${kb(s.html && s.html.length)} · CSS 规则 ${kb(s.css && s.css.length)}</p>`;
    el.exportBtn.disabled = !s.html;
    el.clearSelBtn.disabled = false;
    el.copyBtn.disabled = !state.sandbox;
  }

  function renderSections() {
    el.count.textContent = state.sections.length;
    if (!state.sections.length) {
      el.list.innerHTML = '<p class="sub">还没识别到板块</p>';
      return;
    }
    el.list.innerHTML = state.sections
      .map(
        (s, i) => `<div class="item" data-i="${i}">
          <span class="nm">${esc(s.name)}</span>
          <span class="tag">&lt;${esc(s.tag)}&gt;</span>
          <span class="dim">${s.rect.w}×${s.rect.h}</span>
        </div>`
      )
      .join('');
    el.list.querySelectorAll('.item').forEach((node) => {
      node.onclick = () => {
        send('select-index', { i: Number(node.dataset.i) });
        [...el.list.children].forEach((c) => c.classList.remove('active'));
        node.classList.add('active');
      };
    });
  }

  /* ---------------- 生成修改指令 ---------------- */

  const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

  function buildPrompt(sel, intent) {
    if (!sel) return '';
    const s = sel.source || {};
    const L = [];

    L.push('【只改下面这一个板块，不要动页面其它部分】');
    L.push('');
    L.push('目标文件：' + (s.file || state.target || '(未知)'));
    if (s.located) {
      L.push(`准确位置：第 ${s.startLine}–${s.endLine} 行（共 ${s.lines} 行）`);
    } else {
      L.push('准确位置：没能定位到源码行号，请按下面的选择器在文件里搜索定位');
    }
    L.push('DOM 路径：' + sel.selector);
    L.push(`节点尺寸：${sel.rect.w} × ${sel.rect.h}（页面视口 ${sel.viewport.w} × ${sel.viewport.h}）`);

    const cls = (sel.classes || []).slice(0, 3).join(' ');
    L.push(
      `板块标识：${sel.name}  <${sel.tag}${sel.id ? ' id="' + sel.id + '"' : ''}${cls ? ' class="' + cls + '"' : ''}>`
    );
    L.push(`子元素数量：${sel.childCount}`);

    if (sel.textSample) L.push('板块内文字：' + sel.textSample);

    const st = sel.styles || {};
    const keys = Object.keys(st).slice(0, 14);
    if (keys.length) {
      L.push('');
      L.push('当前关键样式：');
      for (const k of keys) L.push('  ' + kebab(k) + ': ' + st[k]);
    }

    L.push('');
    L.push('【我想怎么改】');
    L.push(
      intent && intent.trim()
        ? intent.trim()
        : '（我还没写具体想法，请先根据上面的板块信息给 2~3 个改进方案让我挑）'
    );

    L.push('');
    L.push('【硬性约束】');
    L.push('1. 只改这一个板块对应的代码，不要改其它板块的结构和样式。');
    L.push('2. 如果这次改动会波及别的区域，先说明影响范围，再动手。');
    L.push('3. 保持项目现有的代码风格和命名习惯，不要顺手重构无关代码。');
    L.push('4. 改完告诉我具体改了文件的哪几行。');

    return L.join('\n');
  }

  function refreshPrompt() {
    const sel = state.selection;
    el.promptOut.value = buildPrompt(sel, el.intent.value);
    el.copyPromptBtn.disabled = !sel;
    if (!sel) el.promptBadge.textContent = '待选中';
    else if (sel.source && sel.source.located) {
      el.promptBadge.textContent = `第 ${sel.source.startLine}–${sel.source.endLine} 行`;
    } else el.promptBadge.textContent = '未定位到行号';
  }

  el.intent.addEventListener('input', refreshPrompt);

  el.copyPromptBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(el.promptOut.value);
      setStatus('指令已复制，粘给开发智能体即可');
    } catch {
      el.promptOut.focus();
      el.promptOut.select();
      setStatus('自动复制被拦，已全选，按 Ctrl+C');
    }
  };

  el.clearSelBtn.onclick = async () => {
    send('reselect');
    lastPick = null;
    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
    } catch { /* 忽略 */ }
    applySelection(null);
    setStatus('已取消选中');
  };

  /* ---------------- 抽离 ---------------- */

  el.exportBtn.onclick = async () => {
    const s = state.selection;
    if (!s) return;
    el.exportBtn.disabled = true;
    setStatus('正在生成沙盒…');
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: s.name,
          html: s.html,
          css: s.css,
          meta: {
            name: s.name, tag: s.tag, id: s.id, classes: s.classes,
            selector: s.selector, rect: s.rect, target: s.target,
            styles: s.styles, textSample: s.textSample,
          },
        }),
      });
      const info = await res.json();
      if (!info.ok) throw new Error('生成失败');
      state.sandbox = info;
      el.sandboxCard.hidden = false;
      el.sandboxName.textContent = info.name;
      el.sandboxFrame.src = info.url + '?t=' + Date.now();
      el.copyBtn.disabled = false;
      setStatus('沙盒已生成');
    } catch (err) {
      setStatus('生成失败：' + err.message);
    } finally {
      el.exportBtn.disabled = false;
    }
  };

  el.copyBtn.onclick = async () => {
    if (!state.sandbox) return;
    try {
      await navigator.clipboard.writeText(state.sandbox.file);
      setStatus('路径已复制');
      setTimeout(() => setStatus('沙盒已生成'), 1500);
    } catch {
      setStatus('复制失败，路径：' + state.sandbox.file);
    }
  };

  /* ---------------- 启动 ---------------- */

  const params = new URLSearchParams(location.search);
  const initial = params.get('src') || localStorage.getItem(LS_KEY) || '';
  if (initial) {
    el.input.value = initial;
    open(initial);
  } else {
    setStatus('等待目标文件');
  }
})();
