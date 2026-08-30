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
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ConfigError, resolveConfig, type Config } from './config.js'
import { decryptWecomMessage, verifySignature } from './crypto.js'
import { WecomApi } from './wecom-api.js'
import { CallbackServer } from './http-server.js'
import { AgentBridge } from './agent-bridge.js'
import { WecomLongConn } from './wecom-longconn.js'
import type { AgentsServiceLike, ParsedCallback, ReplySender, ReplyTarget } from './types.js'

export type { Config } from './config.js'
export { ConfigError } from './config.js'
export { WecomApiError } from './wecom-api.js'
export { truncateUtf8, lastAssistantText, buildUserMessage } from './agent-bridge.js'

type BridgeCtx = {
  agents: AgentsServiceLike
  on(event: string, handler: (...args: unknown[]) => void): () => void
}

export class WecomBot extends Service {
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

  private readonly cfg: Config
  private readonly bridge: AgentBridge
  private readonly wecom?: WecomApi
  private readonly longconn?: WecomLongConn
  private readonly server?: CallbackServer

  constructor(ctx: Context, raw: Partial<Config> = {}) {
    super(ctx, 'wecomBot')
    const cfg = resolveConfig(raw)
    this.cfg = cfg
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
      this.longconn = new WecomLongConn(cfg, { bridge: this.bridge, logger: ctx.logger })
    }
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
    const content = message.content.slice(0, this.cfg.inputLimitChars)
    const task = [this.cfg.taskPrefix, content].filter(Boolean).join('\n')
    const key = message.chatId ?? message.fromUser
    const target: ReplyTarget = message.chatId ? { chatid: message.chatId } : { touser: message.fromUser }
    this.bridge.enqueue(key, task, target)
  }
}

export default WecomBot
