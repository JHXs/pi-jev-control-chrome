# pi-jev-control-chrome：Jev + Pi Agent + Chrome Relay

> 版本 0.4.3 · 2026-10-16 · 本地扩展 / 实验实现（非上游官方插件）
>
> 仓库：https://github.com/JHXs/pi-jev-control-chrome（MIT）
>
> 全部配置都在 `~/.pi/agent/jev-browser.json` 里，**不需要为本扩展设置任何环境变量**；用哪个 System One classifier（provider + 模型）也在这个文件里选，默认 `typesafe`/`jev-latest`，并且可以用 `classifierBaseUrl`/`classifierApiKey` 把请求指到自己的网关（如 magpie），**不必改 `models.json`**。已通过 **36 项不联网的模拟测试**，已在 **Pi 1.3.0 + pi-control-chrome 0.8.0** 中成功加载并注册（`jev_browser_task` + `/jev-chrome-check`），Jev 决策已用真实 TypeSafe API 实调通过（每步约 0.3–1.0 秒），并已在**真实 Chrome** 上跑通端到端搜索闭环（Wikipedia：填搜索框 → 提交 → 条目页 → `DONE`，3 步约 8 秒）。各网站的 DOM 适配与长任务延迟仍需更多实测。

## 实现的功能

```
用户自然语言任务
      │
      ▼
Pi 主模型（比如 DeepSeek）
      │ 一次调用 jev_browser_task
      ▼
┌──────────────────────────────────────┐
│ 本扩展：步骤上限 / 来源白名单 / 安全策略 │
│       ┌──────────────────┐           │
│       │ pi-control-chrome│ 读取 DOM   │
│       └─────┬────────────┘           │
│             ▼                        │
│       TypeSafe Jev System One        │
│       从有限的候选动作中选一个        │
│             ▼                        │
│       pi-control-chrome              │
│       点击 / 填写 / 回车 / 滚动        │
│             ▼                        │
│       重新截图? 否，只读取 DOM        │
│       持续迭代直至 DONE / 异常        │
└──────────────────────────────────────┘
      │
      ▼
Pi 主模型验收（done_unverified≠成功证明）
```

这是一个**谨慎的快速搜索 / 导航 / 阅读自动化工具**，并非完全自动的通用网页操作 Agent。现有 `pi-control-chrome` 工具保持原样；本扩展通过 Pi 的 `ctx.executeTool()` 接口复用已有的浏览器工具，因此不再起独立 Playwright 浏览器，也不会额外监听一个 Relay 端口。Jev 只收到网页结构化的简要描述和一组允许的动作。

**特别注意：** `pi-jev-browser` 是独立的 Playwright 驱动，本项目并不依赖它；`pi-system-one` 也不是必须安装的前置插件。

## 安装步骤（Fedora / EndeavourOS / fish）

### 1. 基础依赖

```fish
node --version   # >= 22
pi --version
pi install npm:pi-control-chrome
```

在 Chrome 打开 `chrome://extensions`，开启「开发者模式」并「加载已解压的扩展程序」，选择 **pi-control-chrome** 已安装包里的 `extension/` 文件夹。Pi 无法代替你自动安装这个浏览器扩展。检查 `/chrome status` 和 `/chrome tabs` 以确认 Bridge 和 Chrome 正常连接。

如需寻找已安装的 Chrome 扩展目录（路径以实际安装情况为准）：

```fish
find ~/.pi -type f -path '*/pi-control-chrome/extension/manifest.json' -print
```

### 2. 放进 Pi 的用户扩展目录

```fish
mkdir -p ~/.pi/agent/extensions
# 方式一：从 GitHub 克隆（仓库公开）
git clone https://github.com/JHXs/pi-jev-control-chrome.git ~/.pi/agent/extensions/pi-jev-control-chrome
# 方式二：已经下载了压缩包
unzip pi-jev-control-chrome.zip -d ~/.pi/agent/extensions
```

