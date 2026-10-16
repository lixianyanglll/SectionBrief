/**
 * 板块简报 · 拾取脚本
 * 由本地服务注入到目标页面，负责：自动分块 / 悬停高亮 / 点击选中 / 轮廓显示 / 数据回传。
 * 同源环境，可直接与调试台通过 BroadcastChannel 通信。
 */
(function () {
  if (window.__WB_SECTION_TOOL__) return;
  window.__WB_SECTION_TOOL__ = true;

  const CHANNEL = 'wb-section-brief';

  const CFG = {
    MIN_W: 96,
    MIN_H: 36,
    MAX_DEPTH: 4,
    STACK_RATIO: 0.72,
    TALL_MULT: 1.0,
    HTML_LIMIT: 60000,
  };

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR', 'HEAD', 'TITLE',
  ]);

  const state = {
    sections: [],
    hover: null,
    selected: null,
    outlines: true,
    picking: true,
  };

  /* ================= 工具函数 ================= */

  const clsOf = (el) => {
    const c = el && el.className;
    if (typeof c === 'string') return c;
    if (c && typeof c.baseVal === 'string') return c.baseVal;
    return '';
  };

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id && el.id.startsWith('__wb')) return false;
    if (el.closest && el.closest('#__wb-bar, #__wb-layer')) return false;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < CFG.MIN_W || r.height < CFG.MIN_H) return false;
    return true;
  }

  const NAME_DICT = [
    [/hero|jumbotron|masthead|banner-?top/, 'Hero 主视觉'],
    [/carousel|slider|swiper/, '轮播区'],
    [/navbar|nav-|navigation|menu/, '导航栏'],
    [/topbar|toolbar|command-?bar|action-?bar/, '工具栏'],
    [/breadcrumb/, '面包屑'],
    [/sidebar|siderail|aside/, '侧边栏'],
    [/chart|graph|trend|visual/, '图表区'],
    [/table|datatable|grid-?view/, '表格区'],
    [/pricing|plan-|tariff/, '价格区'],
    [/testimonial|review|comment/, '评价区'],
    [/faq|question|accordion/, 'FAQ 区'],
    [/gallery|card|grid|list|item|thumb/, '卡片/列表区'],
    [/feature|advantage|benefit|highlight/, '特性区'],
    [/cta|call-?to-?action|signup|subscribe/, '行动号召'],
    [/stat|metric|counter|kpi|number/, '数据区'],
    [/process|step|timeline|workflow/, '流程区'],
    [/team|member|staff|people/, '团队区'],
    [/service|solution|product/, '服务/产品区'],
    [/contact|login|register|form/, '表单区'],
    [/about|intro|description|summary/, '简介区'],
    [/search|filter/, '搜索/筛选区'],
    [/pagination|pager/, '分页'],
    [/alert|notice|tip|toast/, '提示条'],
    [/footer|copyright|bottom/, '页脚'],
    [/header|top-?bar/, '页头'],
    [/content|article|post|main|body-/, '内容区'],
  ];

  function guessName(el) {
    const key = (el.id + ' ' + clsOf(el)).toLowerCase();
    for (const [re, name] of NAME_DICT) if (re.test(key)) return name;
    const tag = el.tagName.toLowerCase();
    const byTag = {
      header: '页头', footer: '页脚', nav: '导航栏', main: '主体',
      aside: '侧边栏', section: '内容区', article: '文章区', form: '表单区',
      table: '表格区', ul: '列表区', figure: '图文区',
    };
    if (byTag[tag]) return byTag[tag];
    return '区块';
  }

  function looksNamed(el) {
    const tag = el.tagName.toLowerCase();
    if (['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'form'].includes(tag)) return true;
    return /hero|banner|nav|header|footer|side|card|list|gallery|feature|pricing|cta|faq|testimonial|contact|about|section|panel|toolbar|breadcrumb|pagination|comment|profile|stat|team|service|process|step|article|content|main|wrapper|container|layout|grid|row|col/i.test(
      clsOf(el) + ' ' + el.id
    );
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    let guard = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 12) {
      if (cur.id && !/^__wb/.test(cur.id)) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      let sel = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => !/^__wb/.test(c));
      if (cls.length) {
        sel += '.' + cls.slice(0, 2).map((c) => CSS.escape(c)).join('.');
      } else if (cur.parentNode) {
        const same = [...cur.parentNode.children].filter((s) => s.tagName === cur.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  const KEEP_STYLES = [
    'display', 'position', 'width', 'height', 'minHeight', 'maxWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'backgroundColor', 'backgroundImage', 'color',
    'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'textAlign',
    'flexDirection', 'justifyContent', 'alignItems', 'gap', 'flexWrap',
    'gridTemplateColumns', 'gridTemplateRows',
    'borderRadius', 'borderTopWidth', 'borderTopStyle', 'borderTopColor',
    'boxShadow', 'overflow', 'zIndex', 'opacity',
  ];

  function pickStyles(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const k of KEEP_STYLES) {
      const v = cs[k];
      if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') out[k] = v;
    }
    return out;
  }

  function collectCss() {
    const chunks = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (/__wb/.test(rule.cssText)) continue;
          chunks.push(rule.cssText);
        }
      } catch {
        /* 跨域样式表读不到，跳过 */
      }
    }
    return chunks.join('\n');
  }

  /* ================= 自动分块 ================= */

  function childrenVisible(el) {
    return Array.from(el.children).filter(isVisible);
  }

  function isStack(el, kids) {
    const cw = el.getBoundingClientRect().width;
    if (cw < 200) return false;
    let wide = 0;
    for (const k of kids) if (k.getBoundingClientRect().width >= cw * CFG.STACK_RATIO) wide++;
    return wide >= Math.ceil(kids.length * 0.6);
  }

  /* 横向分栏：2~3 个孩子都占满视口高度（典型是「侧边栏 + 主列」），各列各自成块。
     不加这条，整个后台布局会被当成一整块，没法细分 */
  function isColumnSplit(kids) {
    if (kids.length < 2 || kids.length > 3) return false;
    const vh = window.innerHeight;
    for (const k of kids) {
      if (k.getBoundingClientRect().height < vh * 0.6) return false;
    }
    return true;
  }

  function detect() {
    const found = [];

    function push(el) {
      if (!found.includes(el)) found.push(el);
    }

    function walk(el, depth) {
      const kids = childrenVisible(el);

      if (kids.length === 0) return push(el);

      if (kids.length === 1) {
        // 单个孩子：只有当自己是个"有名字的块"时才停下，否则继续下钻
        const r = el.getBoundingClientRect();
        if (looksNamed(el) && r.height >= CFG.MIN_H * 2 && depth > 0) return push(el);
        if (depth < CFG.MAX_DEPTH) return walk(kids[0], depth + 1);
        return push(kids[0]);
      }

      const isRoot = el === document.body || el === document.documentElement;
      const stacked = isRoot ? true : isStack(el, kids);
      const split = !stacked && isColumnSplit(kids);

      if (!stacked && !split) return push(el);

      for (const k of kids) {
        const r = k.getBoundingClientRect();
        if (r.height > window.innerHeight * CFG.TALL_MULT && depth < CFG.MAX_DEPTH) walk(k, depth + 1);
        else push(k);
      }
    }

    walk(document.body, 0);

    // 兜底：一个都没切出来，就把 body 的直接子元素全算上
    if (found.length < 2) {
      const kids = childrenVisible(document.body);
      if (kids.length >= 2) {
        found.length = 0;
        kids.forEach(push);
      }
    }

    state.sections = found.map((el) => ({ el, name: guessName(el) }));
    return state.sections;
  }

  function drill(el) {
    const kids = childrenVisible(el);
    if (kids.length < 2) return false;
    const i = state.sections.findIndex((s) => s.el === el);
    if (i >= 0) state.sections.splice(i, 1);
    for (const k of kids) state.sections.push({ el: k, name: guessName(k) });
    return true;
  }

  function climb(el) {
    const parent = el.parentElement;
    if (!parent || parent === document.body) return false;
    if (state.sections.some((s) => s.el === parent)) return false;
    state.sections.push({ el: parent, name: guessName(parent) });
    return true;
  }

  /* ================= 序列化 ================= */

  /* 导出的 HTML 要剥掉调试用的行号属性，别污染用户代码 */
  function cleanOuterHtml(el) {
    const clone = el.cloneNode(true);
    const nodes = [clone, ...(clone.querySelectorAll ? clone.querySelectorAll('*') : [])];
    for (const n of nodes) {
      if (n.removeAttribute) {
        n.removeAttribute('data-wb-l');
        n.removeAttribute('data-wb-e');
      }
    }
    return clone.outerHTML;
  }

  function serialize(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const startLine = Number(el.getAttribute('data-wb-l')) || null;
    const endLine = Number(el.getAttribute('data-wb-e')) || null;
    return {
      name: guessName(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: [...el.classList],
      selector: cssPath(el),
      source: {
        file: window.__WB_TARGET__ || null,
        startLine,
        endLine,
        lines: startLine && endLine ? endLine - startLine + 1 : null,
        located: !!startLine,
      },
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docHeight: document.documentElement.scrollHeight,
      styles: pickStyles(el),
      textSample: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140),
      childCount: el.children.length,
      bg: cs.backgroundColor,
      html: cleanOuterHtml(el).slice(0, CFG.HTML_LIMIT),
      css: collectCss(),
      target: window.__WB_TARGET__ || location.href,
      pickedAt: new Date().toISOString(),
    };
  }

  /* ================= 通信 ================= */

  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;

  function emit(type, payload) {
    const msg = { __wb: true, type, payload };
    try { if (bc) bc.postMessage(msg); } catch { /* 通道被限 */ }
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
    } catch { /* 跨源兜底 */ }
    try {
      if (window.top && window.top !== window && window.top !== window.parent) {
        window.top.postMessage(msg, '*');
      }
    } catch { /* 忽略 */ }
  }

  /* 完整数据交给本地服务落盘。工具页即使收不到任何消息，
     也能靠轮询 /api/state + /api/selection 拿到选中结果——
     这是预览面板里通信被隔断时的兜底通道 */
  function persist(sel) {
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection: sel }),
    }).catch(() => {});
  }

  /* 取消选中：本地状态 + 通知调试台 + 清掉服务端记录。
     不清服务端的话，调试台轮询会把它又捡回来 */
  function clearSelection() {
    if (!state.selected) return;
    state.selected = null;
    repaint();
    updateCounter();
    emit('clear', null);
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    }).catch(() => {});
  }

  function publishSections() {
    const list = state.sections.map((s) => {
      const r = rectOf(s.el);
      return {
        name: s.name,
        tag: s.el.tagName.toLowerCase(),
        selector: cssPath(s.el),
        rect: { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.w), h: Math.round(r.h) },
      };
    });
    emit('sections', list);
    report(list);
  }

  /* 供自动化/排查读取的分块摘要（隐藏节点） */
  let reportNode = null;
  function report(list) {
    try {
      if (!reportNode) {
        reportNode = document.createElement('script');
        reportNode.type = 'application/json';
        reportNode.id = '__wb-report';
        document.documentElement.appendChild(reportNode);
      }
      reportNode.textContent = JSON.stringify({
        ok: true,
        count: list.length,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        target: window.__WB_TARGET__ || location.href,
        sections: list.map((s) => ({ name: s.name, tag: s.tag, sel: s.selector, w: s.rect.w, h: s.rect.h, y: s.rect.y })),
      });
    } catch { /* 忽略 */ }
  }

  /* ================= 覆盖层 ================= */

  const layer = document.createElement('div');
  layer.id = '__wb-layer';
  layer.style.cssText =
    'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483640;';

  const outlineMap = new Map();

  function makeBox(color, fill, dashed) {
    const d = document.createElement('div');
    d.style.cssText =
      `position:absolute;left:0;top:0;box-sizing:border-box;pointer-events:none;` +
      `border:${dashed ? '1px dashed ' + color : '2px solid ' + color};` +
      `background:${fill};border-radius:4px;display:none;transition:transform .05s linear,width .05s linear,height .05s linear;`;
    layer.appendChild(d);
    return d;
  }

  const hoverBox = makeBox('#185FA5', 'rgba(24,95,165,.10)', true);
  const selectBox = makeBox('#D85A30', 'rgba(216,90,48,.10)', false);

  function makeTag(bg) {
    const t = document.createElement('div');
    t.style.cssText =
      `position:absolute;left:0;top:0;pointer-events:none;display:none;` +
      `background:${bg};color:#fff;font:500 12px/1.4 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;` +
      `padding:2px 7px;border-radius:3px;white-space:nowrap;transform:translate(-2px,-100%);`;
    layer.appendChild(t);
    return t;
  }

  const hoverTag = makeTag('#185FA5');
  const selectTag = makeTag('#D85A30');

  function place(box, tag, el, label) {
    const r = rectOf(el);
    box.style.display = 'block';
    box.style.transform = `translate(${r.x}px, ${r.y}px)`;
    box.style.width = r.w + 'px';
    box.style.height = r.h + 'px';
    tag.textContent = label;
    tag.style.display = 'block';
    const above = r.y > 24;
    tag.style.transform = above ? `translate(${Math.max(r.x, 0)}px, ${r.y}px)` : `translate(${Math.max(r.x, 0)}px, ${r.y + 22}px)`;
  }

  function hide(box, tag) {
    box.style.display = 'none';
    tag.style.display = 'none';
  }

  function paintOutlines() {
    const alive = new Set();
    for (const s of state.sections) {
      alive.add(s.el);
      let d = outlineMap.get(s.el);
      if (!d) {
        d = document.createElement('div');
        d.style.cssText =
          'position:absolute;left:0;top:0;box-sizing:border-box;pointer-events:none;' +
          'border:1px dashed rgba(94,94,90,.45);border-radius:4px;';
        layer.appendChild(d);
        outlineMap.set(s.el, d);
      }
      const r = rectOf(s.el);
      d.style.transform = `translate(${r.x}px, ${r.y}px)`;
      d.style.width = r.w + 'px';
      d.style.height = r.h + 'px';
    }
    for (const [el, d] of Array.from(outlineMap)) {
      if (!alive.has(el)) { d.remove(); outlineMap.delete(el); }
    }
  }

  function clearOutlines() {
    for (const [, d] of outlineMap) d.remove();
    outlineMap.clear();
  }

  function repaint() {
    if (state.outlines) paintOutlines();
    else clearOutlines();

    if (state.selected) {
      place(selectBox, selectTag, state.selected.el, `已选中 · ${state.selected.name} · ${Math.round(rectOf(state.selected.el).w)}×${Math.round(rectOf(state.selected.el).h)}`);
    } else hide(selectBox, selectTag);

    if (state.hover && state.hover.el !== (state.selected && state.selected.el)) {
      const r = rectOf(state.hover.el);
      place(hoverBox, hoverTag, state.hover.el, `${state.hover.name} · ${Math.round(r.w)}×${Math.round(r.h)}`);
    } else hide(hoverBox, hoverTag);
  }

  /* ================= 工具条 ================= */

  let bar, counter, clearBtn;

  function buildBar() {
    bar = document.createElement('div');
    bar.id = '__wb-bar';
    bar.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483645;pointer-events:auto;' +
      'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;' +
      'background:#fff;border:1px solid #d3d1c7;box-shadow:0 2px 10px rgba(0,0,0,.10);' +
      'font:400 12px/1.4 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#2c2c2a;';

    const mk = (text, bg, fg) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText =
        `pointer-events:auto;cursor:pointer;border:1px solid #d3d1c7;background:${bg};color:${fg};` +
        'font:inherit;padding:4px 10px;border-radius:6px;';
      return b;
    };

    counter = document.createElement('span');
    counter.style.cssText = 'color:#5f5e5a;padding-right:2px;';

    const togglePick = mk('拾取中', '#e6f1fb', '#0c447c');
    togglePick.onclick = () => {
      state.picking = !state.picking;
      togglePick.textContent = state.picking ? '拾取中' : '已暂停';
      togglePick.style.background = state.picking ? '#e6f1fb' : '#f1efe8';
      togglePick.style.color = state.picking ? '#0c447c' : '#5f5e5a';
      if (!state.picking) { state.hover = null; repaint(); }
    };

    const toggleOutline = mk('轮廓开', '#e1f5ee', '#0f6e56');
    toggleOutline.onclick = () => {
      state.outlines = !state.outlines;
      toggleOutline.textContent = state.outlines ? '轮廓开' : '轮廓关';
      toggleOutline.style.background = state.outlines ? '#e1f5ee' : '#f1efe8';
      toggleOutline.style.color = state.outlines ? '#0f6e56' : '#5f5e5a';
      repaint();
    };

    const rescan = mk('重新分块', '#f1efe8', '#5f5e5a');
    rescan.onclick = () => {
      detect();
      publishSections();
      repaint();
      updateCounter();
    };

    clearBtn = mk('取消选中', '#faece7', '#993c1d');
    clearBtn.style.display = 'none';
    clearBtn.onclick = () => clearSelection();

    const hint = document.createElement('span');
    hint.style.cssText = 'color:#888780;padding-left:2px;';
    hint.textContent = 'Shift 下钻 · Alt 上溯 · Esc 取消';

    bar.append(counter, clearBtn, togglePick, toggleOutline, rescan, hint);
    document.documentElement.appendChild(bar);
  }

  function updateCounter() {
    if (counter) {
      counter.textContent = state.selected
        ? `已选：${state.selected.name}`
        : `识别到 ${state.sections.length} 块`;
    }
    if (clearBtn) clearBtn.style.display = state.selected ? '' : 'none';
  }

  /* ================= 交互 ================= */

  function hitTest(x, y) {
    let best = null;
    let bestArea = Infinity;
    for (const s of state.sections) {
      const r = rectOf(s.el);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        const area = r.w * r.h;
        if (area < bestArea) { bestArea = area; best = s; }
      }
    }
    return best;
  }

  function onMove(e) {
    if (!state.picking) return;
    const t = hitTest(e.clientX, e.clientY);
    if (t !== state.hover) {
      state.hover = t;
      repaint();
    }
  }

  function onClick(e) {
    if (!state.picking) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (path.some((n) => n && n.id === '__wb-bar')) return;

    const t = hitTest(e.clientX, e.clientY);
    if (!t) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.shiftKey) {
      if (drill(t.el)) { publishSections(); repaint(); updateCounter(); }
      return;
    }
    if (e.altKey) {
      if (climb(t.el)) { publishSections(); repaint(); updateCounter(); }
      return;
    }

    // 先出视觉反馈再做序列化：序列化万一抛错，也不至于「点了没反应」
    state.selected = t;
    repaint();
    updateCounter();

    try {
      const data = serialize(t.el);
      emit('select', data);
      persist(data);
    } catch (err) {
      emit('select-error', { message: String(err) });
      console.error('[section-brief] 序列化失败', err);
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') clearSelection();
  }

  function onScroll() {
    repaint();
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', () => { repaint(); updateCounter(); }, { passive: true });

  function handleToolMessage(msg) {
    if (msg.type === 'refresh') {
      detect();
      publishSections();
      repaint();
      updateCounter();
    }
    if (msg.type === 'set-outlines') {
      state.outlines = !!msg.value;
      repaint();
    }
    if (msg.type === 'reselect') {
      state.selected = null;
      repaint();
      updateCounter();
      emit('clear', null);
    }
    if (msg.type === 'select-index') {
      const s = state.sections[msg.i];
      if (!s) return;
      state.selected = s;
      state.hover = null;
      repaint();
      updateCounter();
      s.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      try {
        const data = serialize(s.el);
        emit('select', data);
        persist(data);
      } catch (err) {
        console.error('[section-brief] 序列化失败', err);
      }
    }
  }

  // 双通道接收：BroadcastChannel（同源快速通道）+ postMessage（跨源兜底）
  if (bc) {
    bc.onmessage = (ev) => {
      const msg = ev.data;
      if (msg && msg.__wbFromTool) handleToolMessage(msg);
    };
  }
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.__wbFromTool) handleToolMessage(msg);
  });

  /* ================= 启动 ================= */

  function boot() {
    document.documentElement.appendChild(layer);
    buildBar();
    detect();
    publishSections();
    repaint();
    updateCounter();
    emit('ready', { target: window.__WB_TARGET__ || location.href, count: state.sections.length });
    setTimeout(() => {
      detect();
      publishSections();
      repaint();
      updateCounter();
    }, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
