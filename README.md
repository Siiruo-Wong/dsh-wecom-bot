# dsh-wecom-bot

> 企业微信智能机器人插件 · 为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 提供企微接入

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Siiruo-Wong/dsh-wecom-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Siiruo-Wong/dsh-wecom-bot/actions/workflows/ci.yml)

在企业微信里私聊机器人、或在群里 @ 它，就能驱动 **dsh agent**（思考 + 工具调用 + 文件/命令操作），
完成后把结果推回企业微信。

支持两种接收通道，可切换或同时启用：
- **长连接模式（默认）**：智能机器人 WebSocket 长连接（`wss://openws.work.weixin.qq.com`），无需公网地址，本机直连即可，回复走同一条连接（支持「思考中」流式占位）；
- **回调模式**：自建应用 HTTPS 回调（验签解密 + URL 验证），适合已有公网域名的场景。

## 特性

- **进程内插件**：复用 dsh 的 agent 核心与 JSONL 会话持久化，不额外开子进程，随 profile 一起加载/卸载；
- **界面配置**：安装后可在 dsh「设置 → 插件 → 插件配置」里可视化配置 botId/botSecret、从 dsh 已配置的模型中选择 provider/model、设置 AI 会话工作路径，保存即热生效（无需改 YAML）；
- **双通道**：`mode` 可选 `longconn`（长连接，默认）/ `callback`（回调）/ `both`，同一 agent 会话双通道互通；
- **多轮对话**：同一会话复用同一 agent（sessionId），上下文自然延续；
- **流式占位**（长连接）：任务开始时先回「思考中」占位，最终答案再刷新，用户不再干等；
- **先回 200 再异步**（回调）：满足企微回调 5 秒超时约束，长任务完成后主动推送；
- **安全默认**：签名常数时间比较、AES 严格校验、请求体/文本/队列长度上限、凭据不入日志、默认只绑定本机；
- **健壮**：每会话 FIFO 队列、单轮超时保护、agent 失效自愈重建、长连接心跳保活 + 指数退避重连、优雅停服。

## 架构

```
长连接模式(默认):  企业微信 --wss 长连接--> [SDK WSClient 认证/心跳/重连] --aibot_msg_callback--> 适配器 --enqueue--> [AgentBridge 队列/多轮]
                              <--aibot_respond_msg 流式回复--    [思考占位 + 最终答案] <--session/event 取最终答复--

回调模式:          企业微信 --HTTPS 回调--> [CallbackServer 验签解密] --handleMessage--> 同上 AgentBridge
                              <--应用消息 API 主动推送--  [touser/chatid 回复]
```

## 安装

### 前置条件

- dsh（DeepSeek Harness）Node.js ≥ 22.19；
- 长连接模式：一个企业微信**智能机器人**（后台拿到 botId / botSecret），无需公网；
- 回调模式：一个企业微信自建应用（CorpID / AgentId / Secret）+ 公网可达 HTTPS 地址（云服务器，或本机 + 内网穿透）。

### 安装到 dsh profile

在 dsh 安装目录执行（`web` 换成你的 profile 名）：

```bash
dsh plugin --profile web add dsh-wecom-bot
```

或从源码/本地目录：

```bash
dsh plugin --profile web add /path/to/dsh-wecom-bot
```

然后在 profile 的 `cordis.patch.yml` 里启用并配置：

```yaml
- id: wecom-bot
  name: dsh-wecom-bot
  config:
    mode: longconn                # longconn(默认) / callback / both
    botId: !!js process.env.WECOM_BOT_BOT_ID
    botSecret: !!js process.env.WECOM_BOT_BOT_SECRET
    workspace: !!js process.env.WECOM_BOT_WORKSPACE ?? process.cwd()
    taskPrefix: 你是在企业微信里为用户提供帮助的智能助手，请用中文简洁作答。
```

回调模式把 `mode` 换成 `callback`，并配置 `corpId` / `appSecret` / `agentId` / `token` / `aesKey`（见下方配置表）。

