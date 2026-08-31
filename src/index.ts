/**
 * dsh-wecom-bot — 企业微信智能机器人插件(DeepSeek Harness / dsh)。
 *
 * 双通道接收:
 * - longconn(默认):智能机器人长连接(WebSocket wss://openws.work.weixin.qq.com),
 *   无需公网地址,消息明文 JSON,回复走同一条连接(流式);
 * - callback:自建应用回调(独立端口 HTTP,GET 验签 / POST 收消息,先回 200 再异步),
 *   回复通过"应用消息"API 主动推送。
 *
 * 两条通道共享同一 AgentBridge:每会话 FIFO 队列、同一 sessionId 多轮记忆、
 * 单轮超时保护、agent 失效自愈重建。
 *
 * 安全:凭据不入日志、长度限制、队列深度限制、默认仅绑定 127.0.0.1。
 * 详见 README.md 与 SECURITY.md。
 */
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ConfigError, resolveConfig, type Config } from './config.js'
import { createSessionCounter, dshHome, splitSessionToken } from './session-key.js'
import { WECOM_SETTINGS_NAMESPACE, WecomSettingsSchema, type WecomSettings } from './settings.js'
import { decryptWecomMessage, verifySignature } from './crypto.js'
import { WecomApi } from './wecom-api.js'
import { CallbackServer } from './http-server.js'
import { AgentBridge } from './agent-bridge.js'
import { WecomLongConn } from './wecom-longconn.js'
import type { AgentsServiceLike, ParsedCallback, ReplySender, ReplyTarget, SettingsServiceLike, SettingsScopeLike } from './types.js'

export type { Config } from './config.js'
export { ConfigError } from './config.js'
export { WecomApiError } from './wecom-api.js'
export { truncateUtf8, lastAssistantText, buildUserMessage } from './agent-bridge.js'

type BridgeCtx = {
  agents: AgentsServiceLike
  on(event: string, handler: (...args: unknown[]) => void): () => void
  get<T>(key: string): T | undefined
}

export class WecomBot extends Service {
  static inject = ['agents']

