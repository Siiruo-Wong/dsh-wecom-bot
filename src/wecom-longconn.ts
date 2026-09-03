/**
 * 长连接模式适配器(智能机器人 WebSocket 通道)。
 *
 * 底层使用官方 @wecom/aibot-node-sdk 的 WSClient(认证/心跳/指数退避重连/回执队列
 * 全部由 SDK 处理),本适配器只做:
 * - 收到 aibot_msg_callback 文本消息 → 交给 AgentBridge(会话队列/多轮记忆);
 * - AgentBridge 回复 → 通过 SDK replyStream 走同一条连接回企微(流式:先占位后最终);
 * - 事件与连接状态转日志。
 *
 * 最终回复的可靠投递(针对"处理完了但没回出去/只回一半"的实测问题):
 * - 短任务:最终答复在同一 streamId 上原位刷新占位(用户看到"思考中"变答案);
 * - 长任务(占位流超过 refreshMaxAgeMs):不再指望 15 分钟前的旧流,最终答复作为
 *   一条**独立新消息**发送,避免占位流被企微服务端判过期后整条丢失;
 * - 断线/回执失败:有限次重试;连接不可用时进入待发缓冲,重连(connected)后自动补发;
 * - 服务端明确拒绝当前流(errcode≠0)时,切换为独立新消息补发一次,仍失败才放弃并记错;
 * - 单条内容超长按通道上限截断并附可见标记(fitUtf8)。
 *
 * 与回调模式共享同一个 AgentBridge;回复目标带 reqId/streamId 时走长连接。
 */
import AiBot from '@wecom/aibot-node-sdk'
import type { AgentBridge } from './agent-bridge.js'
import { fitUtf8 } from './agent-bridge.js'
import type { Config } from './config.js'
import { splitSessionToken } from './session-key.js'
import type { LoggerLike, LongConnClientLike, LongConnFrameLike, ReplyTarget } from './types.js'

const NON_TEXT_TYPES = ['message.image', 'message.mixed', 'message.voice', 'message.file', 'message.video'] as const

/** 企微流式消息单帧 content 上限(官方文档:最长不超过 20480 字节) */
const STREAM_CONTENT_MAX_BYTES = 20480
/** 占位流允许原位刷新的最大时长:超过则最终答复改为独立新消息,不依赖旧流 */
const DEFAULT_REFRESH_MAX_AGE_MS = 5 * 60_000
/** 最终回复(含补发)的总尝试上限 = 初始 1 次 + 重试次数 */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000, 5_000, 10_000]
/** 断线待发缓冲上限,超出丢弃最旧并记错(正常情况下只会短暂积压) */
const PENDING_MAX = 100

/** 服务端回执帧(errcode≠0 时 SDK 以该帧 reject) */
interface AckFrame {
  errcode?: number
  errmsg?: string
}

/** 一次最终回复的投递状态机 */
interface FinalReply {
  reqId: string
  streamId: string
  content: string
  attempts: number
  /** 是否已在走"独立新消息"通道(不再依赖原占位流) */
  asFreshMessage: boolean
}

/** 占位流登记(reqId → 占位 streamId 及发送时间) */
interface StreamEntry {
  streamId: string
  createdAt: number
}

export interface WecomLongConnDeps {
  bridge: AgentBridge
  logger: LoggerLike
  /** 分配下一个新会话标识(不带 # 标识的消息使用);带标识的消息直接续接。 */
  nextSession: () => string
}

export interface WecomLongConnOptions {
  /** 传输类失败的重试间隔(ms);测试可注入更小值以加速 */
  retryDelaysMs?: number[]
  /** 占位流原位刷新的最大时长(ms),超过则最终答复走独立新消息 */
  refreshMaxAgeMs?: number
}

