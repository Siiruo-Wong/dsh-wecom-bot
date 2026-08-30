/**
 * 进程内 dsh agent 桥接。
 *
 * 设计:
 * - 每个会话(用户/群)一条 FIFO 队列 + 深度上限,超出直接提示繁忙;
 * - 同一会话复用同一 sessionId(agent),天然获得多轮上下文(JSONL 持久化由宿主提供);
 * - 通过 session/event 收集本轮事件,agent 空闲(idle)时取最后一条 assistant/message 作为答复;
 * - 单轮超时保护:超时回复并销毁该会话句柄,下一条消息自动重建全新会话;
 * - agent 句柄与注册表不一致(如插件重载)时自愈重建。
 */
import { randomUUID } from 'node:crypto'
import type {
  AgentHandleLike,
  AgentsServiceLike,
  LoggerLike,
  ReplyTarget,
  SessionEventLike,
  UserMessageLike,
} from './types.js'
import type { WecomApi } from './wecom-api.js'

export interface AgentBridgeConfig {
  workspace: string
  provider?: string
  model?: string
  maxTokens?: number
  maxQueueDepth: number
  promptTimeoutMs: number
  sessionIdPrefix: string
  replyLimitBytes: number
}

interface QueuedPrompt {
  id: string
  task: string
  target: ReplyTarget
}

interface SessionState {
  handle: AgentHandleLike | null
  queue: QueuedPrompt[]
  busy: boolean
  current: QueuedPrompt | null
  events: SessionEventLike[]
  timer: ReturnType<typeof setTimeout> | null
  creating: Promise<AgentHandleLike> | null
}

/** 构造一条用户消息(与 dsh-llm createUserMessage 的形状一致) */
export function buildUserMessage(task: string): UserMessageLike {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }
}

/** 从事件流提取最后一条 assistant 文本与最后的 turn 结束原因 */
export function lastAssistantText(events: SessionEventLike[]): { text: string; reason: string | undefined } {
  let text = ''
  let reason: string | undefined
  for (const event of events) {
    if (event.type === 'turn/end') {
      reason = event.data?.reason?.kind
      continue
    }
    if (event.type !== 'assistant/message') continue
    const data = event.data
    const message = data && typeof data === 'object' && 'message' in data
      && data.message !== null && typeof data.message === 'object'
      ? data.message
      : data
    const content = message !== null && typeof message === 'object'
      && Array.isArray((message as { content?: unknown }).content)
      ? (message as { content: unknown[] }).content
      : []
    const parts: string[] = []
    for (const block of content) {
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string') parts.push(t)
      }
    }
    if (parts.length > 0) text = parts.join('')
  }
  return { text, reason }
}

