# Codex Space Switcher

`Codex Space Switcher` 现在不再把“切换账号”押宝在改 Codex Desktop 当前登录态上，而是改成了一个本地优先的薄网关控制台：

- 当前激活账号由本地代理承接 `/responses`
- 官方账号直接拉取实时额度窗口
- 官方账号与第三方 API 账号统一出现在一个看板里
- 所有代理请求都会记录 token 与费用事件，支持筛选统计

这版的核心目标很直接：让账号切换更稳，让用量统计能落到“具体账号”而不是只停留在 Plus / Team 空间级别。

## 现在能做什么

- 提供本地 `/ai-router/api/responses` 与 `/ai-router/api/models`
- 同时兼容 `/ai-router/api/v1/responses` 与 `/ai-router/api/v1/models`
- 支持当前官方登录态自动接入，并优先显示真实用户名 / 邮箱
- 支持额外配置多个官方账号快照
- 支持接入第三方 OpenAI-compatible API
- 展示官方账号状态看板：
  - 账号健康状态
  - 累计 token / 累计费用
  - 最近 5 小时剩余额度
  - 最近一周剩余额度
- 提供筛选统计：
  - 全部账号
  - 全部官方账号
  - 全部第三方账号
  - 单个官方账号 / 单个第三方账号
- 筛选后查看：
  - 输入 token
  - cache token
  - 输出 token
  - 预计费用（按官方公开费率估算）
- 保存最近代理事件，支持最近请求列表查看

## 架构思路

当前版本由三层组成：

1. 本地控制台页面
   展示账号状态、筛选统计和最近请求。
2. 本地薄网关
   只承担当前激活账号的 `/responses` 代理和模型列表暴露。
3. 本地审计事件
   把代理过程中捕获到的 token / cache / output / 费用落盘，再用于统计聚合。

这意味着账号切换只是切换“本地代理当前激活账号”，不再要求去改 Codex Desktop 自己的登录空间。

## 项目结构

```text
codex-space-switcher/
├── apps/
│   ├── backend/
│   │   └── src/
│   │       ├── gateway-account-store.ts
│   │       ├── gateway-dashboard-service.ts
│   │       ├── gateway-proxy-service.ts
│   │       ├── official-account-usage-provider.ts
│   │       ├── response-usage-capture.ts
│   │       ├── usage-dashboard-provider.ts
│   │       ├── usage-event-store.ts
│   │       └── server.ts
│   └── frontend/
│       ├── app.js
│       ├── index.html
│       ├── styles.css
│       └── lib/
│           ├── api.js
│           ├── formatters.js
│           └── render.js
├── packages/
│   └── shared/
│       └── src/
│           ├── contracts.ts
│           └── index.ts
└── README.md
```

## 本地启动

### 环境要求

- macOS
- Node.js `24+`
- 已安装 Codex Desktop

### 启动命令

```bash
cd /Users/cxl/cxl_projects/codex-space-switcher
npm run dev
```

启动后访问：

- `http://127.0.0.1:14318`

本地代理入口：

- `http://127.0.0.1:14318/ai-router/api/responses`
- `http://127.0.0.1:14318/ai-router/api/models`
- `http://127.0.0.1:14318/ai-router/api` 可直接在浏览器里查看网关根路径说明

## 账号配置

默认情况下，服务会自动把当前 `~/.codex/auth.json` 识别成一个官方账号，并优先显示 `auth.json` 中解析出的真实用户名、邮箱或账号 ID；只有这些信息都缺失时，才回退到内置 ID。

如果你要接入多个官方账号或第三方 API，可以提供：

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
      "apiKeyEnvName": "SPACE_SWITCHER_THIRD_PARTY_KEY",
      "defaultModel": "gpt-5.4-mini"
    }
  ]
}
```

### 多官方账号怎么准备

当前版本不接管网页登录流程，多官方账号依赖你自己保留不同账号的 `auth.json` 快照。

一个常见做法是：

1. 登录官方账号 A
2. 把 `~/.codex/auth.json` 复制成一个单独文件
3. 登录官方账号 B
4. 再复制一份新的 `auth.json`
5. 在 `accounts.json` 里分别指向两个绝对路径

这样控制台会把它们当成两个独立官方账号加载。

## Codex 接入本地代理

如果你希望 Codex 通过这个项目走本地代理，可以把 provider 指到本地服务，例如：

```toml
model_provider = "space_switcher"

[model_providers.space_switcher]
name = "space_switcher"
base_url = "http://127.0.0.1:14318/ai-router/api"
wire_api = "responses"
requires_openai_auth = true
```

现在网页里也有单独的 “Codex 代理接管” 区块：

- 打开开关时会直接改写 `~/.codex/config.toml`
- 会显示当前 `model_provider`
- 会显示当前 provider / 受管 provider 的 `base_url`
- 会显示最近 10 分钟是否真的检测到 Codex 流量经过本地代理

当前薄网关协议面只暴露：

- `POST /ai-router/api/responses`
- `GET /ai-router/api/models`

兼容入口：

- `POST /ai-router/api/v1/responses`
- `GET /ai-router/api/v1/models`

## 数据来源

### 官方账号状态

官方账号的 5 小时 / 一周额度，来自：

- `GET /backend-api/wham/usage`

### 筛选统计

筛选统计来自本地代理捕获的事件，而不是空间 rollout 扫描：

- 请求模型
- 输入 token
- cache token
- 输出 token
- 估算费用
- 请求时间

这些事件会落到：

- `CODEX_SPACE_SWITCHER_HOME/usage-events.jsonl`

## 默认状态目录

默认状态目录仍然写到：

- `./.codex-space-switcher-state/`

如果你想改到别处，可以设置：

```bash
export CODEX_SPACE_SWITCHER_HOME="$HOME/.codex-space-switcher"
```

## 测试

```bash
npm test
```

当前测试覆盖：

- 官方额度接口解析
- 本地 rollout 额度与 token 解析
- `/responses` usage 捕获
- 费用估算
- 筛选统计聚合
- 旧空间切换队列的基础保护逻辑

## 已知限制

- 当前版本已经把重点转到“本地代理切换账号”，不再把私有空间切换当作主路径
- 多官方账号仍需要你自己维护不同的 `auth.json` 快照
- 预计费用目前按官方公开费率估算，不等同于精确账单
- 第三方账号的实时额度状态没有统一标准，当前主要统计其代理用量，不尝试伪造统一额度接口
- `/responses` 目前保持薄网关原则，不做复杂补偿和多轮协议拼装