因为这是一个 git 仓库，之后用 `git -C ~/.pi/agent/extensions/pi-jev-control-chrome pull` 就能更新。如果你要在这个目录里改代码并保留本地改动，建议先 `git switch -c mine` 再改，免得以后 `pull` 撞上冲突。

目录名是 `~/.pi/agent/extensions/pi-jev-control-chrome/`。**这就是全部安装步骤：Pi 启动时会自动发现 `extensions/` 下含 `index.ts` 的子目录，不需要 `pi install`，也不需要写 `settings.json`。**

直接在那个目录里改代码，改完重启 Pi（或在会话里 `/reload`）即生效。**不需要 `npm install`**：本扩展没有 npm 依赖，Jev 决策走 Pi 内置的 `typesafe` classifier 提供方（见 §3.1），因此也不需要另行安装任何 SDK。无需修改 `pi-control-chrome` 的源码。

（如果你更喜欢把它当作可被 `pi list` 看到的本地包，也可以把它放到任意位置后用 `pi install <路径>` 登记；不要同时使用两种方式，否则会重复加载。）

### 3. 写配置文件（不再需要环境变量）

所有开关都放在 Pi 的 agent 目录下这一个 JSON 文件里：

```fish
$EDITOR ~/.pi/agent/jev-browser.json
```

```json
{
  "allowedOrigins": ["https://*.wikipedia.org", "https://github.com"],
  "sharePageText": false,
  "provider": "typesafe",
  "model": "jev-latest",
  "hideNativeTools": false
}
```

| 键 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `allowedOrigins` | **是** | 无 | 允许操作的来源白名单。留空或不写就等于「一个网站也不许碰」 |
| `sharePageText` | 否 | `false` | 是否把每页最多 1200 字网页正文发给 TypeSafe |
| `provider` | 否 | `typesafe` | 用哪个 provider 的 System One classifier（`typesafe`、`opencode`、`openrouter`、`vercel-ai-gateway`、`cloudflare-workers-ai`、`openai`，或自己在 `models.json` 里改过 baseUrl 的 `typesafe`） |
| `model` | 否 | `jev-latest` | 换成该 provider 下别的 classifier 模型 id |
| `classifierBaseUrl` | 否 | 不覆盖 | 只给本扩展的 Jev 请求换一个 System One 端点（例：`http://127.0.0.1:3425/v1/`）。留空则用 Pi 为该 provider 配置的地址。必须是 http(s) URL；写错会直接报错，不会静默回落到厂商端点 |
| `classifierApiKey` | 否 | 不覆盖 | 配合上一项使用的凭据（本扩展自身的请求用它，不再要求 provider 已鉴权，因此可以不设 `TYPESAFE_API_KEY`）。不写则用 Pi 的 provider 凭据 |
| `hideNativeTools` | 否 | `false` | 隐藏原生 `browser_*` 工具声明，由 `jev_browser_task` 独占协调浏览器 |
| `autoLoadChromeSkill` | 否 | `true` | 首次调用时自动读取 `pi-control-chrome` 的 `SKILL.md`，打开它自己的浏览器工具激活闸门（设为 `false` 则要求你自己先手动加载该 Skill） |

**白名单支持泛域名**：

- `https://*.wikipedia.org` —— 匹配 `en.wikipedia.org`、`zh.m.wikipedia.org` 等**任意层级**子域名，但**不匹配**裸域名 `wikipedia.org`，也不会被 `en.wikipedia.org.evil.test`、`evwikipedia.org` 这类仿冒域名命中；
- `https://*` —— 该协议下的任意主机（`https://anything.test` 可以，`http://anything.test` 不行）；
- `https://github.com`、`http://localhost:3000` —— 精确来源；**不写端口时只匹配该协议的默认端口**（`https://github.com` 不匹配 `https://github.com:8443`）；
- 协议即规则的一部分：`https://…` 的规则不会放行 `http://…`。

