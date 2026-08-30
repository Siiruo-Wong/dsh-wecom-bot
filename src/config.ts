/**
 * 插件配置:类型定义、环境变量合并、fail-fast 校验。
 *
 * 配置优先级:plugin config(如 cordis.patch.yml) > 环境变量 WECOM_BOT_* > 默认值。
 * 凭据(corpSecret / EncodingAESKey / botSecret)绝不写入日志。
 *
 * 双通道:
 * - callback:自建应用回调(HTTP,验签解密,需公网可达地址);
 * - longconn:智能机器人长连接(WebSocket wss://openws.work.weixin.qq.com,无需公网)。
 */
import { isAbsolute, resolve } from 'node:path'

export type WecomMode = 'callback' | 'longconn' | 'both'

export interface Config {
  /** 接收通道:callback 回调 / longconn 长连接 / both 双通道 */
  mode: WecomMode
  /** 回调监听地址:默认仅本机,公网暴露需 HTTPS 反向代理/隧道(callback 模式) */
  host: '127.0.0.1' | '0.0.0.0'
  /** 回调监听端口(callback 模式) */
  port: number
  /** 回调路径,必须以 / 开头(callback 模式) */
  path: string
  /** 企业微信 CorpID(callback 模式必填) */
  corpId: string
  /** 自建应用 Secret(callback 模式必填) */
  appSecret: string
  /** 自建应用 AgentId(callback 模式必填) */
  agentId: number
  /** 接收消息回调 Token(callback 模式必填) */
  token: string
  /** 接收消息回调 EncodingAESKey,43 位(callback 模式必填) */
  aesKey: string
  /** 智能机器人 ID(longconn 模式必填,企业微信后台获取) */
  botId: string
  /** 智能机器人 Secret(longconn 模式必填,企业微信后台获取) */
  botSecret: string
  /** 长连接认证场景值(可选,SDK 透传) */
  scene?: number
  /** 长连接 WebSocket 地址(私有化部署需改) */
  wsUrl: string
  /** 长连接心跳间隔(毫秒) */
  heartbeatIntervalMs: number
  /** 长连接重连基础延迟(毫秒,指数退避 1s→2s→4s→…→30s) */
  reconnectBaseDelayMs: number
  /** 长连接断连最大重连次数,-1 表示无限 */
  maxReconnectAttempts: number
  /** 长连接认证失败最大重试次数,-1 表示无限 */
  maxAuthFailureAttempts: number
  /** 长连接请求超时(毫秒) */
  requestTimeoutMs: number
  /** 长连接思考占位文案(先回 finish:false 的占位,空字符串则禁用) */
  thinkingHint: string
  /** dsh agent 的 provider;缺省时由宿主默认模型选择决定 */
  provider?: string
  /** dsh agent 的 model;缺省时由宿主默认模型选择决定 */
  model?: string
  /** 单次模型请求输出 token 上限(可选) */
  maxTokens?: number
  /** agent 的工作目录(bash / 文件系统工具的活动根) */
  workspace: string
  /** 拼在每条消息前的系统提示/人设(可注入安全约束) */
  taskPrefix: string
  /** 单条回复最大字节数(UTF-8),超长按字符边界截断 */
  replyLimitBytes: number
  /** 单条入站消息最大字符数 */
  inputLimitChars: number
  /** 回调请求体最大字节数(callback 模式) */
  bodyLimitBytes: number
  /** 每个会话允许排队等待的最大消息数,超出直接提示繁忙 */
  maxQueueDepth: number
  /** 单轮 agent 任务超时(毫秒),超时回复并重置该会话 */
  promptTimeoutMs: number
  /** 会话 ID 前缀,避免与 Web UI 等其它会话冲突 */
  sessionIdPrefix: string
  /** 启动时是否做一次企微连通性自检(callback 模式) */
  checkOnStart: boolean
  /** 非文本消息是否静默忽略(否则回复提示) */
  ignoreNonText: boolean
  /** 企微 API 请求超时(毫秒,callback 模式) */
  apiTimeoutMs: number
}

