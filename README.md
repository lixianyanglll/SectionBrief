# SectionBrief

> **Brief your coding agent, one section at a time.**

Auto-slice a front-end page into sections, pick one in the preview, and hand your AI coding agent a strict
*"change only this section"* brief — with the **exact file path and line numbers**.

Zero install. No browser extension, no npm package, no changes to your project.

![SectionBrief — the console on the left, the selected section's details and generated brief on the right](assets/screenshot.png)

[中文说明 →](README.zh-CN.md)

---

## The problem

When you want to change one block of a page, you end up describing it in words:

> "the grey card under the pricing table, second from the left… make it full width"

Your coding agent then has to guess which element you mean, and which file renders it. It burns turns
searching, sometimes edits the wrong instance, and often touches neighbouring sections you never asked about.

Pointing at the element fixes the first half. Knowing **which file and which line** fixes the second.

## The loop

```
page  →  auto-sliced into sections  →  you pick one  →  a strict brief  →  your coding agent
```

1. A local Node service serves the target HTML, injects a picker script, and **annotates every element
   with its line range in the original file** — the source file itself is never modified.
2. The page is sliced top-down into named sections (header / hero / chart area / data table / footer…).
3. You click a section. Its size, styles, selector and **line range** appear in the side panel.
4. Type what you want changed, hit copy, paste into your coding agent.

## What makes it different

| | LocatorJS · ClickToComponent · code-inspector-plugin | AgentGrab · oil-oil/selector · UI Context for Agents | React Grab · see-my-clicks · mcp-pointer | **SectionBrief** |
|---|---|---|---|---|
| Install | build plugin | browser extension / bookmarklet | npm package or MCP server | **none** |
| Runs in your agent's built-in preview | ✗ | ✗ | ✗ | **✓** |
| Section overview of a whole page | ✗ | ✗ | ✗ | **✓** |
| `file:line` on plain static HTML | ✗ (framework only) | ✗ (framework dev builds only) | ✗ (framework only) | **✓** |
| Generates an edit brief | ✗ (jumps to IDE) | ✓ | partial | ✓ |
| Can extract a section as a standalone sandbox | ✗ | ✗ | ✗ | ✓ |

The line-number engine is the interesting part. Tools that show `file:line` read it from framework
metadata — React's `fiber._debugSource`, Vue's `__vueParentComponent.type.__file`. That works great in a
dev build and **not at all on plain HTML**. SectionBrief takes the opposite approach: it annotates the raw
source before the page is served, so static HTML gets exact line numbers, and framework pages fall back to
a CSS selector.

---

## Quick start

No dependencies — Node's built-in modules only.

```bash
node server.mjs
# [section-brief] listening on http://127.0.0.1:7788/
```

Open `http://127.0.0.1:7788/?src=<url-encoded absolute path to your HTML>`.

If the page has its own backend (it calls `/api/...` on its own origin), point the proxy at it so those
calls keep working:

```bash
node server.mjs --upstream http://127.0.0.1:8770
```

Unmatched paths are forwarded verbatim to the upstream. `accept-encoding` is stripped so the response
body and `content-encoding` never disagree.

### Try it on the bundled examples

```bash
node server.mjs
# then open
#   http://127.0.0.1:7788/?src=<repo>/examples/dashboard.html
#   http://127.0.0.1:7788/?src=<repo>/examples/demo.html
```

`examples/dashboard.html` slices into 5 sections, `examples/demo.html` into 7 — both verified error-free.

## Using the UI

| Action | Result |
|---|---|
| hover | the section under the cursor is outlined, with its name and size |
| click | select it — orange outline, details in the right panel |
| `Shift` + click | descend into a child section |
| `Alt` + click | step up to the parent |
| `Esc` / toolbar button / panel button | clear the selection |
| "Extract as standalone page" | builds a sandbox containing only this section |
| "Generate edit brief" | type your intent, then copy the brief |

## The brief

Real output, from selecting the `.stats` block of a single-file HTML page:

```text
【只改下面这一个板块，不要动页面其它部分】

目标文件：D:\project\index.html
准确位置：第 185–191 行（共 7 行）
DOM 路径：body > div.wrap > div.stats
节点尺寸：1005 × 91（页面视口 1037 × 791）
板块标识：数据区  <div class="stats">
子元素数量：5
板块内文字：延迟 Ping—ms 抖动 Jitter—ms 丢包 Loss—% 已用流量0MB 评级—

当前关键样式：
  display: grid
  …

【我想怎么改】
<what you want changed>

【硬性约束】
1. 只改这一个板块对应的代码，不要改其它板块的结构和样式。
2. 如果这次改动会波及别的区域，先说明影响范围，再动手。
3. 保持项目现有的代码风格和命名习惯，不要顺手重构无关代码。
4. 改完告诉我具体改了文件的哪几行。
```

The file path and line range are checked against the source by hand — line 185 is the opening
`<div class="stats">`, line 191 its closing tag.

## How it works

| Component | File | Role |
|---|---|---|
| Local server | `server.mjs` | serves the console, proxies and injects into the target page, writes the sandbox, exposes state |
| Picker | `public/inject.js` | section detection, hover/select, key handling |
| Console | `public/index.html` + `tool.js` + `tool.css` | page preview on the left, selection details + sandbox + brief on the right |
| Self-check probe | `scripts/probe.mjs` | headless browser, simulates a click, asserts the whole chain |
| Comparison probe | `scripts/compare-probe.mjs` | drives the console end-to-end and reads back the generated brief |

**Same-origin proxy.** The target page is served by the local service and loaded in an iframe, so the
console and the page are same-origin and the DOM can be inspected directly. No CORS problems.

**Source is read-only.** The server reads your file, injects `<base>` + the picker script, and sends the
result. Your file on disk is untouched.

**Line annotation.** Before injecting anything, the source is scanned and each start tag gets
`data-wb-l="<line>"`, each end tag `data-wb-e="<line>"`. The inserted attributes contain no newlines, so
line numbers never drift. The contents of `<script>`, `<style>`, `<textarea>` and `<title>` are skipped
wholesale, so `a < b` inside a script is not mistaken for a tag. `data-wb-*` is stripped before any HTML
leaves the tool.

**Three redundant channels.** `BroadcastChannel`, `postMessage`, and a 700 ms poll of `/api/state`.
Embedded preview webviews sometimes sever the first two; the poll only needs the local service, so the
console keeps syncing.

### Section detection

Top-down walk of the DOM:

1. no children → a section
2. one child → stop if the node is semantically named and tall enough, otherwise descend
3. many children → vertical stack (each child ≥ 72% of the container width), horizontal split
   (2–3 children each ≥ 60% of the **viewport** height), or treat the whole container as one section
4. anything taller than 1.0 × the viewport descends further, up to depth 4

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | health check, actual port and configured upstream |
| GET | `/api/state` | target + selection summary + 20 recent entries |
| GET | `/api/selection` | full current selection, including HTML and CSS |
| POST | `/api/state` | write state; `{clear:true}` empties the selection |
| POST | `/api/target` | set the target file |
| POST | `/api/export` | build a sandbox from a selection |
| GET | `/preview?src=` | proxy the target page and inject the picker |
| GET | `/sandbox/<id>/index.html` | visit a generated sandbox |

## Known limitations

- **Single-file local HTML only.** Dev servers and multi-file projects with external assets are not
  proxied yet.
- **Absolute asset paths bypass `<base>`.** A hard-coded `/style.css` will 404.
- **Extracted sandboxes can lose styles** when the rules come from descendant selectors whose ancestor
  chain was dropped. The sandbox currently carries the whole page's CSS.
- **Line numbers are reliable only on static HTML.** Nodes created or reordered by JavaScript won't match;
  in that case the tool says "line numbers not located" and falls back to a CSS selector.
- **Writing changes back to the source file is not implemented.** Extraction produces a standalone
  sandbox under `out/`; the original project is never modified.
- **GBK-encoded pages** are read as UTF-8 and show mojibake.
- **Section granularity is coarser than free element picking.** Two cards side by side, each shorter than
  the viewport, are one section — `Shift` + click descends into a single card.
- Paths that collide with `/api/health|state|selection|target|export` cannot be forwarded upstream, and
  WebSocket upgrades are not proxied.

## Related work

Prior art this project learned from, and where it differs:

- [AgentGrab](https://github.com/PaulHarrer/agentgrab) — element picker → clipboard prompt. Closest in
  spirit; a browser extension, and its source hints come from framework dev builds.
- [oil-oil/selector](https://github.com/oil-oil/selector) — bookmarklet, multi-select, per-element notes.
- [LocatorJS](https://github.com/infi-pc/locatorjs),
  [ClickToComponent](https://github.com/ericclemmons/click-to-component),
  `code-inspector-plugin` — jump from a component to your IDE. Their source-position injection is the right
  approach for framework pages.
- [React Grab](https://github.com/aidenybai/react-grab),
  [see-my-clicks](https://www.npmjs.com/package/see-my-clicks),
  [mcp-pointer](https://github.com/greenstevester/mcp-pointer) — project-level installs and MCP transport.

A measured comparison of one of these against SectionBrief on the same page and the same element lives in
`docs/comparison.md`.

## License

[MIT](LICENSE)