以本地文件为准的配置意味着：**不需要**在启动 Pi 前 `set -gx` 任何变量，也不会因为 Pi 由旧终端/桌面启动而丢掉白名单。改完配置后在 Pi 里执行 `/reload` 即可生效（配置按 mtime 缓存，保存即失效）。

仍需的**唯一**环境变量是 `TYPESAFE_API_KEY` —— 而且只在两种情况之一才需要：你没有在配置里写 `classifierApiKey`（想用官方端点/官方凭据），或者你换了别的 provider 而它本身需要凭据。`PI_CONTROL_CHROME_LAZY_TOOLS`、`JEV_BROWSER_ALLOWED_ORIGINS`、`JEV_BROWSER_SHARE_PAGE_TEXT`、`JEV_BROWSER_HIDE_NATIVE_TOOLS`、`TYPESAFE_DEFAULT_MODEL` 都已不再使用；`TYPESAFE_BASE_URL` 本来就不使用（地址由 Pi 的 provider 配置或 `classifierBaseUrl` 提供）。

`pi-control-chrome` 的浏览器工具默认处于「延迟激活」状态，只有它的 Skill 被加载时才打开。本扩展在第一次调用时若发现工具未激活，会自己 `read` 那个 `SKILL.md`（`autoLoadChromeSkill: true`，即“用户既然要求跑浏览器任务，就相当于明确请求了浏览器控制”）再继续；因此**不需要** `PI_CONTROL_CHROME_LAZY_TOOLS=false`。若你更希望保留上游的纯手动闸门，把 `autoLoadChromeSkill` 设为 `false`，然后自己先让模型读一次那个 Skill（或用 `/skill:pi-control-chrome`）。

### 3.1 Jev 是怎么被调用的（可以是任意 provider 的 classifier）

本扩展**不直接 import TypeSafe SDK**，而是用 Pi 自己的分类器注册表：`ModelRegistry.findOfType("classifier", provider, model)` + `ctx.modelRegistry.classify()`。

- 鉴权、baseURL、超时与重试、代理都由 Pi 统一处理（Pi 启动时会装上全局 HTTP 代理 dispatcher，所以 `http_proxy` 环境下也能直连）；
- **用哪个 provider 由配置文件的 `provider`/`model` 决定**，默认 `typesafe` / `jev-latest`，没有把任何厂商写死；
- 凭据由对应 provider 提供：默认的 `typesafe` 通常靠 `TYPESAFE_API_KEY`；也可以用配置文件的 `classifierApiKey` 自带凭据（此时不再检查 provider 是否已鉴权）；换 provider 后就要配那个 provider 的凭据，否则调用会在任何浏览器动作**之前**报错退出（错误信息会指明缺哪个 provider 的凭据）；
- 报错时会把 Pi 当前认识的全部 classifier 列出来（例如你写了 `provider: "typesafe"` 但模型 id 其实属于 `opencode`，它会提示 `模型 id "jev-1.13" 在其它 provider 下存在：opencode/jev-1.13`）。

Pi 1.3.0 内置的 classifier（共 40 个；`/jev-chrome-check` 会实时列出你机器上的完整清单）：

| provider | 模型 id 示例 | api |
| --- | --- | --- |
| `typesafe` | `jev-latest` | `typesafe-system-one` |
| `opencode` | `jev-1.13`、`jev-1.13-free` | `typesafe-system-one` |
| `openrouter` | `~typesafe/jev-latest`、`~perplexity/pplx-decider-latest`、`cloudflare/clef` 等（共 23 个） | `typesafe-system-one` |
| `vercel-ai-gateway` | `convaiinnovations/laya`、`openai/gpt-6-luna-decisions`、`liquid/d1` 等（共 10 个） | `typesafe-system-one` |
| `cloudflare-workers-ai` | `@cf/cloudflare/clef`、`@cf/cloudflare/clef-flash` | `cloudflare-workers-ai-system-one` |
| `openai` | `gpt-6-luna` | `openai-decisions` |