function ackErrcode(error: unknown): AckFrame | undefined {
  if (error && typeof error === 'object') {
    const e = error as AckFrame
    if (typeof e.errcode === 'number') {
      return { errcode: e.errcode, errmsg: typeof e.errmsg === 'string' ? e.errmsg : undefined }
    }
  }
  return undefined
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class WecomLongConn {
  private readonly client: LongConnClientLike
  private readonly bridge: AgentBridge
  private readonly logger: LoggerLike
  private readonly nextSession: () => string
  private readonly retryDelays: number[]
  private readonly refreshMaxAgeMs: number
  /** 运行配置;updateCfg() 会换引用,故不能 readonly。 */
  private cfg: Config
  private readonly cleanups: Array<() => void> = []
  private readonly streamSeq: { n: number } = { n: 0 }
  /** reqId → 思考占位流(placeholder 帧 finish:false 使用的 streamId) */
  private readonly streamEntries = new Map<string, StreamEntry>()
  /** 连接不可用期间待补发的最终回复 */
  private readonly pendingReplies: FinalReply[] = []
  private flushing = false
  private started = false

  constructor(cfg: Config, deps: WecomLongConnDeps, client?: LongConnClientLike, options: WecomLongConnOptions = {}) {
    this.cfg = cfg
    this.bridge = deps.bridge
    this.logger = deps.logger
    this.nextSession = deps.nextSession
    this.retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.refreshMaxAgeMs = options.refreshMaxAgeMs ?? DEFAULT_REFRESH_MAX_AGE_MS
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
    this.listen('connected', () => {
      this.logger.info('[wecom-bot] 长连接已建立')
      // 断线期间积压的最终回复,重连后自动补发
      if (this.pendingReplies.length > 0) {
        this.logger.info(`[wecom-bot] 长连接已恢复,补发 ${this.pendingReplies.length} 条待发回复`)
        void this.flushPending()
      }
    })
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

  /**
   * 由 AgentBridge 调用的最终回复入口(ReplySender 实现)。
   * 内容超长按 replyLimitBytes(通道上限内)截断并附可见标记。
   */
  async sendText(target: ReplyTarget, content: string): Promise<void> {
    const reqId = target.reqId
    if (!reqId) return
    // 上限双重保险:配置值不得越过企微流式单帧 20480B
    const cap = Math.min(this.cfg.replyLimitBytes, STREAM_CONTENT_MAX_BYTES)
    const limited = fitUtf8(content, cap)
    await this.deliverFinal(reqId, limited)
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
    if (this.pendingReplies.length > 0) {
      this.logger.warn(`[wecom-bot] 停服,丢弃 ${this.pendingReplies.length} 条未发送的最终回复`)
      this.pendingReplies.length = 0
    }
    this.streamEntries.clear()
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
    const reqId = frame.headers?.req_id
    if (!reqId) return
    // 显式会话标识:带 #<数字> 续接原会话;不带则分配新会话(递增号,独立上下文)
    const { token, rest } = splitSessionToken(content)
    const key = token ?? this.nextSession()
    const task = [this.cfg.taskPrefix, rest.slice(0, this.cfg.inputLimitChars)].filter(Boolean).join('\n')
    const target: ReplyTarget = { reqId, streamId: this.nextStreamId() }
    if (this.cfg.thinkingHint) {
      // 登记占位流:短任务最终答复在同一流上原位刷新;超龄后走独立新消息
      this.recordStream(reqId, target.streamId!)
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

  // ---------- 最终回复可靠投递 ----------

  private recordStream(reqId: string, streamId: string): void {
    this.streamEntries.set(reqId, { streamId, createdAt: Date.now() })
    // 清理超龄登记 + 防止无界增长
    if (this.streamEntries.size > 200) {
      const oldest = this.streamEntries.keys().next().value as string | undefined
      if (oldest !== undefined) this.streamEntries.delete(oldest)
    }
    for (const [id, entry] of this.streamEntries) {
      if (Date.now() - entry.createdAt > this.refreshMaxAgeMs + 60_000) this.streamEntries.delete(id)
    }
  }

  /**
   * 发送最终答复:
   * - 占位流仍在刷新窗口内 → 同一 streamId 原位刷新(用户看到"思考中"变成答案);
   * - 无占位流 / 占位流已超龄 → 独立新消息(不依赖可能已被服务端过期的旧流)。
   */
  private async deliverFinal(reqId: string, content: string): Promise<void> {
    const entry = this.streamEntries.get(reqId)
    const freshEntry = !!entry && Date.now() - entry.createdAt <= this.refreshMaxAgeMs
    if (!freshEntry) this.streamEntries.delete(reqId)
    const item: FinalReply = {
      reqId,
      streamId: freshEntry ? entry!.streamId : this.nextStreamId(),
      content,
      attempts: 0,
      asFreshMessage: !freshEntry,
    }
    const ageSec = entry ? Math.round((Date.now() - entry.createdAt) / 1000) : undefined
    this.logger.debug(
      `[wecom-bot] 最终回复发送(req=${reqId}, stream=${item.streamId}, 方式=${freshEntry ? '原位刷新占位流' : '独立新消息'}` +
        (ageSec !== undefined ? `, 距入站 ${ageSec}s` : '') + ')',
    )
    await this.sendWithRetry(item)
  }

  /** 一次投递:成功即止;失败按类型有限重试/补发/放弃并记错 */
  private async sendWithRetry(item: FinalReply): Promise<void> {
    for (;;) {
      if (!this.started) {
        this.drop(item, '插件已停用')
        return
      }
      if (!this.isConnected()) {
        this.buffer(item)
        return
      }
      item.attempts += 1
      try {
        await this.client.replyStream(
          { headers: { req_id: item.reqId } },
          item.streamId,
          item.content,
          true,
        )
        this.streamEntries.delete(item.reqId)
        this.logger.info(`[wecom-bot] 最终回复已送达(req=${item.reqId}, stream=${item.streamId})`)
        return
      } catch (error) {
        const ack = ackErrcode(error)
        if (ack) {
          // 服务端明确拒绝:占位流大概率已过期 → 切独立新消息补发一次;新消息也被拒才放弃
          this.logger.warn(
            `[wecom-bot] 长连接回复被服务端拒绝(errcode=${ack.errcode}${ack.errmsg ? `, ${ack.errmsg}` : ''}, req=${item.reqId}, stream=${item.streamId})`,
          )
          if (item.asFreshMessage || item.attempts >= this.attemptCap) {
            this.drop(item, `errcode=${ack.errcode}`)
            return
          }
          item.asFreshMessage = true
          item.streamId = this.nextStreamId()
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn(
          `[wecom-bot] 长连接回复失败(第 ${item.attempts}/${this.attemptCap} 次, req=${item.reqId}, stream=${item.streamId}): ${message}`,
        )
        if (item.attempts >= this.attemptCap) {
          this.drop(item, message)
          return
        }
        const delay = this.retryDelays[Math.min(item.attempts - 1, this.retryDelays.length - 1)] ?? 1_000
        await sleep(delay)
      }
    }
  }

  private buffer(item: FinalReply): void {
    if (this.pendingReplies.length >= PENDING_MAX) {
      const dropped = this.pendingReplies.shift()
      this.logger.error(
        `[wecom-bot] 待发缓冲已满,丢弃最旧回复(req=${dropped?.reqId})`,
      )
    }
    this.pendingReplies.push(item)
    this.logger.warn(
      `[wecom-bot] 长连接不可用,最终回复暂存待补发(req=${item.reqId}, 队列=${this.pendingReplies.length})`,
    )
  }

  /** 连接恢复后补发所有待发回复(串行,幂等) */
  private async flushPending(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.pendingReplies.length > 0 && this.isConnected() && this.started) {
        const item = this.pendingReplies.shift()!
        await this.sendWithRetry(item)
      }
    } finally {
      this.flushing = false
    }
  }

  private drop(item: FinalReply, reason: string): void {
    this.streamEntries.delete(item.reqId)
    this.logger.error(
      `[wecom-bot] 长连接最终回复多次尝试后仍失败,已放弃(req=${item.reqId}, 原因=${reason})`,
    )
  }

  private isConnected(): boolean {
    return this.client.isConnected
  }

  private get attemptCap(): number {
    return this.retryDelays.length + 1
  }
}