/** 按 UTF-8 字节数截断,保持字符边界完整(不截断多字节字符/emoji) */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let size = 0
  let out = ''
  for (const char of text) {
    const len = Buffer.byteLength(char, 'utf8')
    if (size + len > maxBytes) break
    size += len
    out += char
  }
  return out
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AgentBridge {
  private readonly sessions = new Map<string, SessionState>()
  private readonly disposers: (() => void)[] = []

  constructor(
    private readonly ctx: {
      agents: AgentsServiceLike
      on(event: string, handler: (...args: unknown[]) => void): () => void
    },
    private readonly cfg: AgentBridgeConfig,
    private readonly wecom: WecomApi,
    private readonly logger: LoggerLike,
  ) {
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const id = typeof (session as { id?: unknown }).id === 'string' ? (session as { id: string }).id : ''
      if (id) this.onSessionEvent(id, event as SessionEventLike)
    }))
    this.disposers.push(ctx.on('agent/status', (payload) => {
      const agent = (payload as { agent?: { session?: { id?: unknown } } }).agent
      const status = (payload as { status?: unknown }).status
      if (agent && typeof agent.session?.id === 'string' && typeof status === 'string') {
        this.onAgentStatus(agent.session.id, status)
      }
    }))
  }

  /** 会话键 -> 全局唯一的 dsh sessionId(避免与 Web UI 会话冲突) */
  private sessionIdOf(sessionKey: string): string {
    return `${this.cfg.sessionIdPrefix}:${sessionKey}`
  }

  /** 入队一条消息并尝试派发;队列满则立即提示繁忙 */
  enqueue(sessionKey: string, task: string, target: ReplyTarget): void {
    const sessionId = this.sessionIdOf(sessionKey)
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { handle: null, queue: [], busy: false, current: null, events: [], timer: null, creating: null }
      this.sessions.set(sessionId, state)
    }
    if (state.queue.length >= this.cfg.maxQueueDepth) {
      void this.reply(target, '⚠️ 您的消息太多了,请稍后再试。')
      return
    }
    state.queue.push({ id: randomUUID(), task, target })
    void this.pump(sessionId)
  }

  private async pump(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.busy) return
    const next = state.queue.shift()
    if (!next) return
    state.busy = true
    state.current = next
    state.events = []
    try {
      const handle = await this.ensureHandle(sessionId, state)
      handle.agent.followup(buildUserMessage(next.task))
      state.timer = setTimeout(() => {
        void this.onTimeout(sessionId, state, next)
      }, this.cfg.promptTimeoutMs)
      state.timer.unref?.()
    } catch (error) {
      this.logger.warn(`[wecom-bot] 会话 ${sessionId} 派发失败`, error)
      state.busy = false
      state.current = null
      state.handle = null
      void this.reply(next.target, `❌ 无法启动 dsh 会话: ${errMessage(error)}`)
      void this.pump(sessionId)
    }
  }

  private async ensureHandle(sessionId: string, state: SessionState): Promise<AgentHandleLike> {
    if (state.handle) {
      // 插件重载/外部处置后注册表里可能已无此 agent:校验存活,失效则重建
      if (this.ctx.agents.get(sessionId) === state.handle.agent) return state.handle
      state.handle = null
    }
    if (state.creating) return state.creating
    const creating = this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.cfg.workspace },
      agentOptions: {
        ...(this.cfg.provider ? { provider: this.cfg.provider } : {}),
        ...(this.cfg.model ? { model: this.cfg.model } : {}),
        ...(this.cfg.maxTokens ? { maxTokens: this.cfg.maxTokens } : {}),
      },
    })
    state.creating = creating
    try {
      const handle = await creating
      state.handle = handle
      return handle
    } finally {
      state.creating = null
    }
  }

  private onSessionEvent(sessionId: string, event: SessionEventLike): void {
    const state = this.sessions.get(sessionId)
    if (!state || !state.busy) return
    state.events.push(event)
    if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000)
  }

  private onAgentStatus(sessionId: string, status: string): void {
    const state = this.sessions.get(sessionId)
    if (!state || !state.busy || status !== 'idle') return
    void this.finishTurn(sessionId, state)
  }

  private async finishTurn(sessionId: string, state: SessionState): Promise<void> {
    const prompt = state.current
    state.current = null
    state.busy = false
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (!prompt) {
      void this.pump(sessionId)
      return
    }
    const { text, reason } = lastAssistantText(state.events)
    const note = reason === 'error'
      ? '\n\n(⚠️ 本次任务出现错误)'
      : reason === 'max-tokens'
        ? '\n\n(⚠️ 已达输出上限,回复可能不完整)'
        : ''
    const content = text || '(模型没有返回文本)'
    void this.reply(prompt.target, content + note)
    void this.pump(sessionId)
  }

  private async onTimeout(sessionId: string, state: SessionState, prompt: QueuedPrompt): Promise<void> {
    this.logger.warn(`[wecom-bot] 会话 ${sessionId} 任务超时(${this.cfg.promptTimeoutMs}ms)`)
    if (state.current === prompt) state.current = null
    state.busy = false
    state.timer = null
    // 超时通常是 agent 卡住:销毁句柄,下一条消息会重建全新会话
    const handle = state.handle
    state.handle = null
    if (handle) void handle.dispose().catch(() => {})
    void this.reply(prompt.target, '⏱️ 处理超时,请稍后重试。')
    void this.pump(sessionId)
  }

  private reply(target: ReplyTarget, content: string): Promise<void> {
    return this.wecom.sendText(target, truncateUtf8(content, this.cfg.replyLimitBytes))
      .catch((error: unknown) => {
        this.logger.error('[wecom-bot] 回复发送失败', error)
      })
  }

  /** 插件卸载时清理:取消监听、清定时器、处置所有会话句柄 */
  async dispose(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose()
    const states = [...this.sessions.values()]
    this.sessions.clear()
    for (const state of states) {
      if (state.timer) clearTimeout(state.timer)
      if (state.handle) await state.handle.dispose().catch(() => {})
    }
  }
}