**把自己的网关接到 Jev 上**（例：本地 magpie 网关提供 Jev）——推荐做法是**只改本扩展的配置文件**，`models.json` 完全不动：

```json
{
  "allowedOrigins": ["https://*.wikipedia.org"],
  "provider": "typesafe",
  "model": "jev-latest",
  "classifierBaseUrl": "http://127.0.0.1:3425/v1/",
  "classifierApiKey": "magpie"
}
```

实测（Pi 1.3.0 + magpie，即本仓库当前的配置）：删掉 `models.json` 里的 `typesafe` 覆盖、并不设 `TYPESAFE_API_KEY`，只靠上面这两项，Wikipedia 搜索闭环照样 `done_unverified` 跑通（填框 → 提交 → DONE，3 步约 8 秒）。原理：Pi 用我们传入的 model 对象里的 `provider` 去找 provider（所以 System One 的客户端实现不变），端点和密钥分别取「model 对象自己的 `baseUrl`」与「`classify()` 调用的 `apiKey`」参数。

一个优先级细节：如果该 provider 在 `models.json` 里**自己**配了 `baseUrl`，那个地址会盖过 `classifierBaseUrl`（Pi 的 auth 解析出的 baseUrl 优先）。想让配置文件说了算，就不要在 `models.json` 里为同一个 provider 再写 `baseUrl`。

作为替代方案，也可以改 `~/.pi/agent/models.json`（影响 Pi 里所有用该 classifier 的地方，不只本扩展）：

```json
{
  "providers": {
    "typesafe": { "baseUrl": "http://127.0.0.1:3425/v1/", "apiKey": "magpie" }
  }
}
```

两个 `models.json` 的限制（实测确认，改之前请注意）：

- **不要给被覆盖的 provider 写 `models` 数组**：一旦写了，该 provider 的模型清单会被这个数组整体替换，连内置的 `jev-latest` 都会找不到；只写 `baseUrl`/`apiKey` 就是纯覆盖，最安全；
- **`models.json` 不能新增 classifier**，也不能让一个新 provider 支持分类：`provider-composer` 只给内置 provider 装 classify 实现（新 provider 会报 `Provider <x> does not support classification`）。所以能选的永远是「Pi 已经认识的那些 classifier」，可以换的只是它们连到哪里、用哪把钥匙。

### 3.2 什么时候用 Jev（与原生 `browser_*` 工具的分工）

默认 `hideNativeTools: false`：Pi 会话里**同时**能看到 pi-control-chrome 的 `browser_*` 工具和本扩展的 `jev_browser_task`，由主模型自己挑。本扩展不抢控制权，只在 tool description 和 promptGuidelines 里做**软引导**：

- 整段任务如果是「打开/搜索/点击/滚动」这类动作序列，且都在白名单站点内 → 优先 `jev_browser_task`（决策循环在本地跑，比主模型一步步驱动原生工具便宜得多）；
- 需要页面 JavaScript、精确取值、白名单之外的来源，或属于「永不自动执行」清单（登录、邮件、提交、支付…）→ 回退原生 `browser_*` 工具。

为什么不强制：Jev 只做「从快照候选里选下一步」，**不负责读值或总结**。实测（github.com/torvalds/linux 的 star 数）：`jev_browser_task` 把页面打开后第 1 步就答 `DONE`（1 步 / 17.4 秒），star 数要靠主模型从返回的页面证据里读，或改用 `browser_evaluate`。所以 goal 最好写成动作（“打开 X 并搜索 Y”），而不是问题（“X 有多少 star”）。想让 Jev 独占浏览器，把 `hideNativeTools` 设为 `true`（代价：上面这类复杂任务基本做不了）。

### 4. 检查和测试

Pi 会话中先输入：

```text
/jev-chrome-check
/chrome status
/chrome tabs
```

接着对 Pi 说：

> 使用 `jev_browser_task`，在英文维基百科中搜索 Ada Lovelace 并打开她的条目。网页地址 `https://en.wikipedia.org/wiki/Main_Page`；要搜索的文本是 `Ada Lovelace`，搜索框名称为 `Search`。完成后核实页面标题。

