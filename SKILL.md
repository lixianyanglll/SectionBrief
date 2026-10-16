---
name: section-brief
description: 前端页面「分块调试 + 交接指令」——把整页自动切成板块，在 WorkBuddy 内置预览里用鼠标选中其中一块，单独拎出来调试，并生成一段「只改这一块」的指令交给正在改这个项目的 AI 智能体（含文件绝对路径与精确行号）。触发词：分块调试、板块简报、选中板块、单独调试某一块、section 级调试、页面分块、把这块抠出来、只看这一块、区块隔离预览、交接指令、只改选中的板块、告诉智能体改哪里。
agent_created: true
---

# 板块简报 SectionBrief

> Brief your coding agent, one section at a time.
> 仓库：`section-brief` ｜ 简称：**SecBrief** ｜ 技能名：`section-brief`

## 它解决什么

改一个前端板块时最烦的事：整页几百个元素互相干扰，调一个 padding 别处跟着崩。
这个工具把页面切成板块，让你**只跟其中一块打交道**——在预览里点一下选中它、
看到它的尺寸和样式、一键把它抽离成一个只含这一块、能独立跑的最小页面。

全程在 WorkBuddy 内置预览视窗里完成，不装浏览器扩展、不改目标项目一行代码。

## 三个组件

| 组件 | 位置 | 职责 |
|---|---|---|
| 本地服务 | `server.mjs` | 托管调试台、代理目标页并注入脚本、生成沙盒、暴露状态 |
| 拾取脚本 | `public/inject.js` | 自动分块、悬停高亮、点击选中、轮廓显示 |
| 调试台 | `public/index.html` + `tool.js` + `tool.css` | 左整页预览 / 右选中详情 + 沙盒预览 |
| 自检探针 | `scripts/probe.mjs` | 无头浏览器模拟点击，回归验证整条链路 |
| 对比探针 | `scripts/compare-probe.mjs` | 端到端驱动调试台自己：分块 → 点击 → 读回工具**真正生成**的提示词 |
| 竞品探针 | `scripts/agentgrab-probe.mjs` | 无头里真实运行 AgentGrab 的内容脚本（stub 掉扩展 API），抓它的提示词 |

零依赖，只用 Node 内置模块。

## 启动

**必须用后台任务启动**，否则服务进程会随命令结束被回收：

```bash
node ~/.workbuddy/skills/section-brief/server.mjs
# 或显式用托管 node： "$HOME/.workbuddy/binaries/node/versions/<版本>/node.exe"
```

用 `run_in_background=true` 跑。默认端口 7788，被占用会自动 +1（看启动日志里的实际 URL）。

**页面自己有后端接口时，要挂上游反代**，否则预览里它的接口会打到我们服务上而失效：

```bash
node server.mjs --upstream http://127.0.0.1:8770
```

未命中的路径会原样转发给上游（剥掉 `accept-encoding` 避免压缩格式对不上），
`GET /api/health` 会回显当前上游。

然后把调试台开进内置预览：

```
present_files(["http://127.0.0.1:7788/?src=<目标HTML的绝对路径，URL 编码>"])
```

## 用户怎么操作

1. 左侧预览里**悬停** → 板块被虚线高亮，角上显示名称和尺寸
2. **点击** → 选中（橙色框），顶部出现选中条，右侧列出标签、尺寸、选择器、子元素数
3. 右下角工具条：`拾取中/已暂停`、`轮廓开/关`、`重新分块`；选中后多出 `取消选中`
4. 键盘：`Shift+点击` 在块内继续下钻 · `Alt+点击` 上溯到父级 · `Esc` 取消选中
5. **取消选中三种方式**：`Esc` 键 / 预览右下角工具条的 `取消选中` / 右侧面板的 `取消选中` 按钮
6. 点「抽离成独立页面」→ 生成只含这一块的沙盒，在同一视窗右下对比调试
7. 右侧板块列表点击 → 反选回预览并自动滚动定位
8. **在「生成修改指令」里写清想怎么改 →「复制给开发智能体」** → 拿到带文件路径与行号的
   上下文，直接粘给正在改这个项目的智能体

## 智能体怎么接管

用户的选中结果会写到 `state.json`（轻量）和 `selection-full.json`（含 HTML/CSS）：

```bash
curl -s http://127.0.0.1:7788/api/state      # 名称/选择器/尺寸/样式
curl -s http://127.0.0.1:7788/api/selection  # 加上完整 html 与 css
```

拿到这些就能直接针对这一块改源文件——这是「用户指哪儿，智能体打哪儿」的接口。

