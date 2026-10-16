#!/usr/bin/env node
/**
 * compare-probe.mjs —— 端到端驱动「板块简报」自己：
 * 打开调试台 → 等注入脚本分块 → 在 iframe 里模拟点击某一块 →
 * 等三通道同步 → 填诉求 → 读回工具真正生成的提示词。
 *
 * 和 agentgrab-probe.mjs 配对使用：同一个页面、同一块区域，两边都拿真实输出做对比。
 *
 * 用法：
 *   node scripts/compare-probe.mjs <目标HTML绝对路径> <第几块|块名关键词> [诉求文本]
 *
 * 前置：server.mjs 已启动（默认 http://127.0.0.1:7788）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const htmlPath = process.argv[2];
const pickArg = process.argv[3] ?? '1';
const INTENT = process.argv[4] || '把这个区域改成浅色（白底深字）、去掉发光，数字换成本地中文字体';
const PORT = Number(process.env.WB_DEBUG_PORT || 9335);
const BASE = process.env.WB_BASE || 'http://127.0.0.1:7788';
const OUTDIR = process.env.WB_OUT || path.join(process.cwd(), 'out-compare');

if (!htmlPath) {
  console.error('用法: node scripts/compare-probe.mjs <目标HTML绝对路径> <第几块|关键词> [诉求]');
  process.exit(2);
}

const browser = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) { console.error('没找到 Edge / Chrome'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(OUTDIR, { recursive: true });

const target = `${BASE}/?src=${encodeURIComponent(htmlPath)}`;
const proc = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'wb-compare-' + Date.now())}`,
  '--window-size=1440,980', target,
], { stdio: 'ignore' });

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

let ws;
try {
  const page = await findPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const fn = pending.get(m.id);
    if (fn) { fn(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = (method, params) =>
    new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
    return r.result?.result?.value;
  };

  await sleep(2500);

  const expr = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = document.getElementById('pageFrame');
    const INTENT = ${JSON.stringify(INTENT)};

    let doc = null, rep = null;
    for (let i = 0; i < 80; i++) {
      try {
        doc = frame.contentDocument;
        const node = doc && doc.getElementById('__wb-report');
        if (node) { rep = JSON.parse(node.textContent); break; }
      } catch (e) { /* 还没就绪 */ }
      await sleep(250);
    }
    if (!rep) return { ok: false, err: 'iframe 里没等到 __wb-report' };

    const win = frame.contentWindow;
    const list = rep.sections.map((s, i) => ({ i, name: s.name, tag: s.tag, w: s.w, h: s.h, x: s.x, y: s.y }));

    let idx;
    if (/^\\d+$/.test(${JSON.stringify(String(pickArg))})) idx = Number(${JSON.stringify(String(pickArg))});
    else {
      const kw = ${JSON.stringify(String(pickArg))};
      idx = list.findIndex((s) => (s.name || '').includes(kw));
    }
    const t = list[idx];
    if (!t) return { ok: false, err: '第 ' + idx + ' 块不存在，共 ' + list.length + ' 块', blocks: list };

    const x = Math.round(win.innerWidth * 0.55);
    const y = Math.round(Math.min(t.y + t.h / 2, win.innerHeight - 60));
    const el = doc.elementFromPoint(x, y);
    if (!el) return { ok: false, err: '该坐标没有元素', blocks: list };
    for (const type of ['mousemove', 'click']) {
      el.dispatchEvent(new win.MouseEvent(type, {
        bubbles: true, cancelable: true, view: win, clientX: x, clientY: y,
      }));
    }

    await sleep(2000);

    const intentEl = document.getElementById('intent');
    intentEl.value = INTENT;
    intentEl.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);

    return {
      ok: true,
      blocks: list,
      picked: { index: idx, name: t.name, tag: t.tag, w: t.w, h: t.h, hitTag: el.tagName.toLowerCase() },
      prompt: document.getElementById('promptOut').value,
      promptBadge: document.getElementById('promptBadge').textContent,
      chip: document.getElementById('selChip').textContent.replace(/\\s+/g, ' ').trim(),
      selInfo: document.getElementById('selInfo').textContent.replace(/\\s+/g, ' ').trim(),
      status: document.getElementById('status').textContent.replace(/\\s+/g, ' ').trim(),
    };
  })()`;

  const result = await evaluate(expr);

  if (result?.ok) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot?.result?.data) {
      const f = path.join(OUTDIR, 'devtool-picked.png');
      fs.writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
      result.screenshot = f;
    }
  }

  console.log('=== 板块简报结果 ===');
  if (!result?.ok) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    console.log('分块列表：');
    for (const b of result.blocks) {
      const mark = b.i === result.picked.index ? '  ← 选中' : '';
      console.log(`  ${b.i}. ${b.name}  <${b.tag}>  ${b.w}×${b.h}${mark}`);
    }
    console.log('\n命中：', JSON.stringify(result.picked));
    console.log('状态：', result.status);
    console.log('选中条：', result.chip);
    console.log('详情：', result.selInfo.slice(0, 160));
    console.log('提示词：', result.promptBadge, `/ ${result.prompt.length} 字符`);
    console.log('\n---------- 提示词全文 ----------');
    console.log(result.prompt);

    const md = [
      '# 板块简报 实测输出', '',
      `- 目标：${htmlPath}`, `- 诉求：${INTENT}`, `- 时间：${new Date().toISOString()}`, '',
      '## 分块列表', '',
      ...result.blocks.map((b) => `- ${b.i}. ${b.name} \`<${b.tag}>\` ${b.w}×${b.h}${b.i === result.picked.index ? '  ←选中' : ''}`),
      '', `## 提示词（${result.prompt.length} 字符）`, '', '```text', result.prompt, '```', '',
    ].join('\n');
    const mdFile = path.join(OUTDIR, 'devtool-prompt.md');
    fs.writeFileSync(mdFile, md, 'utf8');
    console.log('\n已写入：' + mdFile);
  }
} catch (err) {
  console.error('探针失败:', err.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { /* 忽略 */ }
  spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
}
