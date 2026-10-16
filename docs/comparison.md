# 实测对比：SectionBrief vs AgentGrab

*Measured comparison: SectionBrief vs AgentGrab on the same page and the same element.*

被测对象 [AgentGrab](https://github.com/PaulHarrer/agentgrab)（MIT，浏览器扩展）是同类工具里
理念最接近的一个：点元素 → 写诉求 → 复制一段结构化提示词交给编码智能体。
这里记录一次同页面、同元素的实测，用来确认两边的能力边界到底差在哪。

## 测试条件

| | |
|---|---|
| 页面 | 单文件静态 HTML，776 行（一个仪表盘样式的网络测速页） |
| 区域 | `.stats` 关键指标区 |
| 诉求文本 | 两边填写完全相同的一句 |
| 视口 | AgentGrab 1410×805；SectionBrief 1037×791（调试台占了侧栏宽度） |

两侧都不是人工点出来的，而是无头浏览器驱动、读回真实产物：

- `scripts/agentgrab-probe.mjs` —— stub 掉 `chrome.runtime`、注入 AgentGrab 的内容脚本，
  手动投递 `{type:'agentgrab:start'}` 启动拾取，派发合成 `mousemove/mousedown/mouseup/click`
  选中元素，往它弹窗（shadow root 内）的 textarea 写诉求、点 Preview，读 `<pre>` 里的最终提示词。
- `scripts/compare-probe.mjs` —— 打开调试台，从 iframe 的 `#__wb-report` 读分块结果，
  在 iframe 里派发点击，填 `#intent`，读 `#promptOut` 拿工具**真正生成**的提示词。

## 结果

| | AgentGrab | SectionBrief |
|---|---|---|
| 提示词长度 | 3194 字符 | 817 字符 |
| **目标文件名** | **无**（只有页面标题和 URL） | **有**，绝对路径 |
| **精确行号** | **无** | **有**，第 185–191 行 |
| 分块总览 | 无 | 6 块清单 + 名称 + 尺寸 |
| CSS 选择器 | ✓ | ✓ |
| XPath | ✓ | ✗ |
| 元素 outerHTML | ✓（截断 4000 字符） | ✗ |
| 父/子元素结构 | ✓ | 只有子元素数量 |
| 全部属性 | ✓ | 只有关键样式 |
| grep 关键词表 | ✓ | ✗ |
| 计算样式 | 15 条 | 15 条 |
| 硬性约束 | 5 条 | 4 条 |

## 关键发现：静态 HTML 上它拿不到行号

AgentGrab 的 README 承诺提供框架源码 `file:line`。读它的构建产物
（`content-scripts/content.js`）可以确认实现方式：

- React → `fiber._debugSource.fileName` / `_debugInfo[0].lineNumber`
- Vue → `__vueParentComponent.type.__file`
- Svelte → 只看 `svelte-xxxxx` 类名，**没有文件名**
- Angular → 只看 `_nghost` / `ng-tns` 属性

全部依赖框架的 dev build。纯手写 HTML 页面上 `sourceHints` 是空数组，于是：

1. 提示词里**整节 `### Source hints` 直接消失**；
2. 弹窗头部退化成 `1 attributes · 2 search hints`；
3. `### Strings to grep for in the codebase` 只剩两条且质量很差 ——
   `.card`（满页都匹配）加一长串拼接文本（实际搜不到）；
4. **全文不出现目标文件名**。

SectionBrief 的 `data-wb-l` / `data-wb-e` 标注恰好只对静态 HTML 有效，
这次实测 `.stats` → 第 185–191 行，人工核对：185 行是 `<div class="stats">`，
191 行是对应闭合标签，逐行吻合。

结论：这一格不是"谁做得更好"，而是**两种互不覆盖的技术路线**。
框架页面该用它们的方案，静态 HTML 目前只有这一条路。

## 反向发现：代理换 origin，页面自身后端失效（已修）

第一次测试时，预览里的页面顶部报「未连接到本地服务」。原因是调试台把页面代理到
`127.0.0.1:7788`，而页面对同源 `/api/...` 的请求就打到了本地服务上，它的后端其实在 `8770`。

修法是给 `server.mjs` 加 `--upstream`：

```bash
node server.mjs --upstream http://127.0.0.1:8770
```

未命中的路径整体转发给上游。验证：`GET :7788/api/nodes` 从 404 变 200（返回节点列表），
页面顶部从「未连接到本地服务」变成「正在探测国内节点…」。

实现细节：转发时剥掉 `accept-encoding`，否则上游返回 gzip 而响应头里的
`content-encoding` 被剥掉，前端会解不开。

AgentGrab 没有这个问题 —— 它注入的是浏览器当前那个真实标签页。

## 复现

```bash
# AgentGrab 侧（需要先拿到它的构建产物）
node scripts/agentgrab-probe.mjs \
  "http://127.0.0.1:8770/" \
  "<path>/chrome-mv3/content-scripts/content.js" \
  ".gauges .card" ".stats"

# SectionBrief 侧
node server.mjs
node scripts/compare-probe.mjs "<path to page>.html" 3 "<your intent>"
```
