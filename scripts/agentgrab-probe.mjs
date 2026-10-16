#!/usr/bin/env node
/**
 * agentgrab-probe.mjs —— 在无头 Edge 里真实运行 AgentGrab 的内容脚本，
 * 程序化触发拾取，读回它为指定元素生成的完整提示词。
 *
 * 为什么这么写：AgentGrab 是浏览器扩展，正常用需要人手装扩展 + Alt+Shift+E 点元素。
 * 它的内容脚本是自包含的，只依赖 chrome.runtime 收发消息，所以可以：
 *   1. stub 一个假的 chrome.runtime，捕获它的 onMessage 监听器
 *   2. 手动投递 {type:'agentgrab:start'} 启动拾取
 *   3. 派发合成 mousemove/mousedown/mouseup/click 完成选中
 *   4. 往弹窗的 textarea 里写诉求、点 Preview、读 <pre> 里的最终提示词
 *
 * 用法：
 *   node agentgrab-probe.mjs <目标URL> <content.js路径> <CSS选择器> [更多选择器...]
 *
 * 环境变量：
 *   AG_INTENT  写进 textarea 的诉求文本
 *   AG_OUT     输出目录（默认 ./out-agentgrab）
 *   CDP_PORT   调试端口（默认 9334）
 *   EDGE       Edge 可执行文件路径
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TARGET_URL = process.argv[2];
const CONTENT_JS = process.argv[3];
const SELECTORS = process.argv.slice(4);
const INTENT = process.env.AG_INTENT || '把这个卡片改成浅色背景、去掉发光，数字换成本地中文字体';
const CDP_PORT = Number(process.env.CDP_PORT || 9334);
const OUTDIR = process.env.AG_OUT || path.join(process.cwd(), 'out-agentgrab');

if (!TARGET_URL || !CONTENT_JS || SELECTORS.length === 0) {
  console.error('用法: node agentgrab-probe.mjs <目标URL> <content.js路径> <CSS选择器> [...]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP */

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) || []) h(msg.params);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, h) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(h);
  }
  once(method) {
    return new Promise((res) => {
      const h = (p) => {
        const arr = this.handlers.get(method) || [];
        const i = arr.indexOf(h);
        if (i >= 0) arr.splice(i, 1);
        res(p);
      };
      this.on(method, h);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        'eval 抛错: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails))
      );
    }
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------- 假的 chrome.runtime */

const CHROME_STUB = `
(() => {
  if (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id) return;
  const listeners = { message: [], connect: [] };
  const stub = {
    runtime: {
      id: 'agentgrabstubid',
      getURL: (p) => 'chrome-extension://agentgrabstubid/' + String(p).replace(/^\\//, ''),
      getManifest: () => ({ manifest_version: 3, version: '1.0.0', name: 'AgentGrab' }),
      sendMessage: async () => undefined,
      connect: () => ({
        postMessage() {}, disconnect() {},
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
      }),
      onMessage: {
        addListener(cb) { listeners.message.push(cb); globalThis.__agCb = cb; },
        removeListener() {},
      },
      onConnect: { addListener() {} },
    },
    scripting: { executeScript: async () => [] },
    tabs: { sendMessage: async () => undefined, query: async () => [] },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    i18n: { getMessage: (k) => k, getUILanguage: () => 'zh-CN' },
  };
  globalThis.__agListeners = listeners;
  globalThis.chrome = stub;
  globalThis.browser = stub;
})();
`;

/* ----------------------------------------------------------- 驱动拾取 */

function pickExpression(selector, intent) {
  return `(() => {
    const SEL = ${JSON.stringify(selector)};
    const INTENT = ${JSON.stringify(intent)};
    const el = document.querySelector(SEL);
    if (!el) return { ok: false, err: '找不到元素: ' + SEL };

    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const fire = (type) => el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, button: 0, buttons: type === 'mousedown' ? 1 : 0,
    }));
    fire('mousemove');
    fire('mousedown');
    fire('mouseup');
    fire('click');

    const roots = [];
    const walk = (node) => {
      for (const n of node.querySelectorAll('*')) {
        if (n.shadowRoot) { roots.push(n.shadowRoot); walk(n.shadowRoot); }
      }
    };
    walk(document);

    let shadow = null;
    for (const rr of roots) {
      if (rr.querySelector && rr.querySelector('textarea')) { shadow = rr; break; }
    }
    if (!shadow) {
      return { ok: false, err: '没等到弹窗(textarea 不存在)', shadowRoots: roots.length,
               picked: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '') };
    }

    const ta = shadow.querySelector('textarea');
    const pre = shadow.querySelector('pre');
    const btns = Array.from(shadow.querySelectorAll('button'));
    ta.value = INTENT;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const prev = btns.find((b) => /preview/i.test(b.textContent));
    if (prev) prev.click();

    return {
      ok: true,
      prompt: pre ? pre.textContent : null,
      promptLen: pre ? pre.textContent.length : 0,
      headerText: shadow.textContent.replace(/\\s+/g, ' ').slice(0, 220),
      buttons: btns.map((b) => b.textContent.trim()),
      target: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().replace(/\\s+/g, '.') : ''),
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
    };
  })()`;
}

/* --------------------------------------------------------------- main */

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const contentSrc = fs.readFileSync(CONTENT_JS, 'utf8');

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-edge-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--disable-features=Translate',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDir}`,
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
  process.on('exit', cleanup);

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) { console.error('CDP 未就绪'); process.exit(1); }

  const cdp = new CDP(wsUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) =>
    consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown'));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(' '));
  });

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_STUB });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(1200);

  const env = await cdp.eval(`({
    url: location.href, title: document.title,
    chinese: document.characterSet,
    hasChrome: !!globalThis.chrome, hasRuntimeId: !!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id),
    bodyChildren: document.body.children.length,
  })`);

  await cdp.eval(contentSrc);
  await sleep(300);
  const loadedFlag = await cdp.eval(`({
    agentgrabLoaded: !!window.__agentgrabLoaded,
    listenerCaptured: typeof globalThis.__agCb === 'function',
    listeners: (globalThis.__agListeners && globalThis.__agListeners.message.length) || 0,
  })`);

  if (!loadedFlag.listenerCaptured) {
    console.error('内容脚本没注册消息监听器，无法驱动。环境：', JSON.stringify({ env, loadedFlag }, null, 2));
    console.error('控制台错误：', consoleErrors.slice(0, 5));
    cdp.close();
    process.exit(1);
  }

  const startRes = await cdp.eval(`(() => {
    try { globalThis.__agCb({ type: 'agentgrab:start' }, {}, () => 'agentgrab:ack'); return 'sent'; }
    catch (e) { return 'threw: ' + e.message; }
  })()`);
  await sleep(600);

  const active = await cdp.eval(`({
    pickingClass: document.documentElement.classList.contains('agentgrab-picking'),
    shadowHosts: Array.from(document.querySelectorAll('*')).filter(n => n.shadowRoot).length,
    cursor: getComputedStyle(document.documentElement).cursor,
  })`);

  console.log('--- 环境 ---');
  console.log(JSON.stringify({ env, loadedFlag, startRes, active }, null, 2));
  if (consoleErrors.length) {
    console.log('--- 页面上报的错误（前 5 条）---');
    console.log(consoleErrors.slice(0, 5).join('\n'));
  }

  const results = [];
  for (const sel of SELECTORS) {
    let r;
    try { r = await cdp.eval(pickExpression(sel, INTENT)); }
    catch (e) { r = { ok: false, err: String(e.message).slice(0, 300) }; }

    const isFirst = results.length === 0;
    if (isFirst && r.ok) {
      const file = path.join(OUTDIR, 'agentgrab-picked.png');
      await cdp.shot(file);
      r.screenshot = file;
    }
    // 选中后需要重置回 picking 才能拾取下一个元素
    await cdp.eval(`(() => {
      const path0 = [];
      const walk = (n) => { for (const c of n.querySelectorAll('*')) { if (c.shadowRoot) { path0.push(c.shadowRoot); walk(c.shadowRoot); } } };
      walk(document);
      for (const rr of path0) { const b = Array.from(rr.querySelectorAll('button')).find(x => /pick another/i.test(x.textContent)); if (b) { b.click(); return; } }
    })()`);
    await sleep(400);
    results.push({ selector: sel, ...r });
  }

  cdp.close();

  console.log('\n=== AgentGrab 拾取结果 ===');
  console.log(JSON.stringify(results, null, 2));

  const md = [
    '# AgentGrab 实测输出',
    '',
    `- 页面：${TARGET_URL}`,
    `- 诉求文本：${INTENT}`,
    `- 时间：${new Date().toISOString()}`,
    '',
  ];
  for (const r of results) {
    md.push(`## 选择器 \`${r.selector}\``, '');
    md.push(`- 结果：${r.ok ? '成功' : '失败 — ' + r.err}`);
    if (r.target) md.push(`- 命中元素：\`${r.target}\`（${r.rect?.w}×${r.rect?.h}）`);
    if (r.headerText) md.push(`- 弹窗头部：${r.headerText}`);
    if (r.buttons) md.push(`- 按钮：${r.buttons.join(' / ')}`);
    if (r.prompt) md.push(`- 提示词长度：${r.promptLen} 字符`, '', '```text', r.prompt, '```');
    md.push('');
  }
  const mdFile = path.join(OUTDIR, 'agentgrab-prompts.md');
  fs.writeFileSync(mdFile, md.join('\n'), 'utf8');
  console.log('\n提示词已写入：' + mdFile);
}

main().catch((e) => { console.error(e); process.exit(1); });
