/**
 * 进程内 dsh agent 桥接。
 *
 * 设计:
 * - 会话标识显式化:消息带 `#<数字>` 续接该会话;不带则默认开新会话(独立上下文);
 * - 每个会话(用户/群/话题)一条 FIFO 队列 + 深度上限,超出直接提示繁忙;
 * - 同一会话复用同一 sessionId(agent),天然获得多轮上下文(JSONL 持久化由宿主提供);
 * - 通过 session/event 收集本轮事件,agent 空闲(idle)时取最后一条 assistant/message 作为答复;
 * - 单轮超时保护:超时只**中止当轮**(agent.cancel),不 dispose、不删日志,
 *   上下文保留,用户带 `#<标识>` 回来即可续接;
 * - agent 句柄与注册表不一致(如插件重载)时自愈重建。
 */
import { randomUUID } from 'node:crypto'
import type {
  AgentHandleLike,
  AgentPresetsServiceLike,
  AgentsServiceLike,
  LoggerLike,
  ReplyTarget,
  SessionEventLike,
  SessionTitleServiceLike,
  UserMessageLike,
} from './types.js'
import type { ReplySender } from './types.js'

export interface AgentBridgeConfig {
  workspace: string
  provider?: string
  model?: string
  maxTokens?: number
  maxQueueDepth: number
  promptTimeoutMs: number
  sessionIdPrefix: string
  /** 超时中止后等待 agent 收敛(回 idle)的兜底窗口,默认 60s;超时也**不销毁会话**,只结束本桥的等待 */
  timeoutSettleMs?: number
  /** 长连接心跳续话:处理满该时长(默认 7 分钟)仍未结束时发第一条"仍在处理" */
  heartbeatStartMs?: number
  /** 之后每隔该时长(默认 2.5 分钟)再发一条,维持企微回复窗口不被判定超时 */
  heartbeatIntervalMs?: number
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
  heartbeat: ReturnType<typeof setTimeout> | null
  creating: Promise<AgentHandleLike> | null
  /** agent 实际会话 id(冲突自愈后与状态键不同);未设置时用状态键 */
  agentId?: string
  /** 是否已做过持久化冲突重试(每状态最多一次,避免死循环) */
  collisionRetried?: boolean
  /** 本轮已被超时中止(仅影响回复措辞;会话与句柄一律保留) */
  timedOut?: boolean
  /** 超时中止后等待 agent 收敛的兜底定时器 */
  settleTimer?: ReturnType<typeof setTimeout> | null
}

/**
 * 会话创建/持久化冲突特征,覆盖三类来源:
 * - SessionStore 活跃会话冲突(session ... already exists);
 * - 持久化 coordinator 已存在日志(refusing to materialize / already has a persisted log);
 * - agent-loop 的 does not match this live session。
 * 命中后按既有自愈路径换新 sessionId 原样重试一次。
 */
const SESSION_COLLISION_RE = /collision|already exists|persisted log|refusing to materialize|does not match this live session/i

/**
 * 企微智能机器人长连接对单条入站消息的回复存在服务端时效(实测 546s 能回、
 * 832s 被拒,疑为 10 分钟)。处理满 HEARTBEAT_START_MS 仍无任何回复时,自动发
 * "仍在处理"心跳:若窗口随回复活动顺延则维持窗口直到完成;若窗口固定,心跳至少
 * 让用户知道任务还在跑,满 10 分钟后的心跳附带"回复 #N 继续"的拉取指引。
 */
const HEARTBEAT_START_MS = 7 * 60_000
const HEARTBEAT_INTERVAL_MS = 150_000
const HEARTBEAT_WINDOW_HINT_MS = 10 * 60_000

/**
 * 超时中止后的收敛窗口:agent.cancel 之后若迟迟没回到 idle(工具调用卡死、
 * 下游请求不返回等),就结束本桥这一轮的等待。**句柄与会话一律保留**,
 * 下一条消息仍复用同一个 agent,历史不丢。
 */
const TIMEOUT_SETTLE_MS = 60_000