Pi 应调用如下工具参数：

```json
{
  "goal": "Search Wikipedia for Ada Lovelace and open the biography page",
  "url": "https://en.wikipedia.org/wiki/Main_Page",
  "inputs": [{ "field": "Search", "value": "Ada Lovelace" }],
  "maxSteps": 15,
  "minProbability": 0.55,
  "keepTab": true
}
```

如要复用当前 Chrome 选中的标签页，改成 `"selected": true`，并**删除** `"url"`；或者输入明确的 `"tabId": 123`。三种方式只能选其中一种。

## 工具入参

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `goal` | 是 | 任务目标：网页导航、只读搜索、定位内容；1–1200 字符 |
| `url` / `tabId` / `selected:true` | 三选一 | 新建标签页、选择已存在的 Tab ID、使用当前 Tab |
| `inputs` | 否 | 具体字段名称与**精确**输入文字，如 Search、Ada Lovelace；不接受敏感字段 |
| `maxSteps` | 否 | 默认 15，最多 30 次 Jev 决策 |
| `minProbability` | 否 | 默认 0.55；**有副作用的动作**（点击/填写/回车/滚动）低于此概率直接退出。三类动作不受限：（1）`DONE`/`WAIT` 不改变页面，卡住它们会把已成功的任务误报为 `uncertain`；（2）本工具**预先授权**的动作——`FILL`（只写入调用方本地提供的值）和 `PRESS_ENTER`（提交本工具刚填好的搜索框）——因为 Jev 要在约 40 个候选里分配概率，正确的提交本来就落在 0.5–0.65，卡它只会随机失败（实测 0.54 被拒、0.61 通过） |
| `timeoutMs` | 否 | 默认 120000，范围 5000–300000 毫秒 |
| `keepTab` | 否 | 默认 `true`，新建标签页会标记为用户交接（避免本轮结束被 Pi 清理） |

Jev 可能输出 `DONE`、`WAIT`、`REVIEW`、`BLOCKED` 或 `CLICK:eN`、`FILL:eN`、`PRESS_ENTER:eN`、`SCROLL_DOWN`、`SCROLL_UP`。工具只接受**当前这一轮明确枚举的选择**；不会接受任意脚本、URL、CSS、键盘快捷键。

回车提交的条件：某个输入框的 `name/label/placeholder` 带有搜索语义（如 `Search`、`搜索`、`站内搜索`、`query`）且页面是 http(s) 页面时，才会在填入后生成 `PRESS_ENTER:eN` 候选。普通表单输入框（例如「你的名字」）**不会**被回车提交，只有 `type="search"` 的原生搜索框在任何名称下都可回车。

滚动不受「同一动作重复」保护限制（上限 12 次 `SCROLL_DOWN`/`SCROLL_UP`），因此长页面可以连续翻读；点击、填写、回车仍受重复保护。

### 关于 Jev 的「不要提交」规则

Jev 的默认规则里包含「不要用按钮发送/提交/保存」，而搜索类任务恰恰需要提交。本扩展因此对**它自己刚填入的搜索框**给出显式例外：只有当候选动作是「本地工具已填入的搜索框」的回车或其页面自带搜索按钮时，才会标 `permitted: true` 并在 rules 里写明例外；`FILL` 候选同样标注 `permitted`（值由本地提供，不算提交）。没有待提交的搜索框时不会给出任何例外。没有这条例外，Jev 会在填完搜索框后直接回答 `BLOCKED`，循环在第二步就停下。