  static Config: z<Config> = z.object({
    mode: z.union([z.const('callback'), z.const('longconn'), z.const('both')]).default('longconn'),
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).default('127.0.0.1'),
    port: z.natural().max(65535).default(8787),
    path: z.string().default('/wecom/callback'),
    corpId: z.string(),
    appSecret: z.string(),
    agentId: z.natural(),
    token: z.string(),
    aesKey: z.string(),
    botId: z.string(),
    botSecret: z.string(),
    scene: z.natural(),
    wsUrl: z.string(),
    heartbeatIntervalMs: z.natural().default(30_000),
    reconnectBaseDelayMs: z.natural().default(1_000),
    maxReconnectAttempts: z.natural().default(10),
    maxAuthFailureAttempts: z.natural().default(5),
    requestTimeoutMs: z.natural().default(10_000),
    thinkingHint: z.string().default('🤔 正在思考,请稍候…'),
    provider: z.string(),
    model: z.string(),
    maxTokens: z.natural(),
    workspace: z.string().default(process.cwd()),
    taskPrefix: z.string().default(''),
    replyLimitBytes: z.natural().default(2000),
    inputLimitChars: z.natural().default(4000),
    bodyLimitBytes: z.natural().default(1_048_576),
    maxQueueDepth: z.natural().default(5),
    promptTimeoutMs: z.natural().default(600_000),
    sessionIdPrefix: z.string().default('wecom'),
    checkOnStart: z.boolean().default(false),
    ignoreNonText: z.boolean().default(true),
    apiTimeoutMs: z.natural().default(15_000),
  })

  private cfg: Config
  private readonly bridge: AgentBridge
  private readonly wecom?: WecomApi
  private longconn?: WecomLongConn
  private readonly server?: CallbackServer
  private readonly nextSession: () => string
  private settingsScope?: SettingsScopeLike<WecomSettings>
  private settingsDispose?: () => void

  constructor(ctx: Context, raw: Partial<Config> = {}) {
    super(ctx, 'wecomBot')
    const cfg = resolveConfig(raw)
    this.cfg = cfg
    // 递增会话号分配器(持久化于 $DSH_HOME/wecom-bot/session-seq,重启不归零)
    this.nextSession = createSessionCounter(dshHome(), (error) =>
      ctx.logger.warn('[wecom-bot] 会话计数持久化失败', error),
    )
    const agents = (ctx as unknown as { agents?: AgentsServiceLike }).agents
    if (!agents) {
      throw new ConfigError('当前环境未提供 agent 服务(ctx.agents):请确认插件运行在具备 agent 核心的 dsh profile(web/desktop)中')
    }
    const bridgeCtx = ctx as unknown as BridgeCtx

    const needCallback = cfg.mode === 'callback' || cfg.mode === 'both'
    const needLongConn = cfg.mode === 'longconn' || cfg.mode === 'both'

    // 回复路由:长连接目标(reqId)走 WS,回调目标(touser/chatid)走企微 API
    const sender: ReplySender = {
      sendText: async (target: ReplyTarget, content: string): Promise<void> => {
        if (target.reqId && this.longconn) {
          await this.longconn.sendText(target, content)
          return
        }
        if (!target.reqId && this.wecom) {
          await this.wecom.sendText(target, content)
          return
        }
        ctx.logger.warn('[wecom-bot] 无可用回复通道,已丢弃回复', target)
      },
    }

    this.bridge = new AgentBridge(bridgeCtx, cfg, sender, ctx.logger)

    if (needCallback) {
      this.wecom = new WecomApi({
        corpId: cfg.corpId,
        appSecret: cfg.appSecret,
        agentId: cfg.agentId,
        timeoutMs: cfg.apiTimeoutMs,
      })
      this.server = new CallbackServer(
        { host: cfg.host, port: cfg.port, path: cfg.path, bodyLimitBytes: cfg.bodyLimitBytes },
        {
          decrypt: (encrypt, params) => this.decryptPayload(encrypt, params),
          handleMessage: (message) => this.onMessage(message),
          logger: ctx.logger,
        },
      )
    }

    if (needLongConn) {
      this.longconn = new WecomLongConn(cfg, {
        bridge: this.bridge,
        logger: ctx.logger,
        nextSession: this.nextSession,
      })
    }

    // 用户设置命名空间:base = 装配配置,用户层 = UI 写入;变更时热更新。
    // settings 服务在无设置提供方的 profile 中不存在,inject 不触发即静默降级。
    ctx.inject(['settings'], (settingsCtx) => {
      this.attachSettings(settingsCtx as { settings: SettingsServiceLike })
    })
  }

  async [Service.init](): Promise<void> {
    if (this.server && this.wecom) {
      const port = await this.server.start()
      this.ctx.logger.info('[wecom-bot] 企微回调已监听 http://' + this.cfg.host + ':' + port + this.cfg.path)
      if (this.cfg.checkOnStart) {
        try {
          await this.wecom.check()
          this.ctx.logger.info('[wecom-bot] 企微连通性自检通过(access_token 获取成功)')
        } catch (error) {
          this.ctx.logger.error(
            '[wecom-bot] 企微连通性自检失败,请检查 corpid/appSecret',
            error instanceof Error ? error.message : error,
          )
        }
      }
    }
    if (this.longconn) {
      this.longconn.start()
      this.ctx.logger.info('[wecom-bot] 长连接模式已启动(botId=' + this.cfg.botId + ')')
    }
    this.ctx.effect(() => async () => {
      if (this.server) await this.server.stop()
      if (this.longconn) await this.longconn.dispose()
      await this.bridge.dispose()
    }, 'wecom-bot.lifecycle')
  }

  /**
   * 注册 wecom-bot 设置命名空间并应用初始值,随后监听变更热更新。
   * @param ctx - 注入了 settings 服务的上下文。
   */
  private attachSettings(settingsCtx: { settings: SettingsServiceLike }): void {
    try {
      const scope = settingsCtx.settings.register<WecomSettings>(
        WECOM_SETTINGS_NAMESPACE,
        WecomSettingsSchema,
        {
          // 装配配置作为 base:UI 未改写时继承现有值;applies=live 表示保存即生效。
          base: {
            botId: this.cfg.botId,
            botSecret: this.cfg.botSecret,
            provider: this.cfg.provider,
            model: this.cfg.model,
            workspace: this.cfg.workspace,
            maxTokens: this.cfg.maxTokens,
            taskPrefix: this.cfg.taskPrefix,
          },
          applies: 'live',
        },
      )
      this.settingsScope = scope
      this.applySettings(scope.get())
      this.settingsDispose = scope.watch((next) => { this.applySettings(next) })
    } catch (error) {
      this.ctx.logger.warn('[wecom-bot] 设置命名空间注册失败,回退到装配配置', error)
    }
  }

  /**
   * 把设置命名空间的解析值合并进运行配置,并按需热更新组件。
   * 空字符串表示"未配置/继承默认",不覆盖现有值。
   */
  private applySettings(s: WecomSettings): void {
    const old = this.cfg
    const next: Config = { ...old }
    const applyString = (key: 'botId' | 'botSecret' | 'provider' | 'model' | 'workspace' | 'taskPrefix', value: string): void => {
      if (value === '') return
      next[key] = value
    }
    applyString('botId', s.botId)
    applyString('botSecret', s.botSecret)
    applyString('provider', s.provider)
    applyString('model', s.model)
    applyString('taskPrefix', s.taskPrefix)
    if (s.workspace !== '') {
      next.workspace = s.workspace.startsWith('/') ? s.workspace : resolve(s.workspace)
    }
    if (s.maxTokens > 0) next.maxTokens = s.maxTokens

    const connectionChanged = next.botId !== old.botId || next.botSecret !== old.botSecret
    this.cfg = next
    // taskPrefix 等由长连接层在每条消息时读取:换引用同步,否则热更新
    // 永远停留在构造时的旧 cfg(此前只有改 botId/botSecret 才会重建连接)。
    if (this.longconn) this.longconn.updateCfg(next)
    this.bridge.update({
      workspace: next.workspace,
      provider: next.provider,
      model: next.model,
      maxTokens: next.maxTokens,
    })

    // 凭据变化:重建长连接(幂等:未启动的连接 dispose 是安全的)
    if (connectionChanged && this.longconn) {
      const logger = this.ctx.logger
      const oldConn = this.longconn
      this.longconn = new WecomLongConn(next, {
        bridge: this.bridge,
        logger,
        nextSession: this.nextSession,
      })
      void oldConn.dispose().then(() => {
        logger.info('[wecom-bot] 已按新 botId/botSecret 重建长连接')
      })
    }
  }

  private decryptPayload(encrypt: string, params: URLSearchParams): string {
    const signature = params.get('msg_signature') ?? ''
    const timestamp = params.get('timestamp') ?? ''
    const nonce = params.get('nonce') ?? ''
    if (!verifySignature({ token: this.cfg.token, timestamp, nonce, encrypt, signature })) {
      throw new Error('签名校验失败')
    }
    return decryptWecomMessage(encrypt, this.cfg.aesKey)
  }

  private onMessage(message: ParsedCallback): void {
    if (message.msgType !== 'text' || !message.content) {
      if (!this.cfg.ignoreNonText && message.fromUser && this.wecom) {
        void this.wecom.sendText(
          message.chatId ? { chatid: message.chatId } : { touser: message.fromUser },
          '目前仅支持文本消息。',
        ).catch((error: unknown) => this.ctx.logger.warn('[wecom-bot] 提示发送失败', error))
      }
      return
    }
    // 显式会话标识:带 #s-<数字> 续接原会话;不带则分配新会话(递增号,独立上下文)
    const { token, rest } = splitSessionToken(message.content)
    const content = rest.slice(0, this.cfg.inputLimitChars)
    const task = [this.cfg.taskPrefix, content].filter(Boolean).join('\n')
    const key = token ?? this.nextSession()
    const target: ReplyTarget = message.chatId ? { chatid: message.chatId } : { touser: message.fromUser }
    this.bridge.enqueue(key, task, target)
  }
}

export default WecomBot
