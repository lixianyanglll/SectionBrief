#!/usr/bin/env node
/**
 * 板块简报 · 本地服务
 *
 * 职责：
 *   1. 托管调试台页面（/）
 *   2. 代理目标 HTML 并注入拾取脚本（/preview?src=<绝对路径>）
 *   3. 映射目标页面的相对资源（/_res/<base64url 目录>/<文件>）
 *   4. 把选中块抽离成独立沙盒页面（/api/export）
 *   5. 暴露状态给智能体读取（/api/state）
 *
 * 零依赖，只用 Node 内置模块。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'public');
const OUT = path.join(__dirname, 'out');
const STATE_FILE = path.join(__dirname, 'state.json');
const FULL_FILE = path.join(__dirname, 'selection-full.json');
const BASE_PORT = Number(process.env.WB_PORT || 7788);

fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const enc = (s) => Buffer.from(s, 'utf8').toString('base64url');
const dec = (s) => Buffer.from(s, 'base64url').toString('utf8');

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
const json = (res, obj, code = 200) => send(res, code, JSON.stringify(obj, null, 2), MIME['.json']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 40 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { target: null, selection: null, history: [], exports: [] };
  }
}
function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

/* ---------- 静态文件 ---------- */

function serveFile(res, file) {
  if (!fs.existsSync(file)) return send(res, 404, 'not found: ' + file);
  let st = fs.statSync(file);
  if (st.isDirectory()) {
    const idx = path.join(file, 'index.html');
    if (fs.existsSync(idx)) return serveFile(res, idx);
    return send(res, 403, 'directory listing disabled');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(file).pipe(res);
}

/* ---------- 源码定位标注 ---------- */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);

function countNl(s) {
  let n = 0;
  for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) === 10) n++;
  return n;
}

/**
 * 给源 HTML 的每个元素打上「源文件行号」标记：
 *   data-wb-l = 该元素开始标签所在行
 *   data-wb-e = 该元素结束标签所在行
 *
 * 行号指向用户真实的源文件，浏览器里读出来就能告诉智能体「改哪一段」。
 * 只插入同一行内的属性，不会造成行号偏移；RAW_TAGS 的内容区整体跳过，
 * 所以 <script> 里的 `a < b` 不会被误判成标签。
 */
function annotateHtml(html) {
  const byPos = new Map();
  const addAttr = (pos, text) => {
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push(text);
  };

  const stack = [];
  const len = html.length;
  let line = 1;
  let i = 0;

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    line += countNl(html.slice(i, lt));
    i = lt;

    // 注释
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const stop = end < 0 ? len : end + 3;
      line += countNl(html.slice(i, stop));
      i = stop;
      continue;
    }

    // doctype 等声明
    if (html.startsWith('<!', i)) {
      const gt = html.indexOf('>', i);
      const stop = gt < 0 ? len : gt + 1;
      line += countNl(html.slice(i, stop));
      i = stop;
      continue;
    }

    // 结束标签：把行号补回栈里对应的开始标签
    if (html.startsWith('</', i)) {
      const gt = html.indexOf('>', i);
      const stop = gt < 0 ? len : gt + 1;
      const name = html.slice(i + 2, gt).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].name === name) {
          addAttr(stack[s].insertPos, ` data-wb-e="${line}"`);
          stack.splice(s, 1);
          break;
        }
      }
      line += countNl(html.slice(i, stop));
      i = stop;
      continue;
    }

    // 开始标签：找 '>'，跳过引号内的内容
    let j = i + 1;
    let quote = null;
    while (j < len) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= len) break;

    const tagText = html.slice(i, j + 1);
    const m = /^<\s*([a-zA-Z][\w:-]*)/.exec(tagText);
    if (!m) {
      line += countNl(tagText);
      i = j + 1;
      continue;
    }

    const name = m[1].toLowerCase();
    const insertPos = i + m[0].length;
    const inner = tagText.slice(0, -1);
    const selfClose = /\/\s*$/.test(inner) || VOID_TAGS.has(name);

    addAttr(insertPos, ` data-wb-l="${line}"`);

    // 原始文本元素：内容整体跳过，结束行号直接算
    if (RAW_TAGS.has(name)) {
      const closeRe = new RegExp('</' + name + '\\s*>', 'i');
      const rest = html.slice(j + 1);
      const cm = closeRe.exec(rest);
      const endPos = cm ? j + 1 + cm.index + cm[0].length : len;
      addAttr(insertPos, ` data-wb-e="${line + countNl(html.slice(i, endPos))}"`);
      line += countNl(html.slice(i, endPos));
      i = endPos;
      continue;
    }

    if (selfClose) addAttr(insertPos, ` data-wb-e="${line}"`);
    else stack.push({ name, insertPos });

    line += countNl(tagText);
    i = j + 1;
  }

  // 从后往前插入，避免位置偏移
  const positions = [...byPos.keys()].sort((a, b) => b - a);
  let out = html;
  for (const pos of positions) {
    out = out.slice(0, pos) + byPos.get(pos).join('') + out.slice(pos);
  }
  return out;
}