`permitted` 必须同时写在**候选动作对象**（`buildCandidates`）和 Jev 的 criteria 上，两者不能分家：criteria 里的标记是给 Jev 看的（「这是允许的，别答 BLOCKED」），而 `runBrowserTask` 的概率阈值闸门读的是候选对象上的 `permitted`。0.4.2 及以前只有 criteria 带这个标记，于是提示词向 Jev 承诺了一个本地闸门随后会以「概率不足」否决的动作——Wikipedia 的 Search 按钮每次都会踩中：填框成功，第二步 Jev 选 `CLICK:e5`（即页面自带的 Search 按钮）得到约 0.5 的概率，闸门把它当普通副作用动作拒掉，任务以 `uncertain` 结束。现在 `buildCandidates` 会把该标记传播到候选对象上，`buildJevQuestion` 也只读候选对象上的标记，两边不可能再不一致（见 `test/core.test.mjs` 里的 `the page search BUTTON stays pre-authorised` 回归测试）。

## 停止条件

| 返回状态 | 含义 |
| --- | --- |
| `done_unverified` | Jev 判断已经完成；必须由 Pi 主模型根据最终网页证据验收 |
| `needs_review` | 需要人工/主模型处理（安全校验、登录、权限等） |
| `uncertain` | Jev 返回非候选动作，或动作概率不足阈值 |
| `blocked` | 缺乏安全动作、页面未进展或循环 |
| `step_limit` | 达到调用步骤预算 |
| `interrupted` | 连接故障、网页跨来源、超时、取消、API 错误等 |

不会自动执行：订单、支付、消息发送、帖子发布、删改资料、退出账户、验证码、密码/支付数据输入、下载、提交等行为。只自动点击保守筛选后的站内链接、搜索/筛选/分页一类按钮，填写用户提供的非敏感字段和滚动。通过 `snapshotId + eN ref` 约束点击目标，每次动作后重新读取页面，检测跨来源变化。

**已登录的网页意味着较高权限**：即便页面按钮的文字看上去无害，也可能触发服务器操作。因此建议先在公开/测试网站验证，不要先拿银行、后台管理界面或生产环境使用。浏览器数据、页面标题和部分 DOM 名称会提交给 TypeSafe。`inputs` 中的文字**不会作为完整候选值直接传给 Jev**，但用户目标中可能包含该内容，而且网站可能在标题或控件名称中回显输入文本。

## 测试

不需要安装 SDK、不需要 Chrome 的离线策略测试：

```fish
cd ~/.pi/agent/extensions/pi-jev-control-chrome
npm test
```

当前共有 36 项模拟测试，覆盖：配置文件的读取/校验/缓存与缺失或损坏时的拒绝、classifier provider/模型可自由选择（含空白值回退默认）、classifier 端点与密钥的手工覆盖（含非法 URL/空密钥被拒绝）、白名单精确匹配与通配符语义（`*.wikipedia.org` 命中子域名但不命中裸域名/仿冒域名/其它端口的端口）、工具错误处理、敏感元素清理、搜索→输入→回车→点击→完成闭环、用户标签页复用、越权目标、低置信度、验证码、跨来源跳转、未知结果不重试，以及带搜索语义的普通输入框可回车、普通输入框不可回车、长页面连续滚动不被误判为循环、畸形 href 不会中断任务、relay 断连被正确报告、待提交搜索框被显式标记为 permitted、FILL 候选被标记为 permitted、低置信度 DONE/WAIT 不被误拒、**预先授权的提交在低于概率阈值时仍执行**、**页面自带搜索按钮的 `permitted` 在 criteria 与本地闸门之间保持一致**、**没有待提交搜索框时搜索按钮不获得例外**等。

**已完成**：不联网策略测试（36/36）、在 Pi 1.3.0 + pi-control-chrome 0.8.0 中真实加载与注册冒烟、`/jev-chrome-check` 自检（读配置文件，不联网、不读页面）、用真实 TypeSafe API 实调 Jev 决策（单次 0.3–1.0 秒，含 2000+ 输入 token 的真实提问包）、**无任何 `JEV_*` / `PI_CONTROL_CHROME_*` 环境变量的干净进程里的端到端运行**（工具自行读取 `pi-control-chrome` 的 Skill 打开激活闸门，再完成整个任务），以及**真实 Chrome 上的端到端闭环**：在 en.wikipedia.org 从 Main Page 填入搜索框 → 提交（回车或页面自带 Search 按钮）→ 进入条目页 → `DONE`，多次实跑（Ada Lovelace / Grace Hopper）均在 3–4 步、约 8 秒内返回 `done_unverified`，页面证据的 URL/标题与目标一致。