const HOSTS = ['127.0.0.1', '0.0.0.0'] as const
const MODES: readonly WecomMode[] = ['callback', 'longconn', 'both']

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function num(raw: number | undefined, env: string | undefined, fallback: number): number {
  if (raw !== undefined) return raw
  if (env !== undefined && env !== '') {
    const n = Number(env)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function str(raw: string | undefined, env: string | undefined, fallback: string): string {
  return raw ?? (env && env !== '' ? env : fallback)
}

function bool(raw: boolean | undefined, env: string | undefined, fallback: boolean): boolean {
  if (raw !== undefined) return raw
  if (env !== undefined && env !== '') return env === 'true' || env === '1'
  return fallback
}

/** 合并 plugin config 与环境变量并校验;校验失败抛 ConfigError(启动即失败,不留半成品状态) */
export function resolveConfig(raw: Partial<Config> = {}): Config {
  const env = process.env
  const cfg: Config = {
    mode: str(raw.mode, env.WECOM_BOT_MODE, 'longconn') as WecomMode,
    host: str(raw.host, env.WECOM_BOT_HOST, '127.0.0.1') as '127.0.0.1' | '0.0.0.0',
    port: num(raw.port, env.WECOM_BOT_PORT, 8787),
    path: str(raw.path, env.WECOM_BOT_PATH, '/wecom/callback'),
    corpId: str(raw.corpId, env.WECOM_BOT_CORP_ID, ''),
    appSecret: str(raw.appSecret, env.WECOM_BOT_APP_SECRET, ''),
    agentId: num(raw.agentId, env.WECOM_BOT_AGENT_ID, 0),
    token: str(raw.token, env.WECOM_BOT_TOKEN, ''),
    aesKey: str(raw.aesKey, env.WECOM_BOT_AES_KEY, ''),
    botId: str(raw.botId, env.WECOM_BOT_BOT_ID, ''),
    botSecret: str(raw.botSecret, env.WECOM_BOT_BOT_SECRET, ''),
    scene: num(raw.scene, env.WECOM_BOT_SCENE, 0) || undefined,
    wsUrl: str(raw.wsUrl, env.WECOM_BOT_WS_URL, 'wss://openws.work.weixin.qq.com'),
    heartbeatIntervalMs: num(raw.heartbeatIntervalMs, env.WECOM_BOT_HEARTBEAT_INTERVAL_MS, 30_000),
    reconnectBaseDelayMs: num(raw.reconnectBaseDelayMs, env.WECOM_BOT_RECONNECT_BASE_DELAY_MS, 1_000),
    maxReconnectAttempts: num(raw.maxReconnectAttempts, env.WECOM_BOT_MAX_RECONNECT_ATTEMPTS, 10),
    maxAuthFailureAttempts: num(raw.maxAuthFailureAttempts, env.WECOM_BOT_MAX_AUTH_FAILURE_ATTEMPTS, 5),
    requestTimeoutMs: num(raw.requestTimeoutMs, env.WECOM_BOT_REQUEST_TIMEOUT_MS, 10_000),
    thinkingHint: str(raw.thinkingHint, env.WECOM_BOT_THINKING_HINT, '🤔 正在思考,请稍候…'),
    provider: raw.provider ?? (env.WECOM_BOT_PROVIDER || undefined),
    model: raw.model ?? (env.WECOM_BOT_MODEL || undefined),
    maxTokens: num(raw.maxTokens, env.WECOM_BOT_MAX_TOKENS, 0) || undefined,
    workspace: resolve(str(raw.workspace, env.WECOM_BOT_WORKSPACE, process.cwd())),
    taskPrefix: str(raw.taskPrefix, env.WECOM_BOT_TASK_PREFIX, ''),
    replyLimitBytes: num(raw.replyLimitBytes, env.WECOM_BOT_REPLY_LIMIT_BYTES, 2000),
    inputLimitChars: num(raw.inputLimitChars, env.WECOM_BOT_INPUT_LIMIT_CHARS, 4000),
    bodyLimitBytes: num(raw.bodyLimitBytes, env.WECOM_BOT_BODY_LIMIT_BYTES, 1_048_576),
    maxQueueDepth: num(raw.maxQueueDepth, env.WECOM_BOT_MAX_QUEUE_DEPTH, 5),
    promptTimeoutMs: num(raw.promptTimeoutMs, env.WECOM_BOT_PROMPT_TIMEOUT_MS, 600_000),
    sessionIdPrefix: str(raw.sessionIdPrefix, env.WECOM_BOT_SESSION_ID_PREFIX, 'wecom'),
    checkOnStart: bool(raw.checkOnStart, env.WECOM_BOT_CHECK_ON_START, false),
    ignoreNonText: bool(raw.ignoreNonText, env.WECOM_BOT_IGNORE_NON_TEXT, true),
    apiTimeoutMs: num(raw.apiTimeoutMs, env.WECOM_BOT_API_TIMEOUT_MS, 15_000),
  }

  // 通用校验
  if (!MODES.includes(cfg.mode)) {
    throw new ConfigError(`mode 必须是 callback / longconn / both,收到 "${cfg.mode}"`)
  }
  if (!HOSTS.includes(cfg.host)) throw new ConfigError(`host 必须是 127.0.0.1 或 0.0.0.0,收到 "${cfg.host}"`)
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new ConfigError(`port 非法: ${cfg.port}`)
  if (!cfg.path.startsWith('/') || cfg.path.includes('?')) throw new ConfigError(`path 必须以 / 开头且不含查询串: "${cfg.path}"`)
  if (!isAbsolute(cfg.workspace)) throw new ConfigError(`workspace 必须是绝对路径: ${cfg.workspace}`)
  if (cfg.maxTokens !== undefined && (!Number.isInteger(cfg.maxTokens) || cfg.maxTokens <= 0)) {
    throw new ConfigError(`maxTokens 必须是正整数: ${cfg.maxTokens}`)
  }
  for (const [name, value] of Object.entries({
    replyLimitBytes: cfg.replyLimitBytes,
    inputLimitChars: cfg.inputLimitChars,
    bodyLimitBytes: cfg.bodyLimitBytes,
    maxQueueDepth: cfg.maxQueueDepth,
    promptTimeoutMs: cfg.promptTimeoutMs,
    apiTimeoutMs: cfg.apiTimeoutMs,
  })) {
    if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} 必须是正整数: ${value}`)
  }

  // 模式相关校验
  const needCallback = cfg.mode === 'callback' || cfg.mode === 'both'
  const needLongConn = cfg.mode === 'longconn' || cfg.mode === 'both'
  if (needCallback) {
    if (!cfg.corpId) throw new ConfigError('callback 模式缺少 corpId(企业微信 CorpID)')
    if (!cfg.appSecret) throw new ConfigError('callback 模式缺少 appSecret(自建应用 Secret)')
    if (!Number.isInteger(cfg.agentId) || cfg.agentId <= 0) throw new ConfigError(`callback 模式 agentId 必须是正整数: ${cfg.agentId}`)
    if (!cfg.token) throw new ConfigError('callback 模式缺少 token(接收消息回调 Token)')
    validateAesKey(cfg.aesKey)
  }
  if (needLongConn) {
    if (!cfg.botId) throw new ConfigError('longconn 模式缺少 botId(智能机器人 ID,企业微信后台获取)')
    if (!cfg.botSecret) throw new ConfigError('longconn 模式缺少 botSecret(智能机器人 Secret,企业微信后台获取)')
    if (!/^wss?:\/\//.test(cfg.wsUrl)) throw new ConfigError(`wsUrl 必须是 ws:// 或 wss:// 开头: "${cfg.wsUrl}"`)
    for (const [name, value] of Object.entries({
      heartbeatIntervalMs: cfg.heartbeatIntervalMs,
      reconnectBaseDelayMs: cfg.reconnectBaseDelayMs,
      requestTimeoutMs: cfg.requestTimeoutMs,
    })) {
      if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} 必须是正整数: ${value}`)
    }
    for (const [name, value] of Object.entries({
      maxReconnectAttempts: cfg.maxReconnectAttempts,
      maxAuthFailureAttempts: cfg.maxAuthFailureAttempts,
    })) {
      if (!Number.isInteger(value) || (value !== -1 && value <= 0)) {
        throw new ConfigError(`${name} 必须是正整数或 -1(无限): ${value}`)
      }
    }
  }

  return cfg
}

/** EncodingAESKey 必须是 43 位,追加 '=' 后 Base64 解码为 32 字节(AES-256 密钥) */
export function validateAesKey(aesKey: string): void {
  if (aesKey.length !== 43) throw new ConfigError(`aesKey 必须为 43 位,实际 ${aesKey.length} 位`)
  const key = Buffer.from(aesKey + '=', 'base64')
  if (key.length !== 32) throw new ConfigError('aesKey Base64 解码后必须为 32 字节')
}