/* ---------- 目标页面代理与注入 ---------- */

function rewrite(html, file) {
  const dir = path.dirname(file);
  const baseHref = `/_res/${enc(dir)}/`;
  // 先按「原始源文件」打行号标记，再注入自己的东西，保证行号指向用户真实文件
  let out = annotateHtml(html);

  // 1. 注入 <base>，让页面里的相对路径走代理路由
  const baseTag = `<base href="${baseHref}">`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${baseTag}</head>`);
  } else {
    out = `${baseTag}\n${out}`;
  }

  // 2. 注入拾取脚本（放最后，等 DOM 就绪）
  const script =
    `<script>window.__WB_TARGET__=${JSON.stringify(file)};</script>\n` +
    `<script src="/inject.js"></script>`;
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${script}\n</body>`);
  } else {
    out += `\n${script}`;
  }
  return out;
}

function handlePreview(u, res) {
  const src = u.searchParams.get('src');
  if (!src) return send(res, 400, 'missing ?src=');
  const file = path.resolve(src);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'target not found: ' + file);
  }
  const html = fs.readFileSync(file, 'utf8');
  return send(res, 200, rewrite(html, file), MIME['.html']);
}

function handleRes(p, res) {
  const rest = p.slice('/_res/'.length);
  const i = rest.indexOf('/');
  if (i < 0) return send(res, 400, 'bad res path');
  const root = dec(rest.slice(0, i));
  const rel = decodeURIComponent(rest.slice(i + 1));
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root))) return send(res, 403, 'forbidden');
  return serveFile(res, full);
}

/* ---------- 抽离：生成独立沙盒页面 ---------- */

const SANDBOX_CSS = `/* 沙盒底座 —— 只做最小复位，不干扰还原度 */
html, body { margin: 0; padding: 0; }
`;

function slugify(name, n) {
  const ascii = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return (ascii || 'section') + '-' + n;
}

function buildSandbox(payload) {
  const { name, html, css, meta } = payload;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  const dirName = `${slugify(name, stamp.slice(-6))}-${stamp}`;
  const dir = path.join(OUT, dirName);
  fs.mkdirSync(dir, { recursive: true });

  const head = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(name || '区块')} · 沙盒</title>`,
    `<style>${SANDBOX_CSS}</style>`,
    `<style>${css || ''}</style>`,
    '</head>',
    '<body>',
    `<div id="__wb_sandbox_root">`,
    html || '',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');

  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, head, 'utf8');

  const metaFile = path.join(dir, 'section.json');
  fs.writeFileSync(metaFile, JSON.stringify({ ...payload, html: undefined, css: undefined }, null, 2), 'utf8');

  return {
    id: dirName,
    name: name || '区块',
    url: `/sandbox/${dirName}/index.html`,
    file,
    dir,
    at: new Date().toISOString(),
    meta: meta || null,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 上游反代 ----------
 * 问题：预览里的页面被代理到 127.0.0.1:<我们的端口>，它自己发往 /api/... 的请求
 * 就打到了我们服务上，而它的后端在别的端口 → 页面报「无法连接本地服务」。
 * 解法：未命中的路径整体转发给 --upstream 指定的上游。
 */

const UPSTREAM = (() => {
  const i = process.argv.indexOf('--upstream');
  const raw = (i >= 0 && process.argv[i + 1]) || process.env.WB_UPSTREAM || '';
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`);
  } catch {
    console.error('[section-brief] --upstream 不是合法地址，已忽略:', raw);
    return null;
  }
})();