/** 构造一条用户消息(与 dsh-llm createUserMessage 的形状一致) */
export function buildUserMessage(task: string): UserMessageLike {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }
}

/** 从事件流提取最后一条 assistant 文本、turn 结束原因与错误消息 */
export function lastAssistantText(events: SessionEventLike[]): { text: string; reason: string | undefined; errorMessage: string | undefined } {
  let text = ''
  let reason: string | undefined
  let errorMessage: string | undefined
  for (const event of events) {
    if (event.type === 'turn/end') {
      reason = event.data?.reason?.kind
      const reasonData = event.data?.reason as { error?: { message?: unknown } } | undefined
      if (reasonData?.error && typeof reasonData.error.message === 'string') {
        errorMessage = reasonData.error.message
      }
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
  return { text, reason, errorMessage }
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

/** 截断时附加的可见标记:让用户知道内容被切掉了(完整版在 dsh 会话记录里) */
export const TRUNCATION_MARKER = '\n\n…（内容过长已截断，完整版见 dsh 会话记录）'

/**
 * 把文本适配到单条消息的字节上限:
 * - 放得下时不截断;
 * - 放不下时按字符边界截断,并附 TRUNCATION_MARKER 提示(预留标记字节);
 * - 上限小到连标记都放不下时退化为静默截断(不再加标记,避免只回一个标记)。
 * 截断由各发送通道按自己的协议上限调用(callback 2000B / longconn 16000B)。
 */
export function fitUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')
  const budget = maxBytes - markerBytes
  if (budget < 32) return truncateUtf8(text, maxBytes)
  return truncateUtf8(text, budget) + TRUNCATION_MARKER
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AgentBridge {
  private readonly sessions = new Map<string, SessionState>()
  /** agent 实际会话 id -> 状态键(冲突重试后 agent id 可能与状态键不同) */
  private readonly agentToSession = new Map<string, string>()
  private readonly disposers: (() => void)[] = []
  /** 解析过一次的 agent 预设(agentPreset id + 挂载 setup);无预设服务时为空对象 */
  private preset: { agentPreset?: string; setup?: (agentCtx: unknown) => Promise<void> } | null = null

  constructor(
    private readonly ctx: {
      agents: AgentsServiceLike
      on(event: string, handler: (...args: unknown[]) => void): () => void
      get<T>(key: string): T | undefined
    },
    private readonly cfg: AgentBridgeConfig,
    private readonly sender: ReplySender,
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

  /**
   * 热更新桥接配置(由设置命名空间变更触发)。只影响之后新建的 agent;
   * 已在运行的会话保持其既有 agent,直到超时/失效后重建。
   */
  update(patch: Partial<AgentBridgeConfig>): void {
    Object.assign(this.cfg, patch)
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
      state = {
        handle: null, queue: [], busy: false, current: null, events: [], timer: null, heartbeat: null, creating: null,
      }
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
      this.startHeartbeat(sessionId, state)
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
      // 插件重载/外部处置后注册表里可能已无此 agent:校验存活(按 agent 实际 id,冲突重试后可能与状态键不同),失效则重建
      if (this.ctx.agents.get(state.handle.agent.id) === state.handle.agent) return state.handle
      this.agentToSession.delete(state.handle.agent.id)
      state.handle = null
    }
    // 宿主进程里已有同 id 的活跃 agent(例如 GUI 恢复了该会话):直接复用,
    // 保住多轮上下文,避免 agents.create 撞上 "session already exists"。
    const live = this.ctx.agents.get(sessionId)
    if (live) {
      const shared: AgentHandleLike = {
        agent: live,
        // 共享句柄:不销毁宿主拥有的 agent,只解除本桥的引用
        dispose: async () => {},
      }
      state.handle = shared
      this.agentToSession.set(live.id, sessionId)
      return shared
    }
    if (state.creating) return state.creating
    const creating = this.createAgentHandle(state.agentId ?? sessionId)
    state.creating = creating
    try {
      const handle = await creating
      state.handle = handle
      this.agentToSession.set(handle.agent.id, sessionId)
      return handle
    } finally {
      state.creating = null
    }
  }

  /**
   * 解析一次 agent 预设(与 web 会话一致的 agent 平面:persona/工具目录/run_code 等)。
   * 无 agentPresets 服务或解析失败时按无预设创建(退化到部署默认)。
   */
  private async resolvePreset(): Promise<{ agentPreset?: string; setup?: (agentCtx: unknown) => Promise<void> }> {
    if (this.preset) return this.preset
    const presets = this.ctx.get?.<AgentPresetsServiceLike>('agentPresets')
    if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
      this.preset = {}
      return this.preset
    }
    try {
      const resolved = await presets.resolve(undefined)
      this.preset = {
        agentPreset: resolved.id,
        setup: async (agentCtx: unknown) => { await presets.mount(agentCtx, resolved.id) },
      }
    } catch (error) {
      this.logger.warn(`[wecom-bot] agent 预设解析失败,按无预设创建: ${errMessage(error).slice(0, 120)}`)
      this.preset = {}
    }
    return this.preset
  }

  /** 组装一次 agents.create 的公共参数(预设 + provider/model/maxTokens)。 */
  private async createOptions(sessionId: string): Promise<{
    sessionId: string
    meta: { cwd: string; agentPreset?: string }
    agentOptions: { provider?: string; model?: string; maxTokens?: number }
    setup?: (agentCtx: unknown) => Promise<void>
  }> {
    const preset = await this.resolvePreset()
    return {
      sessionId,
      meta: {
        cwd: this.cfg.workspace,
        ...(preset.agentPreset ? { agentPreset: preset.agentPreset } : {}),
      },
      agentOptions: {
        ...(this.cfg.provider ? { provider: this.cfg.provider } : {}),
        ...(this.cfg.model ? { model: this.cfg.model } : {}),
        ...(this.cfg.maxTokens ? { maxTokens: this.cfg.maxTokens } : {}),
      },
      ...(preset.setup ? { setup: preset.setup } : {}),
    }
  }

  /** 组装一次 agents.resume 的参数(resume 从持久化头部取 cwd/预设,无需 meta)。 */
  private async resumeOptions(sessionId: string): Promise<{
    resumeSessionId: string
    agentOptions: { provider?: string; model?: string; maxTokens?: number }
    setup?: (agentCtx: unknown) => Promise<void>
  }> {
    const preset = await this.resolvePreset()
    return {
      resumeSessionId: sessionId,
      agentOptions: {
        ...(this.cfg.provider ? { provider: this.cfg.provider } : {}),
        ...(this.cfg.model ? { model: this.cfg.model } : {}),
        ...(this.cfg.maxTokens ? { maxTokens: this.cfg.maxTokens } : {}),
      },
      ...(preset.setup ? { setup: preset.setup } : {}),
    }
  }

  /**
   * 会话创建冲突(磁盘持久化会话与内存状态错位,常见于应用重启后)自愈:
   * 1. 优先 resume 原 sessionId —— 续接持久化日志,保留全部多轮记忆;
   * 2. resume 不可用/失败(宿主较旧、日志损坏等)时,兜底换新 sessionId 原样重试一次。
   */
  private async createAgentHandle(sessionId: string): Promise<AgentHandleLike> {
    try {
      const handle = await this.ctx.agents.create(await this.createOptions(sessionId))
      this.setSessionTitle(handle, sessionId)
      return handle
    } catch (error) {
      const message = String((error as { message?: unknown })?.message ?? error)
      if (!SESSION_COLLISION_RE.test(message)) throw error
      // 优先续接原会话:同 id 的持久化日志就是上一进程留下的历史,resume 能完整恢复。
      if (typeof this.ctx.agents.resume === 'function') {
        try {
          const resumed = await this.ctx.agents.resume(await this.resumeOptions(sessionId))
          this.logger.warn(`[wecom-bot] 会话 ${sessionId} 创建冲突(${message.slice(0, 80)}),已 resume 续接原会话`)
          this.setSessionTitle(resumed, sessionId)
          return resumed
        } catch (resumeError) {
          const resumeMessage = String((resumeError as { message?: unknown })?.message ?? resumeError)
          this.logger.warn(`[wecom-bot] 会话 ${sessionId} resume 续接失败(${resumeMessage.slice(0, 80)}),改用新 sessionId 重试`)
        }
      }
      const alt = sessionId + '#' + Date.now().toString(36)
      this.logger.warn(`[wecom-bot] 会话 ${sessionId} 创建冲突(${message.slice(0, 80)}),改用 ${alt} 重试`)
      return this.ctx.agents.create(await this.createOptions(alt))
    }
  }

  /**
   * 用 `agents.resume` 续接磁盘上的既有会话。
   *
   * 同一个 sessionId 复用只有一条合法路径:resume。create 走的是"新建 live 会话 +
   * 新 seed",持久化层会校验 seed 能否复现已写前缀——历史会话当然复现不了,
   * 于是抛 `does not match this live session (id collision)`,重试多少次都一样。
   * @returns 成功时把句柄挂回状态并返回 true;resume 不可用/失败返回 false
   */
  private async recoverByResume(sessionId: string, state: SessionState): Promise<boolean> {
    const agents = this.ctx.agents
    if (typeof agents.resume !== 'function') return false
    try {
      const resumed = await agents.resume(await this.resumeOptions(sessionId))
      state.handle = resumed
      state.agentId = resumed.agent.id
      this.agentToSession.set(resumed.agent.id, sessionId)
      this.setSessionTitle(resumed, sessionId)
      return true
    } catch (error) {
      this.logger.warn(`[wecom-bot] 会话 ${sessionId} resume 续接失败: ${errMessage(error).slice(0, 120)}`)
      return false
    }
  }

  /**
   * 给会话设置显式标题「企微 #<数字>」,与企微回复中回显的会话标识一致,
   * 便于在 dsh 记录中识别/复盘。session-title 服务随 dsh-base 挂载
   * (ctx.get('sessionTitle'));未挂载或失败时静默降级,不影响会话运行。
   */
  private setSessionTitle(handle: AgentHandleLike, sessionId: string): void {
    try {
      const titles = this.ctx.get<SessionTitleServiceLike>('sessionTitle')
      if (!titles || typeof titles.rename !== 'function') return
      const token = sessionId.slice(this.cfg.sessionIdPrefix.length + 1)
      titles.rename(handle.agent.session, `企微 #${token}`)
    } catch (error) {
      this.logger.warn(`[wecom-bot] 会话标题设置失败(${sessionId}): ${errMessage(error).slice(0, 120)}`)
    }
  }

  private onSessionEvent(sessionId: string, event: SessionEventLike): void {
    const state = this.sessions.get(this.agentToSession.get(sessionId) ?? sessionId)
    if (!state || !state.busy) return
    state.events.push(event)
    if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000)
  }

  private onAgentStatus(sessionId: string, status: string): void {
    const state = this.sessions.get(this.agentToSession.get(sessionId) ?? sessionId)
    if (!state || !state.busy || status !== 'idle') return
    void this.finishTurn(sessionId, state)
  }

  /** 会话标识(回复时回显,用户带 #<标识> 可继续本话题) */
  private sessionToken(sessionId: string): string {
    return sessionId.slice(this.cfg.sessionIdPrefix.length + 1)
  }

  private async finishTurn(sessionId: string, state: SessionState): Promise<void> {
    const prompt = state.current
    state.current = null
    state.busy = false
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.settleTimer) {
      clearTimeout(state.settleTimer)
      state.settleTimer = null
    }
    this.clearHeartbeat(state)
    const timedOut = state.timedOut === true
    state.timedOut = false
    if (!prompt) {
      void this.pump(sessionId)
      return
    }
    const { text, reason, errorMessage } = lastAssistantText(state.events)
    // 持久化冲突自愈:同 id 的磁盘日志与内存会话错位(应用重启/插件重载后常见),
    // 且这个错是在 turn 期(持久化懒初始化 flush 时)才抛,turn 期的 create 抓不到。
    // 关键:这里**必须**走 agents.resume —— 同 id 再 create 只会继续撞
    // "already has a persisted log ... does not match this live session (id collision)",
    // 把会话彻底做死(2026-10-22 企微 #77 事故就是这么续不上的)。
    if (
      reason === 'error' && errorMessage && !state.collisionRetried &&
      SESSION_COLLISION_RE.test(errorMessage)
    ) {
      state.collisionRetried = true
      state.agentId = undefined
      const handle = state.handle
      state.handle = null
      if (handle) void handle.dispose().catch(() => {})
      state.events = []
      state.queue.unshift({ id: prompt.id, task: prompt.task, target: prompt.target })
      const resumed = await this.recoverByResume(sessionId, state)
      this.logger.warn(
        `[wecom-bot] 会话 ${sessionId} 持久化冲突(${errorMessage.slice(0, 80)}),` +
        (resumed ? '已 resume 续接原会话并重试本轮' : 'resume 不可用,按原 id 重试本轮'),
      )
      void this.pump(sessionId)
      return
    }
    const note = timedOut
      ? `\n\n(⏱️ 本轮超时已中止,会话与上下文都保留;回复 #${this.sessionToken(sessionId)} 继续即可)`
      : reason === 'error'
        ? '\n\n(⚠️ 本次任务出现错误' + (errorMessage ? ': ' + errorMessage : '') + ')'
        : reason === 'max-tokens'
          ? '\n\n(⚠️ 已达输出上限,回复可能不完整)'
          : ''
    const body = text || '(模型没有返回文本)'
    const content = `📎 会话标识:#${this.sessionToken(sessionId)}\n\n${body}${note}`
    void this.reply(prompt.target, content)
    void this.pump(sessionId)
  }

  /**
   * 单轮超时:只中止这一轮,**不销毁会话、不删日志**。
   *
   * 历史教训:早先这里直接 `handle.dispose()`,会话被宿主处置 → Web 侧秒收
   * `host/session-removed` 把列表行摘掉,用户连着聊了半小时的上下文也一起没了;
   * 且下一次 `#N` 续接因为磁盘日志还在,create 会撞 "does not match this live
   * session (id collision)",等于把会话做死。
   *
   * 现在的语义:
   * 1. `agent.cancel({kind:'user'})` 掐掉卡住的一轮,agent 与 JSONL 日志原样留下;
   * 2. 本轮正常收敛(agent 回 idle)时由 `finishTurn` 统一收尾,回复带超时说明;
   * 3. 收敛不了(工具卡死)时由 `timeoutSettleMs` 兜底结束本桥的等待,**句柄不释放**,
   *    下一条消息继续复用同一 agent,多轮上下文完整。
   */
  private async onTimeout(sessionId: string, state: SessionState, prompt: QueuedPrompt): Promise<void> {
    state.timer = null
    if (state.current !== prompt) {
      // 超时回调晚到,本轮已被正常收尾:无事可做
      void this.pump(sessionId)
      return
    }
    this.logger.warn(`[wecom-bot] 会话 ${sessionId} 任务超时(${this.cfg.promptTimeoutMs}ms),中止当轮并保留会话`)
    state.timedOut = true
    const agent = state.handle?.agent
    if (agent && typeof agent.cancel === 'function') {
      try {
        agent.cancel({ kind: 'user' })
      } catch (error) {
        this.logger.warn(`[wecom-bot] 会话 ${sessionId} 中止当轮失败: ${errMessage(error).slice(0, 120)}`)
      }
    } else {
      // 宿主没有 cancel 能力:不强杀会话,只结束本桥等待,句柄留给下一条消息复用
      this.logger.warn(`[wecom-bot] 会话 ${sessionId} 宿主不支持 cancel,仅结束本轮等待(会话保留)`)
    }
    const settleMs = this.cfg.timeoutSettleMs ?? TIMEOUT_SETTLE_MS
    if (state.settleTimer) clearTimeout(state.settleTimer)
    state.settleTimer = setTimeout(() => {
      this.forceSettle(sessionId, state, prompt)
    }, settleMs)
    state.settleTimer.unref?.()
  }

  /**
   * 超时中止后 agent 仍未收敛的兜底:结束本桥这一轮的等待并回话。
   * **不 dispose 句柄、不碰持久化**:会话继续存在于宿主与磁盘,接着聊即可。
   */
  private forceSettle(sessionId: string, state: SessionState, prompt: QueuedPrompt): void {
    state.settleTimer = null
    if (state.current !== prompt) return
    this.logger.warn(`[wecom-bot] 会话 ${sessionId} 中止后未收敛,结束本轮等待(会话与句柄保留)`)
    state.current = null
    state.busy = false
    state.timedOut = false
    this.clearHeartbeat(state)
    const token = this.sessionToken(sessionId)
    void this.reply(
      prompt.target,
      `📎 会话标识:#${token}\n\n⏱️ 本轮超时已停止等待(会话与上下文都保留着)。直接回复 #${token} 继续接着聊即可。`,
    )
    void this.pump(sessionId)
  }

  /**
   * 发出回复。不做内容截断:各通道(长连接 / 回调 API)按自己的单条消息协议上限
   * (fitUtf8 + 截断标记)在发送端处理,避免"桥层按一个统一上限切完、通道层
   * 拿不到超长内容再加标记"的两段式静默丢失。
   */
  private reply(target: ReplyTarget, content: string): Promise<void> {
    return this.sender.sendText(target, content)
      .catch((error: unknown) => {
        this.logger.error('[wecom-bot] 回复发送失败', error)
      })
  }

  /** 插件卸载时清理:取消监听、清定时器、处置本桥自己创建的会话句柄 */
  async dispose(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.agentToSession.clear()
    const states = [...this.sessions.values()]
    this.sessions.clear()
    for (const state of states) {
      if (state.timer) clearTimeout(state.timer)
      if (state.heartbeat) clearTimeout(state.heartbeat)
      if (state.settleTimer) clearTimeout(state.settleTimer)
      if (state.handle) await state.handle.dispose().catch(() => {})
    }
  }

  private clearHeartbeat(state: SessionState): void {
    if (state.heartbeat) {
      clearTimeout(state.heartbeat)
      state.heartbeat = null
    }
  }

  /**
   * 长连接"心跳续话":处理满 heartbeatStartMs 且目标带 reqId(企微长连接入站)时,
   * 自动周期性发送"仍在处理"消息。目的:
   * - 若企微回复窗口随活动顺延 → 心跳维持窗口,长任务最终答复可正常送达,无需用户干预;
   * - 若窗口固定约 10 分钟 → 满 10 分钟后的心跳附带"回复 #<标识> 继续"指引,
   *   用户回一句即开新窗口,可把已完成结论拉出来。
   * 仅对带 reqId 的目标生效(callback 推送无时效限制,不打扰)。发送失败静默降级。
   */
  private startHeartbeat(sessionId: string, state: SessionState): void {
    const prompt = state.current
    const startMs = this.cfg.heartbeatStartMs ?? HEARTBEAT_START_MS
    const intervalMs = this.cfg.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    if (!prompt || !prompt.target.reqId || !(startMs > 0)) return
    this.clearHeartbeat(state)
    const target = prompt.target
    const startedAt = Date.now()
    const token = this.sessionToken(sessionId)
    const tick = () => {
      if (!state.busy || state.current !== prompt) {
        state.heartbeat = null
        return
      }
      const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
      const overdue = Date.now() - startedAt >= HEARTBEAT_WINDOW_HINT_MS
      const content = overdue
        ? `⏳ 仍在处理中（已 ${minutes} 分钟）。企微单条消息回复有时限，若迟迟未收到结论，可回复 #${token} 继续。`
        : `⏳ 仍在处理中（已 ${minutes} 分钟），完成后我会把完整结论发你。`
      this.logger.debug(`[wecom-bot] 心跳续话(req=${target.reqId}, 已 ${minutes} 分钟)`)
      void this.reply(target, content)
      state.heartbeat = setTimeout(tick, intervalMs)
      state.heartbeat.unref?.()
    }
    state.heartbeat = setTimeout(tick, startMs)
    state.heartbeat.unref?.()
  }
}