> 也可以只配置 `.env` 环境变量（`WECOM_BOT_*`，见 [.env.example](.env.example)），插件会自动读取。
>
> 说明：`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 由 dsh 宿主在运行时提供（cordis 的依赖
> 尚未完整发布到 npm），因此声明为**可选 peer 依赖**——`npm install` / `dsh plugin add` 都不会尝试
> 从 npm 拉取它们；若插件报找不到模块，说明宿主版本缺少这两个包。

## 界面配置（推荐）

插件安装并启用后，打开 dsh 的 **设置 → 插件 → 插件配置**，找到 **企业微信机器人** 卡片即可可视化配置：

| 字段 | 说明 |
|---|---|
| `botId` / `botSecret` | 智能机器人凭据（长连接模式必填），保存后立即重连 |
| `provider` / `model` | 从 dsh 已配置的模型列表中选择，作用于该机器人会话 |
| `workspace` | AI 会话工作目录（bash/文件系统工具活动根），相对路径按 dsh 工作区解析 |
| `maxTokens` | 单次请求输出 token 上限（0 = 跟随宿主默认） |
| `taskPrefix` | 拼在每条消息前的人设/安全约束 |

- 改动**保存即生效**（`applies: live`）：模型/工作目录/任务前缀等下一次会话即用新值；botId/botSecret 变更会立即重建长连接。
- 未改写的字段继承 `cordis.patch.yml` 里的装配配置（UI 层覆盖装配层，装配层覆盖默认值）。
- 界面配置仅覆盖 UI 暴露的字段；`mode`、心跳、超时等高级项仍走 `cordis.patch.yml` 或环境变量。
## 配置

| 配置键 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `mode` | `WECOM_BOT_MODE` | `longconn` | 接收通道：`longconn` / `callback` / `both` |
| `botId` | `WECOM_BOT_BOT_ID` | — | 智能机器人 ID（企业微信后台获取，longconn 必填） |
| `botSecret` | `WECOM_BOT_BOT_SECRET` | — | 智能机器人 Secret（企业微信后台获取，longconn 必填） |
| `scene` | `WECOM_BOT_SCENE` | — | 长连接认证场景值（可选） |
| `wsUrl` | `WECOM_BOT_WS_URL` | `wss://openws.work.weixin.qq.com` | 长连接地址（私有化部署需改） |
| `heartbeatIntervalMs` | `WECOM_BOT_HEARTBEAT_INTERVAL_MS` | `30000` | 长连接心跳间隔 |
| `reconnectBaseDelayMs` | `WECOM_BOT_RECONNECT_BASE_DELAY_MS` | `1000` | 重连基础延迟（指数退避 1s→30s） |
| `maxReconnectAttempts` | `WECOM_BOT_MAX_RECONNECT_ATTEMPTS` | `10` | 断连最大重连次数，`-1` 无限 |
| `maxAuthFailureAttempts` | `WECOM_BOT_MAX_AUTH_FAILURE_ATTEMPTS` | `5` | 认证失败最大重试，`-1` 无限 |
| `requestTimeoutMs` | `WECOM_BOT_REQUEST_TIMEOUT_MS` | `10000` | 长连接请求超时 |
| `thinkingHint` | `WECOM_BOT_THINKING_HINT` | `🤔 正在思考,请稍候…` | 思考占位文案（空串禁用） |
| `host` | `WECOM_BOT_HOST` | `127.0.0.1` | 回调监听地址；公网暴露必须走 HTTPS 反代/隧道（callback） |
| `port` | `WECOM_BOT_PORT` | `8787` | 回调监听端口 |
| `path` | `WECOM_BOT_PATH` | `/wecom/callback` | 回调路径 |
| `corpId` | `WECOM_BOT_CORP_ID` | — | 企业微信 CorpID（必填） |
| `appSecret` | `WECOM_BOT_APP_SECRET` | — | 自建应用 Secret（必填） |
| `agentId` | `WECOM_BOT_AGENT_ID` | — | 自建应用 AgentId（必填） |
| `token` | `WECOM_BOT_TOKEN` | — | 接收消息回调 Token（必填） |
| `aesKey` | `WECOM_BOT_AES_KEY` | — | 接收消息回调 EncodingAESKey，43 位（必填） |
| `provider` | `WECOM_BOT_PROVIDER` | 宿主默认 | dsh agent 的 provider |
| `model` | `WECOM_BOT_MODEL` | 宿主默认 | dsh agent 的 model |
| `maxTokens` | `WECOM_BOT_MAX_TOKENS` | 宿主默认 | 单次请求输出 token 上限 |
| `workspace` | `WECOM_BOT_WORKSPACE` | `process.cwd()` | agent 工作目录（bash/文件系统工具活动根） |
| `taskPrefix` | `WECOM_BOT_TASK_PREFIX` | 空 | 拼在每条消息前的人设/安全约束 |
| `replyLimitBytes` | `WECOM_BOT_REPLY_LIMIT_BYTES` | `2000` | 单条回复最大字节（UTF-8 安全截断） |
| `inputLimitChars` | `WECOM_BOT_INPUT_LIMIT_CHARS` | `4000` | 单条入站消息最大字符数 |
| `bodyLimitBytes` | `WECOM_BOT_BODY_LIMIT_BYTES` | `1048576` | 回调请求体最大字节 |
| `maxQueueDepth` | `WECOM_BOT_MAX_QUEUE_DEPTH` | `5` | 每会话排队上限，超出提示繁忙 |
| `promptTimeoutMs` | `WECOM_BOT_PROMPT_TIMEOUT_MS` | `600000` | 单轮 agent 任务超时 |
| `sessionIdPrefix` | `WECOM_BOT_SESSION_ID_PREFIX` | `wecom` | 会话 ID 前缀，避免与 Web UI 会话冲突 |
| `checkOnStart` | `WECOM_BOT_CHECK_ON_START` | `false` | 启动时做一次企微连通性自检 |
| `ignoreNonText` | `WECOM_BOT_IGNORE_NON_TEXT` | `true` | 非文本消息是否静默忽略 |
| `apiTimeoutMs` | `WECOM_BOT_API_TIMEOUT_MS` | `15000` | 企微 API 请求超时 |