**已知的偶发基础设施故障**：`browser_new_tab` 后 `browser_snapshot` 偶尔返回 `BROWSER_PAGE_UNAVAILABLE`（标签页停在浏览器错误页/受限页，pi-control-chrome 无法注入 page-agent）。实测 3 次里有 1 次如此；此时本扩展按设计安全终止为 `interrupted` 且不重放，重跑一次即成功。这属于 pi-control-chrome 与浏览器之间的环境问题，与本扩展的策略无关。

**尚未完成的验收**：真实网站上的整任务成功率与各站 DOM 适配（只在 Wikipedia 与百度上试过；百度搜索框的 label 不含「搜索」二字，匹配不上，未能完成）、多步长任务的端到端延迟、以及和其它 Pi 扩展/模型的协同。此扩展当前仍应视作可安装、可本地测试的原型，而不是发布级、已实机验证的产品。

## 排查

- `jev_browser_task` 工具不存在：确认目录在 `~/.pi/agent/extensions/pi-jev-control-chrome/`（里面有 `index.ts`），然后重启 Pi；`/jev-chrome-check` 应存在。
- 提示 `pi-control-chrome 没有提供这些工具`：`pi-control-chrome` 未安装，或它的**扩展被排除**——`~/.pi/agent/settings.json` 里若写成 `{"source":"npm:pi-control-chrome","extensions":["-pi-extension/index.ts"]}`，前导 `-` 是排除语法，`browser_*` 工具根本不会注册（写成 `"npm:pi-control-chrome"` 即按包自带的 manifest 加载扩展与 skills）。
- 提示 `pi-control-chrome 的浏览器工具当前未激活`：把 `autoLoadChromeSkill` 设回 `true`（默认），或手动先加载一次 `pi-control-chrome` 的 Skill（读取其 `SKILL.md`），或启动 Pi 前设 `PI_CONTROL_CHROME_LAZY_TOOLS=false`。
- 提示 `未找到配置文件 …/jev-browser.json` 或 `allowedOrigins` 相关错误：按 §3 创建/修正配置文件，然后在 Pi 里 `/reload`。
- `/chrome status` 未连接：Chrome 未加载对应 MV3 扩展、Bridge 未启动、选择了错误 Profile；先用 `/chrome status` 和 `/chrome profile <browserId>` 排查。
- `TYPESAFE_API_KEY` 缺失：配置该 provider 的凭据后重启 Pi（默认 provider `typesafe` 用 `TYPESAFE_API_KEY`）。
- 返回 `uncertain`：用更具体的目标、传 `inputs`，或在你确认风险可接受的测试站点降低 `minProbability`，不要无条件重复执行。
- `blocked`：浏览器页面控件找不到、页面内容需要额外主模型判断、必需按钮属于高风险类型或超出白名单；交还 Pi 原生浏览器工具或人工操作。
- 返回 `done_unverified` 不表示真的完成：Pi 应检查最终 URL、标题或网页证据。

## 上游参考 / 致谢

- **pi-control-chrome**（原生 Chrome/Edge Relay 工具；MIT）：https://github.com/lyd123qw2008/pi-control-chrome
- **pi-Jev-browser**（Jev 的 Driver/Policy 思路参考；Apache-2.0）：https://github.com/laihenyi/pi-Jev-browser
- **Pi Agent 扩展 API**（`pi.registerTool`、`ctx.executeTool`）：https://github.com/earendil-works/pi
- **TypeSafe / Jev**（System One 分类器，经 Pi 内置 `typesafe` classifier 提供方调用）

本扩展没有复制上述项目的代码，而是基于公开 API 实现了自己的有限动作决策循环。
