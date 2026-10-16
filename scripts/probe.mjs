#!/usr/bin/env node
/**
 * 板块简报 · 自检探针
 *
 * 用无头 Edge + 调试协议模拟一次真实点击，验证「点击 → 选中 → 落盘」整条链路。
 * 改完 inject.js / server.mjs 之后跑一遍，比开真浏览器点快得多。
 *
 * 用法：
 *   node scripts/probe.mjs <目标HTML绝对路径> [要点的第几块，默认 3]
 *
 * 前置：本地服务已启动（server.mjs）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const htmlPath = process.argv[2];
const pickIndex = Number(process.argv[3] ?? 3);
const DEBUG_PORT = Number(process.env.WB_DEBUG_PORT || 9333);
const BASE = process.env.WB_BASE || 'http://127.0.0.1:7788';

if (!htmlPath) {
  console.error('用法: node scripts/probe.mjs <目标HTML绝对路径> [第几块]');
  process.exit(1);
}

const browser = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.error('没找到 Edge / Chrome，跳过探针');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpDir = path.join(root, '.probe');
fs.mkdirSync(tmpDir, { recursive: true });

const target = `${BASE}/preview?src=${encodeURIComponent(htmlPath)}`;

const proc = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${path.join(tmpDir, 'profile')}`,
    '--window-size=1440,900',
    target,
  ],
  { stdio: 'ignore' }
);

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
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
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await sleep(3500);

  const res = await send('Runtime.evaluate', {
    expression: `(() => {
      const node = document.getElementById('__wb-report');
      if (!node) return 'REPORT_MISSING|注入脚本没有运行';
      const rep = JSON.parse(node.textContent);
      const t = rep.sections[${pickIndex}];
      if (!t) return 'NO_SECTION|只识别到 ' + rep.count + ' 块';
      const x = Math.round(window.innerWidth * 0.55);
      const y = Math.round(Math.min(t.y + t.h / 2, window.innerHeight - 60));
      const el = document.elementFromPoint(x, y);
      if (!el) return 'NO_ELEMENT|该位置没有元素';
      for (const type of ['mousemove', 'click']) {
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, view: window, clientX: x, clientY: y,
        }));
      }
      return 'OK|' + rep.count + '|' + t.name + '|' + el.tagName.toLowerCase();
    })()`,
    returnByValue: true,
  });

  const raw = res.result?.result?.value || 'EVAL_FAILED|无返回值';
  const [status, count, name, tag] = String(raw).split('|');
  console.log('分块   :', count || '-', '块');
  console.log('点击   :', status === 'OK' ? `命中 <${tag}> → ${name}` : raw);

  await sleep(1000);

  const st = await fetch(`${BASE}/api/state`).then((r) => r.json());
  console.log('落盘   :', st.selection ? `${st.selection.name}  ${st.selection.selector}` : '（空）');
  if (st.selection && st.selection.source) {
    const s = st.selection.source;
    console.log('定位   :', s.located ? `第 ${s.startLine}–${s.endLine} 行（共 ${s.lines} 行）` : '未定位到行号');
  }

  const full = await fetch(`${BASE}/api/selection`).then((r) => r.json());
  console.log('完整   :', full.ok ? `html ${full.selection.html.length}B / css ${full.selection.css.length}B` : '不可用');

  const pass = status === 'OK' && st.selection && full.ok;
  console.log('结论   :', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} catch (err) {
  console.error('探针失败:', err.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { /* 忽略 */ }
  spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
}