### API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回实际端口 |
| GET | `/api/state` | 目标 + 选中摘要 + 最近 20 条历史（不含大字段） |
| GET | `/api/selection` | 当前选中的完整数据（含 html/css） |
| POST | `/api/state` | 写状态；带 `selection` 时自动剥离大字段分流落盘；`{clear:true}` 清空选中 |
| POST | `/api/target` | 设置目标文件 `{src}` |
| POST | `/api/export` | 抽离沙盒 `{name, html, css, meta}` |
| GET | `/preview?src=` | 代理目标页 + 注入拾取脚本 |
| GET | `/sandbox/<id>/index.html` | 访问生成的沙盒 |

## 源码行号定位（让智能体知道改哪一段）

**服务端代理时先给每个元素打行号标记，再注入自己的东西**：

- `annotateHtml()` 扫原始源 HTML，按文档顺序给每个开始标签插入 `data-wb-l="起始行"`，
  遇到闭合标签时补 `data-wb-e="结束行"`
- 插入的属性**不含换行**，所以不会造成行号偏移
- `<script>` / `<style>` / `<textarea>` / `<title>` 的内容区整体跳过，
  所以 `<script>` 里的 `a < b` 不会被误判成标签
- 注入的 `<base>` / `<script>` 在标注**之后**才加，保证行号指向用户真实源文件

浏览器里 `el.getAttribute('data-wb-l')` 就能拿到行号，实测与源文件**逐行吻合**。
导出沙盒前用 `cleanOuterHtml()` 剥掉这些 `data-wb-*` 属性，不污染用户代码。

**只对静态 HTML 可靠**：要求「源文件怎么写就怎么渲染」。JS 动态增删的节点对不上号，
这种情况 `source.located` 为 false，界面提示「未定位到行号」，退化为只给 CSS 选择器。

## 生成修改指令（本工具的主要用途）

选中板块 → 在「生成修改指令」里写诉求 → 一键复制，得到这样的文本：

```
【只改下面这一个板块，不要动页面其它部分】

目标文件：D:\project\shop.html
准确位置：第 266–320 行（共 55 行）
DOM 路径：body > div.layout > main.content > section.charts
节点尺寸：1123 × 300（页面视口 1410 × 805）
板块标识：图表区  <section class="charts">
子元素数量：2
板块内文字：近 7 日订单趋势 单位：单 …

当前关键样式：
  display: flex
  gap: 16px

【我想怎么改】
<用户填写的诉求>

【硬性约束】
1. 只改这一个板块对应的代码，不要改其它板块的结构和样式。
2. 如果这次改动会波及别的区域，先说明影响范围，再动手。
3. 保持项目现有的代码风格和命名习惯，不要顺手重构无关代码。
4. 改完告诉我具体改了文件的哪几行。
```

**为什么不做图像识别（YOLO 之类）**：
- YOLO 是目标检测，只认训练集学过的类别，认不出「价格板块」这种页面语义
- 就算自训，输出也是像素级近似；而 DOM 里的边界本来就**像素级精确**
  （`getBoundingClientRect`），等于拿模糊估计替换精确已知值，还多背一个推理服务
- 真正的问题不是「框不准」，是「框的粒度未必是你要的」——
  解法是下钻/上溯微调 + 元素级点选，不是换更强的模型

## 同类工程（先看这个，别重复造轮子）

「点元素 → 生成提示词 → 交给 AI 编码智能体」不是新创意，2026 年已经是一个成型的赛道。
做任何扩展前先对照下表，能复用思路就别自己重写。

| 项目 | 形态 | 与我们的关系 |
|---|---|---|
| `PaulHarrer/agentgrab`（MIT，Aug 2026） | Chrome/WXT 扩展 | **重合度最高**。点元素 → 写诉求 → 复制 Markdown 提示词。含稳定选择器、XPath/DOM 路径、outerHTML、父子结构、全属性、可见文本、计算样式、尺寸+视口、框架源码 file:line（dev build）、**grep 关键词表**、以及「只改要求的部分、找不到就说找不到」的指令 |
| `oil-oil/selector`（MIT，活跃至 Oct 2026） | 书签小工具 | 点选/框选多元素、逐元素批注、`⌘C` 复制提示词、`⌘⇧C` 截图、Sharingan 高保真模式；输出含稳定 locator + React 组件链 + `file:line` |
| `aidenybai/react-grab`（MIT） | npm 包 + 框架插件 | `⌘C` 复制「文件名 + 组件 + HTML」；另有 MCP server 让智能体直接操作浏览器。**只面向 React dev build** |
| `greenstevester/mcp-pointer` | Chrome 扩展 + MCP server | 扩展抓元素 → WebSocket → MCP 工具，智能体直接读，无需人工复制。React 组件探测为实验性 |
| `see-my-clicks` | Vite 插件 / dev-server 中间件 | Alt+点击存本地 JSON，智能体通过斜杠命令或"check my clicks"读走。有 Vite / SvelteKit / Express / Webpack 各种接线 |
| `infi-pc/locatorjs`、`ericclemmons/click-to-component`、`zthxxx/react-dev-inspector`、`vite-plugin-vue-inspector`、`code-inspector-plugin` | 构建插件/npm 包 | 只做「点组件 → 在 IDE 打开源码」，不生成提示词。**它们的 babel/loader 注入源码位置的思路值得借鉴** |
| `ChromeDevTools/chrome-devtools-mcp` | MCP server（Google 官方） | 让智能体控制真实 Chrome。不做分块与提示词 |
| UI Context for Agents / SuperchargeInspect | Chrome 扩展 | 多条批注、区域框选、优先级标记、多档详细度、附截图 |