function proxyUpstream(req, res, u) {
  return new Promise((resolve) => {
    const headers = { ...req.headers };
    headers.host = UPSTREAM.host;
    // 不跟上游谈压缩：否则响应体是 gzip 而我们剥掉了 content-encoding，前端会解不开
    delete headers['accept-encoding'];
    delete headers.connection;
    const preq = http.request(
      {
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: u.pathname + u.search,
        headers,
      },
      (pres) => {
        const h = { ...pres.headers };
        delete h['content-encoding'];
        delete h['content-length'];
        delete h['transfer-encoding'];
        if (res.headersSent) return pres.resume();
        res.writeHead(pres.statusCode || 502, h);
        pres.pipe(res);
        pres.on('end', resolve);
      }
    );
    preq.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('upstream error: ' + e.message);
      resolve();
    });
    if (req.method === 'GET' || req.method === 'HEAD') preq.end();
    else req.pipe(preq);
  });
}

/* ---------- 路由 ---------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${BASE_PORT}`);
  const p = decodeURIComponent(u.pathname);

  try {
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUB, 'index.html'));
    if (p === '/inject.js') return serveFile(res, path.join(PUB, 'inject.js'));
    if (p === '/tool.js') return serveFile(res, path.join(PUB, 'tool.js'));
    if (p === '/tool.css') return serveFile(res, path.join(PUB, 'tool.css'));

    if (p === '/preview') return handlePreview(u, res);
    if (p.startsWith('/_res/')) return handleRes(p, res);

    if (p === '/api/health') {
      return json(res, { ok: true, port: server.address().port, upstream: UPSTREAM ? UPSTREAM.href : null });
    }

    if (p === '/api/selection') {
      if (!fs.existsSync(FULL_FILE)) return json(res, { ok: false, selection: null });
      return json(res, { ok: true, selection: JSON.parse(fs.readFileSync(FULL_FILE, 'utf8')) });
    }

    if (p === '/api/state') {
      if (req.method === 'GET') return json(res, readState());
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const st = readState();
        const { selection, ...rest } = body;
        Object.assign(st, rest);
        if (body.clear) {
          st.selection = null;
          try { fs.rmSync(FULL_FILE, { force: true }); } catch { /* 忽略 */ }
        }
        if (selection) {
          // 轻量版进 state.json（供智能体/轮询读取），完整版（含 html/css）单独落盘
          const light = { ...selection };
          delete light.html;
          delete light.css;
          light.htmlChars = (selection.html || '').length;
          light.cssChars = (selection.css || '').length;
          if (selection.html) fs.writeFileSync(FULL_FILE, JSON.stringify(selection), 'utf8');
          st.selection = light;
          st.history = [light, ...(st.history || [])].slice(0, 20);
        }
        writeState(st);
        return json(res, { ok: true });
      }
    }

    if (p === '/api/target' && req.method === 'POST') {
      const { src } = JSON.parse((await readBody(req)) || '{}');
      const st = readState();
      st.target = path.resolve(src);
      writeState(st);
      return json(res, { ok: true, target: st.target });
    }

    if (p === '/api/export' && req.method === 'POST') {
      const payload = JSON.parse(await readBody(req));
      if (!payload.html) return send(res, 400, 'missing html');
      const info = buildSandbox(payload);
      const st = readState();
      st.exports = [info, ...(st.exports || [])].slice(0, 30);
      st.selection = payload.meta || st.selection;
      writeState(st);
      return json(res, { ok: true, ...info });
    }

    if (p.startsWith('/sandbox/')) {
      const rel = decodeURIComponent(p.slice('/sandbox/'.length));
      const full = path.resolve(OUT, rel);
      if (!full.startsWith(path.resolve(OUT))) return send(res, 403, 'forbidden');
      return serveFile(res, full);
    }

    // 有上游就整体转发（页面自己的后端接口走这里）
    if (UPSTREAM) return proxyUpstream(req, res, u);

    return send(res, 404, 'not found: ' + p);
  } catch (err) {
    return send(res, 500, String((err && err.stack) || err));
  }
});

function listen(port, tries = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < 20) return listen(port + 1, tries + 1);
    console.error('[section-brief] 启动失败:', err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`[section-brief] 调试台已启动 ${url}`);
    console.log(`[section-brief] 状态文件 ${STATE_FILE}`);
    console.log(`[section-brief] 沙盒输出 ${OUT}`);
    if (UPSTREAM) {
      console.log(`[section-brief] 上游反代 ${UPSTREAM.href}（未命中的路径都会转发过去）`);
    } else {
      console.log('[section-brief] 未配置上游反代：页面自身后端接口会 404。需要时加 --upstream http://127.0.0.1:8770');
    }
    if (process.argv.includes('--open')) {
      console.log(`[section-brief] OPEN_URL=${url}`);
    }
  });
}

listen(BASE_PORT);

process.on('SIGINT', () => {
  console.log('\n[section-brief] 已停止');
  process.exit(0);
});
