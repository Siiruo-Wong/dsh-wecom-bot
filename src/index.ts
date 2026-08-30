/**
 * dsh-wecom-bot — 企业微信智能机器人插件(DeepSeek Harness / dsh)。
 *
 * 能力:
 * - 独立端口监听企微回调(GET 验签验证 / POST 接收消息),先回 200 再异步处理;
 * - 进程内复用 dsh agent 核心:每会话一条 FIFO 队列、同一 sessionId 多轮记忆;
 * - 完成后通过企业微信"应用消息"API 主动推送回复。
 *
 * 安全:签名常数时间比较、AES 密钥/填充严格校验、请求体与文本长度限制、
 * 凭据不入日志、默认仅绑定 127.0.0.1。详见 README.md 与 SECURITY.md。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ConfigError, resolveConfig, type Config } from './config.js'
import { decryptWecomMessage, verifySignature } from './crypto.js'
import { WecomApi } from './wecom-api.js'
import { CallbackServer } from './http-server.js'
import { AgentBridge } from './agent-bridge.js'
import type { AgentsServiceLike, ParsedCallback } from './types.js'

export type { Config } from './config.js'
export { ConfigError } from './config.js'
export { WecomApiError } from './wecom-api.js'
export { truncateUtf8, lastAssistantText, buildUserMessage } from './agent-bridge.js'

export class WecomBot extends Service {
  static Config: z<Config> = z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).default('127.0.0.1'),
    port: z.natural().max(65535).default(8787),
    path: z.string().default('/wecom/callback'),
    corpId: z.string().required(),
    appSecret: z.string().required(),
    agentId: z.natural().required(),
    token: z.string().required(),
    aesKey: z.string().required(),
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
  private readonly wecom: WecomApi
  private readonly bridge: AgentBridge
  private readonly server: CallbackServer

  constructor(ctx: Context, raw: Partial<Config> = {}) {
    super(ctx, 'wecomBot')
    const cfg = resolveConfig(raw)
    this.cfg = cfg
    const agents = (ctx as unknown as { agents?: AgentsServiceLike }).agents
    if (!agents) {
      throw new ConfigError('当前环境未提供 agent 服务(ctx.agents):请确认插件运行在具备 agent 核心的 dsh profile(web/desktop)中')
    }
    this.wecom = new WecomApi({
      corpId: cfg.corpId,
      appSecret: cfg.appSecret,
      agentId: cfg.agentId,
      timeoutMs: cfg.apiTimeoutMs,
    })
    this.bridge = new AgentBridge(
      ctx as unknown as { agents: AgentsServiceLike; on(event: string, handler: (...args: unknown[]) => void): () => void },
      cfg,
      this.wecom,
      ctx.logger,
    )
    this.server = new CallbackServer(
      { host: cfg.host, port: cfg.port, path: cfg.path, bodyLimitBytes: cfg.bodyLimitBytes },
      {
        decrypt: (encrypt, params) => this.decryptPayload(encrypt, params),
        handleMessage: (message) => this.onMessage(message),
        logger: ctx.logger,
      },
    )
  }

  async [Service.init](): Promise<void> {
    const port = await this.server.start()
    this.ctx.logger.info(`[wecom-bot] 企微回调已监听 http://${this.cfg.host}:${port}${this.cfg.path}`)
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
    this.ctx.effect(() => async () => {
      await this.server.stop()
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
      if (!this.cfg.ignoreNonText && message.fromUser) {
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
    const target = message.chatId ? { chatid: message.chatId } : { touser: message.fromUser }
    this.bridge.enqueue(key, task, target)
  }
}

export default WecomBot