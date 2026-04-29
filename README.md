# Codex Space Switcher

一个同时面向 Codex App 与 Codex CLI 的本地账号路由与用量审计控制台。

`Codex Space Switcher` 不是去劫持或反复切换 Codex 当前登录态，而是在本机前面放一个薄网关，把“请求由哪个账号承接”“最近是谁在消耗额度”“当前 Codex App / CLI 是否真的走了本地代理”这些问题收敛到一个明确、可观测的控制面里。

![Codex Space Switcher](docs/screenshots/hero.png)

## 项目定位

在重度使用 Codex App 或 Codex CLI 时，真正容易失控的通常不是请求能不能发出去，而是下面这些边界问题：

- 一旦手里有多个账号，切换过程就会变得繁琐而低效
- 多个账号的状态分散在不同登录态或不同配置里，缺少统一视图
- 很难直接看清楚每个账号到底用了多少 token、最近大概花了多少钱
- 账号切换依赖当前客户端状态，切换路径脆弱，排查成本高

这个项目的目标很直接：

**用一个本地优先、以 Codex `/responses` 代理为核心的薄网关，把多账号切换、账号状态查看、token 统计和费用估算统一到一个控制台里。**

## 核心特性

### 本地路由优先，而不是桌面登录态优先

项目当前主路径不是“切换 Codex Desktop 当前账号”，而是“切换本地网关当前激活账号”。

这意味着：

- Codex 请求先进入本地代理
- 本地代理决定当前由哪个账号承接
- 账号切换变成显式的本地路由切换，而不是隐式的桌面端状态切换

这样做的价值在于，切换行为更稳定，故障边界更清晰，也更容易定位到底是代理问题、账号问题，还是桌面端配置问题。

### 同时支持 Codex App 与 Codex CLI

这个项目并不把自己绑定在单一客户端上。

只要流量走的是 Codex 的 provider 配置，它就可以同时承接：

- Codex App
- Codex CLI

代理层会统一记录客户端来源，并把最近一次请求写入状态面板，方便确认当前到底是谁在走本地网关。

### 官方账号与第三方账号统一管理

项目不是只做官方账号切换，也不是单纯做第三方 API 聚合。

它把两类账号统一抽象成“可被本地网关激活的运行目标”，并在同一个控制台里展示：

- 当前激活状态
- 账号健康状态
- 额度与窗口状态
- 最近请求情况
- 累计 token
- 累计费用
- 官方账号额度窗口

### 用量统计落到账号维度

所有经过本地代理的请求，都会转成可聚合的本地 usage 事件。

控制台当前支持查看：

- 输入 token
- cache token
- 输出 token
- 估算费用
- 最近请求列表
- 全部 / 官方 / 第三方 / 单账号筛选

这让你看到的不再只是“还能不能用”，而是“具体哪个账号用了多少、最近大概花了多少钱”。

### 薄网关设计，不做重型平台

这个项目有意保持协议面收敛，不把自己做成一个复杂的中台或通用网关。

当前重点集中在：

- HTTP SSE `/responses`
- 兼容 WebSocket upgrade 的第三方 Responses 透传
- Chat Completions 第三方上游的 Responses SSE 适配
- `/models`
- 账号路由
- 本地 usage 审计

这不是能力不足，而是设计选择。边界清晰，反而更适合本地部署和长期维护。

### 以 Responses 代理为核心路径

当前项目的主路径围绕 Codex 的 `/responses` provider 入口做代理和 usage 捕获。

这样做有两个直接意义：

- 更贴近 Codex 当前的实时交互模式
- 对官方 Responses、第三方 Responses 和第三方 Chat Completions 上游都能保持同一个本地入口

当第三方账号本身支持 Responses WebSocket 时，项目仍可按账号开启 `supports_websockets`；当账号只支持 Chat Completions（例如 MiMo Token Plan）时，本地代理会强制走 HTTP SSE，并在代理层完成 Responses 与 Chat Completions 的互转。

## 功能概览

- 本地控制台：
  - 查看账号状态
  - 查看代理状态
  - 查看最近请求
  - 查看 token 与费用统计
- 客户端支持：
  - Codex App
  - Codex CLI
- 本地代理：
  - `POST /ai-router/api/responses` HTTP SSE
  - `GET /ai-router/api/responses` WebSocket upgrade（仅适用于 Responses 上游）
  - `GET /ai-router/api/models`
  - 兼容 `/ai-router/api/v1/*`