**我们的三点真差异**（对应上面矩阵里只有我们亮的格子）：
1. **自动分块**：上面所有工具都是「自由点任意元素 + 上下钻」，没有「先把整页切成板块供浏览」这一层视图。
2. **零安装**：不改项目、不装扩展、不加书签、不装 npm 包，只在 WorkBuddy 内置预览里跑。
   上面多数要求「装到项目里」（react-grab / see-my-clicks）或「装浏览器扩展」。
3. **静态 HTML 也能给行号**：别人的 `file:line` 全靠 React/Vue dev build 的组件元数据，
   对纯手写 HTML **完全无能**；我们的 `data-wb-l/e` 标注恰好只对静态 HTML 有效。
   两者是互补的，不是同一格。

**结论**：这三点够不够撑一个独立工具，见 `## 已知限制` 之后的评估。
如果要做框架页面的源码定位，直接抄 `locatorjs` / `code-inspector-plugin` 的做法，
别自己设计。

### 实测对比：AgentGrab vs 本工具（2026-10-16，同一页面同一区域）

测试页：一个单文件静态 HTML（仪表盘样式的网络测速页，776 行），
两侧都取 `.stats` 区域、同一句诉求。完整记录见 `docs/comparison.md`。

| | AgentGrab | 本工具 |
|---|---|---|
| 提示词长度 | 3194 字符 | 817 字符 |
| **文件名** | **无**（只有页面标题 + URL） | **有**，绝对路径 |
| **精确行号** | **无** | **有**，第 185–191 行，人工核对吻合 |
| 分块总览 | 无 | 6 块清单 + 名称 + 尺寸 |
| outerHTML / XPath / 全属性 | 有 | 无 |
| grep 关键词表 | 有，但静态页上很弱 | 无 |
| 硬性约束 | 5 条 | 4 条 |

**读它的构建产物得到的关键事实**：`file:line` 全部来自框架 dev build
（React `fiber._debugSource` / `_debugInfo[0].lineNumber`，Vue `__vueParentComponent.type.__file`，
Svelte 只有 `svelte-xxxxx` 类名没有文件名）。**纯静态 HTML 页面上 `sourceHints` 为空，
提示词里整节 `### Source hints` 直接消失**，grep 词表退化成 `.card` 加一长串拼接文本
（`.card` 满页都是、长文本实际搜不到），全文不出现目标文件名。
→ 结论坐实：`data-wb-l/e` 在静态 HTML 上是**独有优势**，不是"同一个格子里做得差一点"。

**反向发现**：它跑在真实标签页上，页面自身后端可用；我们走代理换了 origin，
页面自己的接口会打到我们服务上而失效。→ **同日已修**：加 `--upstream <url>` 反代（见「启动」）。

## 通信架构（改这块之前必读）

父子页之间**三条通道并行**，任何一条通就够：

1. `BroadcastChannel`（同源快速通道）
2. `postMessage`（跨源兜底）
3. **轮询 `/api/state`（700ms）——保命的那条**

**为什么必须有第 3 条**：内置预览面板的 webview 环境可能把前两条隔断，表现就是
「用户点了板块，页面高亮正常，但右侧面板毫无反应」。轮询只要本地服务读写通就一定同步。
调试台状态栏会显示当前生效的通道（`bc` / `pm` / `poll`），出问题时先看这个。

选中链路是「**先出视觉反馈，再做序列化**」——`serialize()` 万一抛错也不会出现「点了没反应」。

## 分块算法（`inject.js` 的 `detect()`）

自顶向下走 DOM，判断顺序：

1. **无子节点** → 这是一个板块
2. **单子节点** → 若自身是「有名字的块」（语义标签或类名命中词典）且高度够，停下；否则下钻
3. **多子节点** → 依次判断：
   - `isStack()` **纵向堆叠**：每个孩子宽度 ≥ 容器 72%
   - `isColumnSplit()` **横向分栏**：2~3 个孩子、每个高度 ≥ 视口 60%（侧边栏 + 主列这种）
   - 两者都不满足 → 整个容器算一块（典型是一排卡片网格）
