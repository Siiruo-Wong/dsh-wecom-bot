/**
 * 长连接模式适配器(智能机器人 WebSocket 通道)。
 *
 * 底层使用官方 @wecom/aibot-node-sdk 的 WSClient(认证/心跳/指数退避重连/回执队列
 * 全部由 SDK 处理),本适配器只做:
 * - 收到 aibot_msg_callback 文本消息 → 交给 AgentBridge(会话队列/多轮记忆);
 * - AgentBridge 回复 → 通过 SDK replyStream 走同一条连接回企微(流式:先占位后最终);
 * - 事件与连接状态转日志。
 *
 * 与回调模式共享同一个 AgentBridge;回复目标带 reqId/streamId 时走长连接。
 */
import AiBot from '@wecom/aibot-node-sdk'
import type { AgentBridge } from './agent-bridge.js'
import { truncateUtf8 } from './agent-bridge.js'
import type { Config } from './config.js'
import type { LoggerLike, LongConnClientLike, LongConnFrameLike, ReplyTarget } from './types.js'

const NON_TEXT_TYPES = ['message.image', 'message.mixed', 'message.voice', 'message.file', 'message.video'] as const

export interface WecomLongConnDeps {
  bridge: AgentBridge
  logger: LoggerLike
}

export class WecomLongConn {
  private readonly client: LongConnClientLike
  private readonly bridge: AgentBridge
  private readonly logger: LoggerLike
  /** 运行配置;updateCfg() 会换引用,故不能 readonly。 */
  private cfg: Config
  private readonly cleanups: Array<() => void> = []
  private readonly streamSeq: { n: number } = { n: 0 }
  private started = false

  constructor(cfg: Config, deps: WecomLongConnDeps, client?: LongConnClientLike) {
    this.cfg = cfg
    this.bridge = deps.bridge
    this.logger = deps.logger
    this.client =
      client ??
      new AiBot.WSClient({
        botId: cfg.botId,
        secret: cfg.botSecret,
        ...(cfg.scene !== undefined ? { scene: cfg.scene } : {}),
        wsUrl: cfg.wsUrl,
        heartbeatInterval: cfg.heartbeatIntervalMs,
        reconnectInterval: cfg.reconnectBaseDelayMs,
        maxReconnectAttempts: cfg.maxReconnectAttempts,
        maxAuthFailureAttempts: cfg.maxAuthFailureAttempts,
        requestTimeout: cfg.requestTimeoutMs,
        logger: deps.logger,
      })
  }

  /**
   * 热更新运行配置:引用替换,不重建连接。
   * 构造时持有的是装配配置对象;settings 热更新经此换入新对象,
   * 使逐条读取的 taskPrefix / thinkingHint / inputLimitChars 等立即生效
   * (此前只有改 botId/botSecret 才会重建长连接,提示词热更新永远落空)。
   */
  updateCfg(cfg: Config): void {
    this.cfg = cfg
  }

  /** 建立连接并开始监听(幂等) */
  start(): void {
    if (this.started) return
    this.started = true
    const c = this.client
    this.listen('connected', () => this.logger.info('[wecom-bot] 长连接已建立'))
    this.listen('authenticated', () => this.logger.info('[wecom-bot] 长连接认证成功'))
    this.listen('disconnected', (reason: unknown) =>
      this.logger.warn('[wecom-bot] 长连接断开: ' + String(reason)),
    )
    this.listen('reconnecting', (attempt: unknown) =>
      this.logger.warn('[wecom-bot] 长连接重连中(第 ' + String(attempt) + ' 次)'),
    )
    this.listen('error', (error: unknown) =>
      this.logger.error('[wecom-bot] 长连接错误', error instanceof Error ? error.message : error),
    )
    this.listen('message.text', (frame: LongConnFrameLike) => this.handleText(frame))
    this.listen('event.enter_chat', () => this.logger.debug('[wecom-bot] 用户进入会话'))
    for (const type of NON_TEXT_TYPES) {
      this.listen(type, (frame: LongConnFrameLike) => {
        if (!this.cfg.ignoreNonText) this.hintNonText(frame)
      })
    }
    c.connect()
  }

  /** 由 AgentBridge 调用的回复入口(ReplySender 实现) */
  async sendText(target: ReplyTarget, content: string): Promise<void> {
    const reqId = target.reqId
    if (!reqId) return
    const streamId = target.streamId ?? this.nextStreamId()
    const limited = truncateUtf8(content, this.cfg.replyLimitBytes)
    try {
      await this.client.replyStream({ headers: { req_id: reqId } }, streamId, limited, true)
    } catch (error) {
      this.logger.warn('[wecom-bot] 长连接回复失败', error instanceof Error ? error.message : error)
    }
  }

  /** 关闭连接并清理监听(幂等) */
  async dispose(): Promise<void> {
    this.started = false
    for (const remove of this.cleanups.splice(0)) {
      try {
        remove()
      } catch {
        /* ignore */
      }
    }
    try {
      this.client.disconnect()
    } catch (error) {
      this.logger.warn('[wecom-bot] 长连接断开时出错', error instanceof Error ? error.message : error)
    }
  }

  private listen(event: string, handler: (...args: any[]) => void): void {
    this.client.on(event, handler)
    this.cleanups.push(() => this.client.removeListener?.(event, handler))
  }

  private handleText(frame: LongConnFrameLike): void {
    const body = frame.body
    const content = body?.text?.content
    if (!content) return
    const user = body?.from?.userid
    const key = body?.chatid ?? user
    const reqId = frame.headers?.req_id
    if (!key || !reqId) return
    const task = [this.cfg.taskPrefix, content.slice(0, this.cfg.inputLimitChars)].filter(Boolean).join('\n')
    const target: ReplyTarget = { reqId, streamId: this.nextStreamId() }
    if (this.cfg.thinkingHint) {
      void this.client
        .replyStream({ headers: { req_id: reqId } }, target.streamId!, this.cfg.thinkingHint, false)
        .catch((error: unknown) =>
          this.logger.debug('[wecom-bot] 思考占位发送失败', error instanceof Error ? error.message : error),
        )
    }
    this.bridge.enqueue(key, task, target)
  }

  private hintNonText(frame: LongConnFrameLike): void {
    const reqId = frame.headers?.req_id
    if (!reqId) return
    void this.client
      .replyStream({ headers: { req_id: reqId } }, this.nextStreamId(), '目前仅支持文本消息。', true)
      .catch((error: unknown) =>
        this.logger.debug('[wecom-bot] 非文本提示发送失败', error instanceof Error ? error.message : error),
      )
  }

  private nextStreamId(): string {
    this.streamSeq.n += 1
    return 'stream_' + Date.now().toString(36) + '_' + this.streamSeq.n
  }
}