- 官方账号支持：
  - 自动识别当前 `~/.codex/auth.json`
  - 支持维护多个官方账号快照
  - 支持直接粘贴 `https://chatgpt.com/api/auth/session` 返回结果创建账号
- 第三方账号支持：
  - 接入 OpenAI-compatible API
  - 支持 `apiProtocol = "responses"` 透明转发
  - 支持 `apiProtocol = "chat_completions"` 的 Responses SSE 适配
  - 创建时可选 `/models` 可用性校验
- Codex 接管能力：
  - 可直接管理 `~/.codex/config.toml`
  - 展示当前 provider 与受管 provider 配置
  - 检测最近 Codex 流量是否真实经过本地代理
- 本地用量审计：
  - token 统计
  - cache token 统计
  - output token 统计
  - 费用估算
  - 最近请求历史

## 截图

### 账号与代理状态面板

![账号与代理状态面板](docs/screenshots/spaces.png)

### Token 与费用统计面板

![Token 与费用统计面板](docs/screenshots/token-usage.png)

## 工作方式

```text
Codex App / Codex CLI
    |
    v
本地薄网关
    |
    +--> 当前激活的官方账号
    |
    +--> 当前激活的第三方账号
    |
    +--> 本地 usage 事件存储
             |
             v
          控制台聚合展示
```

当前实现可以理解为三层：

1. 控制台前端：负责状态展示、账号管理和操作入口
2. 本地薄网关：负责以 `/responses` 为核心的代理、协议适配、`/models` 暴露与账号路由
3. 本地状态与审计存储：负责账号定义、代理状态、Codex 接管状态和 usage 事件持久化

## 快速开始

### 环境要求

- macOS 或 Windows
- Node.js `24+`
- 已安装 Codex App 或 Codex CLI

### 启动

```bash
npm install
npm run dev
```

默认地址：

- 控制台：`http://127.0.0.1:14318`
- 代理入口：`http://127.0.0.1:14318/ai-router/api/responses`
- 模型列表：`http://127.0.0.1:14318/ai-router/api/models`

## 接入 Codex App / CLI

如果你希望 Codex App 或 Codex CLI 通过本地代理发请求，可以把 provider 指向本地服务：

```toml
model_provider = "space_switcher"

[model_providers.space_switcher]
name = "space_switcher"
base_url = "http://127.0.0.1:14318/ai-router/api"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

`supports_websockets` 会由控制台按当前激活账号自动同步：官方账号和 Chat Completions 适配账号会写成 `false`，只有明确需要 WebSocket Responses 的第三方账号才写成 `true`。

控制台里也提供了接管入口，可以直接改写 `~/.codex/config.toml`，并展示：

- 当前 `model_provider`
- 当前 provider 的 `base_url`
- 受管 provider 的 `base_url`
- 当前 `supports_websockets` 是否与路由账号一致
- 最近 10 分钟是否检测到 Codex 流量经过本地代理

macOS 与 Windows 都支持在控制台里触发 Codex 自动重启。Windows 下如果 Codex 不在常见安装目录或 PATH 中，可以设置：

```powershell
$env:CODEX_SPACE_SWITCHER_CODEX_EXE="C:\Path\To\Codex.exe"
```

高级场景也可以用 `CODEX_SPACE_SWITCHER_RESTART_COMMAND` 覆盖完整启动命令。

## 账号配置

默认情况下，服务会自动把当前 `~/.codex/auth.json` 识别成一个官方账号。

如果你要接入多个官方账号或第三方账号，可以通过以下两种方式配置：

- 控制台里的新增账号表单
- `CODEX_SPACE_SWITCHER_HOME/accounts.json`

示例：

```json
{
  "includeCurrentCodexSession": true,
  "accounts": [
    {
      "id": "official-b",
      "name": "官方账号 B",
      "kind": "official",
      "authFile": "/Users/you/.codex-space-switcher/auth/official-b.json"
    },
    {
      "id": "third-party-main",
      "name": "第三方账号",
      "kind": "third_party",
      "apiBaseUrl": "https://api.openai.com/v1",
      "apiProtocol": "responses",
      "apiKeyEnvName": "SPACE_SWITCHER_THIRD_PARTY_KEY",
      "defaultModel": "gpt-5.4-mini",
      "billingRule": {
        "pricing": {
          "inputPerMillionUsd": 1,
          "cachedInputPerMillionUsd": 0.1,
          "outputPerMillionUsd": 2
        },
        "quota": {
          "totalBudgetUsd": 200
        }
      }
    },
    {
      "id": "mimo-token-plan-cn",
      "name": "MiMo Token Plan CN",
      "kind": "third_party",
      "apiBaseUrl": "https://token-plan-cn.xiaomimimo.com/v1",
      "apiProtocol": "chat_completions",
      "apiKeyEnvName": "MIMO_TOKEN_PLAN_KEY",
      "defaultModel": "mimo-v2.5-pro",
      "requiresResponsesWebSocket": false,
      "billingRule": {
        "quota": {
          "tokenQuota": {
            "limitTokens": 200000000,
            "windowKind": "monthly"
          }
        }
      }
    }
  ]
}
```

第三方账号的 `billingRule.quota` 支持多种本地扣减口径：`shortWindowBudgetUsd`（5 小时或每天）、`weeklyBudgetUsd`、`totalBudgetUsd`（累计金额，不重置），以及 `tokenQuota`（当前支持自然月 token 总额）。

### MiMo Token Plan 接入

MiMo Token Plan 的 OpenAI 兼容入口当前是 Chat Completions 协议，不直接兼容新版 Codex 的 Responses API。你不需要降级 Codex，也不需要把 Codex 配成 `wire_api = "chat"`；本项目会让 Codex 继续连接本地 `wire_api = "responses"` provider，再由代理层转换到 MiMo `/chat/completions`。

控制台新增第三方账号时可直接选择 “MiMo Token Plan · CN / SGP / AMS” 预设：

- API Key 使用订阅页提供的 `tp-xxxxx`
- 默认模型为 `mimo-v2.5-pro`
- OpenAI 兼容地址可选：
  - `https://token-plan-cn.xiaomimimo.com/v1`
  - `https://token-plan-sgp.xiaomimimo.com/v1`
  - `https://token-plan-ams.xiaomimimo.com/v1`