4. 高度 > `TALL_MULT(1.0)` × 视口的块**继续下钻**，最深 4 层

**两个阈值的由来**：
- `TALL_MULT` 原来是 1.6，导致「侧边栏 + 主列」布局里的主列（934px）没被下钻，
  整个后台页面只切出 2 块。改成 1.0（超过一屏就切）后正常切出 5 块。
- `isColumnSplit` 的基准是**视口高度**而不是容器高度：因为 sticky 侧边栏高度只有
  视口高，拿容器高度（内容总高）比会算成 45%，判不出来。

**命名**：`NAME_DICT` 按顺序匹配 id/class 关键词（hero/nav/topbar/chart/table/pricing/faq…），
再退到语义标签映射，最后叫「区块」。

## 踩过的坑

| 现象 | 原因 | 修法 |
|---|---|---|
| 左侧预览空白，只显示「填入目标路径」提示 | `.empty` 带 `display:flex`，**CSS 覆盖了 `hidden` 属性的 `display:none`** | `[hidden] { display: none !important; }` |
| 工具条自己被切成一个板块（461×45） | 调试台自建的 `#__wb-bar` 挂在 body 下，被当成了页面元素 | `isVisible()` 排除 `#__wb-*`，工具条改挂 `documentElement` |
| 点了板块右侧没反应 | 预览环境隔断了 BroadcastChannel / postMessage | 加轮询兜底 |
| 主列没被下钻 | `TALL_MULT` 1.6 太高 | 降到 1.0 |

## 已知限制

- **只吃单文件本地 HTML**。dev server、多文件项目的外链资源代理还没做。
  目标页里写死的绝对路径（`/style.css`）不走 `<base>`，会 404。
- ~~代理会换掉 origin，页面自身的后端失效~~ —— **已修**（2026-10-16）：加 `--upstream <url>`
  后，未命中的路径整体反代到上游，页面自己的 `/api/...` 能正常工作。
  实测测速页：不挂 upstream 时顶部报「未连接到本地服务」，挂上后变成「正在探测国内节点…」，
  `/api/nodes` 正常返回。**代价**：路径不能和本工具的 `/api/health|state|selection|target|export`
  撞名（撞了会被我们截胡）；也不做 WebSocket 升级转发。
- **分块比"自由点元素"粗**：并排的两张卡片高度不足一屏时，`TALL_MULT` 不触发下钻，
  也不满足 `isColumnSplit` 的高门槛，会被算成**一个块**。单张卡片要 `Shift+点击` 下钻一次。
  这是"先总览后下钻"和"直接点"的取舍，不是 bug（AgentGrab 可直接点单张卡片）。
- **抽离的沙盒可能丢样式**：若样式来自后代选择器（如 `.wrapper > .hero`），
  脱掉祖先链后规则不匹配。目前是把全页 CSS 都带上，靠选择器自身命中。
- **回写源文件还没做**。抽离产物落在 `out/`，是独立沙盒，不会改动原项目。
  回写需要 DOM → 源文件映射，静态 HTML 可精确做，框架页面得先注入源码定位信息。
- 页面用 GBK 编码时会被按 UTF-8 读，中文乱码。
- 块内若含 `<script>`，会一并带进沙盒执行。

## 实测记录

两个示例页（1440×900 视口）都零误差：

`examples/dashboard.html` — 后台看板，**5 块**
侧边栏 224×805 · 工具栏 1171×62 · 数据区 1123×131 · 图表区 1123×300 · 表格区 1123×353

`examples/demo.html` — 落地页，**7 块**
页头 1395×65 · Hero 1395×452 · 特性区 1395×472 · 数据区 1395×236 · 价格区 1395×566 · FAQ 1395×547 · 页脚 1395×277

## 回归验证

改完 `inject.js` / `server.mjs` 后跑探针，比开真浏览器点快得多：

```bash
node scripts/probe.mjs <目标HTML绝对路径> [要点第几块，默认3]
```

它会启动无头 Edge、模拟点击、读回服务端状态，输出 PASS/FAIL。
`inject.js` 会把分块摘要写进隐藏节点 `<script id="__wb-report" type="application/json">`，
想直接看分块结果就 `--dump-dom` 后解析它，不用开真浏览器。

**Edge 无头截图**必须用 Windows 绝对路径（反斜杠），相对路径会报「拒绝访问 0x5」：
```bash
msedge.exe --headless=new --disable-gpu --no-first-run --hide-scrollbars \
  --user-data-dir=<临时目录> --window-size=1400,900 --virtual-time-budget=7000 \
  --screenshot="D:\abs\shot.png" "http://127.0.0.1:7788/?src=<编码后的路径>"
```