## 企业微信后台配置（一次性）

### 长连接模式（默认，推荐）

1. 企业微信管理后台 → **智能机器人** → 创建/进入你的机器人；
2. 记录 **机器人 ID（botId）** 与 **机器人 Secret（botSecret）**，填入插件配置或 `WECOM_BOT_BOT_ID` / `WECOM_BOT_BOT_SECRET` 环境变量；
3. 无需配置回调 URL、无需公网域名、无需内网穿透——插件启动后自动建立 WebSocket 长连接。

### 回调模式

1. 管理后台 → 应用管理 → 自建 → 创建应用，记录 CorpID / AgentId / Secret；
2. 应用 → 接收消息 → 设置 API 接收：
   - URL：`https://你的域名/wecom/callback`；
   - Token：自定义随机串；EncodingAESKey：点「随机生成」；
   - 保存时触发 URL 验证（GET），插件已实现解密回显；
3. （可选）把应用拉进群聊，成员即可 @ 机器人。

## 开发

```bash
pnpm install
pnpm typecheck    # 类型检查
pnpm test         # 单元测试(vitest)
pnpm lint         # oxlint
pnpm build        # tsc 构建到 lib/
```

CI（GitHub Actions）会在 push/PR 时自动执行 typecheck + test + lint + build。

### 排障

- `npm install` 报 `Cannot find module @rollup/rollup-darwin-arm64`：npm 的 optional 依赖已知 bug（[npm/cli#4828](https://github.com/npm/cli/issues/4828)），
  仓库以 pnpm 为准，请用 `pnpm install`（node ≥ 22.13）；
- `npm warn EBADENGINE`：本插件运行在 dsh 宿主内，engines 与宿主一致要求 node `>=22.19.0`，
  本地开发用稍旧版本只会报警告，不影响 typecheck/test/build；
- `ERR_PNPM_IGNORED_BUILDS: esbuild`：pnpm 10+ 默认禁止依赖执行 build 脚本；已在 `pnpm-workspace.yaml` 的 `allowBuilds` 白名单放行，重新 `pnpm install` 即可。

## 安全

- 回调签名使用 `crypto.timingSafeEqual` 常数时间比较；
- AES 密钥长度、PKCS7 填充、消息长度均严格校验，越界即失败；
- 请求体、消息文本、队列深度均有默认上限，防止资源耗尽；
- 企微凭据与 access_token 绝不打入日志；错误信息不含密钥；
- 插件只把消息文本作为 prompt 交给 agent —— 消息内容**不会**影响工作目录/沙箱配置；
- 请把 `workspace` 指向受控目录，避免在 `danger-full-access` 沙箱下使用（除非完全清楚后果）。

完整约定见 [SECURITY.md](SECURITY.md)。

## 发布

```bash
pnpm test && pnpm lint && pnpm build
pnpm publish --access public   # 发布到 npm
```

发布前请确认 `package.json` 里 `repository` / `bugs` / `homepage` 指向你的仓库。

## 许可

[MIT](LICENSE)