- 账号协议会保存为 `"chat_completions"`
- Codex 接管配置会保持 `wire_api = "responses"` 且 `supports_websockets = false`

如果你手写 `accounts.json`，关键字段如下：

```json
{
  "id": "mimo-token-plan-cn",
  "name": "MiMo Token Plan CN",
  "kind": "third_party",
  "apiBaseUrl": "https://token-plan-cn.xiaomimimo.com/v1",
  "apiProtocol": "chat_completions",
  "apiKey": "tp-xxxxx",
  "defaultModel": "mimo-v2.5-pro"
}
```

### 多官方账号接入方式

常见做法有两种：

1. 保存多个 `auth.json` 快照，并在 `accounts.json` 中分别引用
2. 直接把 `https://chatgpt.com/api/auth/session` 的返回结果粘贴到控制台

当前项目只会从粘贴结果中提取本地代理所需字段：

- `accessToken`
- `account.id`
- `user.name`
- `user.email`
- `expires`

这足够支撑路由转发和额度查询；但由于没有 `refresh_token`，会话过期后需要重新粘贴。

## 状态目录

默认状态目录：

- `./.codex-space-switcher-state/`

也可以通过环境变量改写：

```bash
export CODEX_SPACE_SWITCHER_HOME="$HOME/.codex-space-switcher"
```

Windows PowerShell：

```powershell
$env:CODEX_SPACE_SWITCHER_HOME="$env:USERPROFILE\.codex-space-switcher"
```

关键文件包括：

- `accounts.json`
- `auth/*.json`
- `gateway-state.json`
- `usage-events.jsonl`

## 项目结构

```text
codex-space-switcher/
├── apps/
│   ├── backend/
│   │   └── src/
│   ├── frontend/
├── packages/
│   └── shared/
└── docs/
    └── screenshots/
```

## 测试

```bash
npm test
```

当前测试重点覆盖：

- 官方额度接口解析
- `/responses` usage 捕获
- Responses 与 Chat Completions 协议转换
- Chat Completions fake 上游集成
- WebSocket usage 捕获
- Codex provider 的 `supports_websockets` 配置联动
- 费用估算
- 第三方账号自定义金额 / token 额度
- 第三方账号校验
- 统计聚合与账号更新流程

## 已知限制

- 当前主路径是“本地代理切换账号”，不是直接控制官方私有空间切换
- 多官方账号仍依赖登录态快照或手动粘贴会话
- 费用为基于模型定价规则的估算值，不等同于官方精确账单
- 第三方账号没有统一余额接口，控制台只会按你配置的本地金额 / token 规则从审计事件中推导剩余量
- Chat Completions 适配优先覆盖文本、函数工具、`local_shell` 和 `apply_patch`；MCP namespace、web_search、image_generation 等能力尚未完整适配
- 网关刻意保持轻量，不做复杂补偿、多轮编排或通用平台代理层
