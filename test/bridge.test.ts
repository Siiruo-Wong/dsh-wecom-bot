import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge, lastAssistantText, type AgentBridgeConfig } from '../src/agent-bridge.js'
import type { AgentHandleLike, AgentsServiceLike, ReplyTarget, UserMessageLike } from '../src/types.js'
import type { ReplySender } from '../src/types.js'

interface Harness {
  bridge: AgentBridge
  emit(event: string, ...args: unknown[]): void
  follows: UserMessageLike[]
  created: { sessionId: string; meta: unknown; agentOptions: unknown; setup?: unknown }[]
  sends: { target: ReplyTarget; content: string }[]
  /** 每次 agent.cancel 的中止原因(超时保护应只 cancel 不 dispose) */
  cancels: string[]
  disposed: boolean
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
  agentPresets: { resolve: ReturnType<typeof vi.fn>; mount: ReturnType<typeof vi.fn> }
  ctx: { get: ReturnType<typeof vi.fn> }
}

function makeConfig(overrides: Partial<AgentBridgeConfig> = {}): AgentBridgeConfig {
  return {
    workspace: '/tmp/ws',
    maxQueueDepth: 2,
    promptTimeoutMs: 60_000,
    sessionIdPrefix: 'wecom',
    ...overrides,
  }
}

function makeHarness(overrides: Partial<AgentBridgeConfig> = {}, preseed?: AgentHandleLike): Harness {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const follows: UserMessageLike[] = []
  const created: { sessionId: string; meta: unknown; agentOptions: unknown; setup?: unknown }[] = []
  const sends: { target: ReplyTarget; content: string }[] = []
  const cancels: string[] = []
  let liveAgent: AgentHandleLike | null = preseed ?? null
  let disposed = false

  const agents: AgentsServiceLike = {
    async create(options) {
      created.push({ sessionId: options.sessionId, meta: options.meta, agentOptions: options.agentOptions, setup: options.setup })
      const agent = {
        id: options.sessionId,
        session: { id: options.sessionId },
        followup(message: UserMessageLike) {
          follows.push(message)
        },
        cancel(cause?: { kind: 'user' }) {
          cancels.push(cause?.kind ?? 'none')
        },
      }
      liveAgent = {
        agent,
        dispose: async () => {
          disposed = true
          liveAgent = null
        },
      }
      return liveAgent
    },
    get(id) {
      return liveAgent && liveAgent.agent.id === id ? liveAgent.agent : undefined
    },
  }

  const agentPresets = {
    resolve: vi.fn(async () => ({ id: 'code' })),
    mount: vi.fn(async () => {}),
  }
  const sessionTitle = { rename: vi.fn(() => ({ title: 'x', eventSeq: 0 })) }
  const ctx = {
    agents,
    get: vi.fn((key: string) => {
      if (key === 'agentPresets') return agentPresets
      if (key === 'sessionTitle') return sessionTitle
      return undefined
    }),
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const arr = listeners.get(event) ?? []
        const at = arr.indexOf(handler)
        if (at >= 0) arr.splice(at, 1)
      }
    },
  }

  const wecom = {
    sendText: vi.fn(async (target: ReplyTarget, content: string) => {
      sends.push({ target, content })
    }),
  } as unknown as ReplySender

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const bridge = new AgentBridge(ctx, makeConfig(overrides), wecom, logger)

  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of listeners.get(event) ?? []) handler(...args)
  }

  return {
    bridge,
    emit,
    follows,
    created,
    sends,
    cancels,
    get disposed() {
      return disposed
    },
    logger,
    agentPresets,
    sessionTitle,
    ctx,
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 剥掉回复开头的会话标识行,取正文(标识行形如 "📎 会话标识:#<key>") */
const bodyOf = (content: string): string => content.replace(/^📎 会话标识:#[^\n]+\n\n/, '')

afterEach(() => {
  vi.useRealTimers()
})

describe('AgentBridge', () => {
  it('happy path:入队 -> 创建会话 -> followup -> idle 后回复最终文本', async () => {
    const h = makeHarness()
    h.bridge.enqueue('user1', '你好', { touser: 'u1' })
    await tick()
    expect(h.created).toHaveLength(1)
    expect(h.created[0]?.sessionId).toBe('wecom:user1')
    expect(h.created[0]?.meta).toEqual({ cwd: '/tmp/ws', agentPreset: 'code' })
    expect(h.follows[0]?.content[0]?.text).toBe('你好')
    // 新会话立即以「企微 #<数字>」命名,与企微回复回显的标识一致
    expect(h.sessionTitle.rename).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wecom:user1' }),
      '企微 #user1',
    )

    h.emit('session/event', { id: 'wecom:user1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '收到!' }] } },
    })
    h.emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()

    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.target).toEqual({ touser: 'u1' })
    expect(bodyOf(h.sends[0]!.content)).toBe('收到!')
  })

  it('回复携带会话标识(#<key>),可据此续接', async () => {
    const h = makeHarness()
    h.bridge.enqueue('7', '你好', { touser: 'u1' })
    await tick()
    h.emit('session/event', { id: 'wecom:7' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '收到!' }] } },
    })
    h.emit('agent/status', { agent: { session: { id: 'wecom:7' } }, status: 'idle' })
    await tick()
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.content.startsWith('📎 会话标识:#7')).toBe(true)
    expect(h.sends[0]?.content).toContain('收到!')
  })

  it('多轮:同一会话复用同一 agent,不重复创建', async () => {
    const h = makeHarness()
    h.bridge.enqueue('user1', '第一句', { touser: 'u1' })
    await tick()
    h.emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()
    h.bridge.enqueue('user1', '第二句', { touser: 'u1' })
    await tick()
    expect(h.created).toHaveLength(1)
    expect(h.follows).toHaveLength(2)
    // 复用已有句柄时不重复命名
    expect(h.sessionTitle.rename).toHaveBeenCalledTimes(1)
  })

  it('队列深度上限:超出直接提示繁忙,不创建多余会话', async () => {
    const h = makeHarness({ maxQueueDepth: 1 })
    h.bridge.enqueue('user1', 'm1', { touser: 'u1' })
    await tick() // m1 进入处理
    h.bridge.enqueue('user1', 'm2', { touser: 'u1' }) // 排队(容量 1)
    h.bridge.enqueue('user1', 'm3', { touser: 'u1' }) // 超限 -> 繁忙提示
    await tick()
    expect(h.sends.some((s) => s.content.includes('消息太多'))).toBe(true)
    expect(h.created).toHaveLength(1)
  })

  it('turn 出错(无输出)时回复包含错误提示', async () => {
    const h = makeHarness()
    h.bridge.enqueue('user1', 'x', { touser: 'u1' })
    await tick()
    h.emit('session/event', { id: 'wecom:user1' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    h.emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()
    expect(h.sends[0]?.content).toContain('出现错误')
  })

  it('超时:只中止当轮(不销毁句柄),会话保留,下一条消息复用同一 agent', async () => {
    const h = makeHarness({ promptTimeoutMs: 20, timeoutSettleMs: 20 })
    h.bridge.enqueue('user1', '慢任务', { touser: 'u1' })
    await tick()
    expect(h.follows).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 90))
    // 中止当轮:调了 cancel,但**没有** dispose
    expect(h.cancels).toEqual(['user'])
    expect(h.disposed).toBe(false)
    expect(h.sends.some((s) => s.content.includes('超时'))).toBe(true)
    expect(h.sends.some((s) => s.content.includes('#user1'))).toBe(true) // 给出续接指引
    // 下一条消息复用同一 agent(不重建会话,上下文不丢)
    h.bridge.enqueue('user1', '再来', { touser: 'u1' })
    await tick()
    expect(h.created).toHaveLength(1)
    expect(h.follows).toHaveLength(2)
  })

  it('超时中止后 agent 正常收敛:本轮回复带超时说明,会话仍保留', async () => {
    const h = makeHarness({ promptTimeoutMs: 20, timeoutSettleMs: 5_000 })
    h.bridge.enqueue('user1', '慢任务', { touser: 'u1' })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.cancels).toEqual(['user'])
    expect(h.sends).toHaveLength(0) // 还在等 agent 收敛,先不回话
    // agent 收敛:本轮以 aborted 结束
    h.emit('session/event', { id: 'wecom:user1' }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    h.emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.content).toContain('超时')
    expect(h.sends[0]?.content).toContain('#user1')
    expect(h.disposed).toBe(false)
    // 上下文仍在:下一条消息复用同一 agent
    h.bridge.enqueue('user1', '继续', { touser: 'u1' })
    await tick()
    expect(h.created).toHaveLength(1)
    expect(h.follows).toHaveLength(2)
  })

  it('超时中止后 agent 迟迟不收敛:兜底结束本轮等待,仍不销毁会话', async () => {
    const h = makeHarness({ promptTimeoutMs: 20, timeoutSettleMs: 30 })
    h.bridge.enqueue('user1', '卡死的任务', { touser: 'u1' })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.cancels).toEqual(['user'])
    expect(h.sends.some((s) => s.content.includes('超时'))).toBe(true)
    expect(h.disposed).toBe(false)
    h.bridge.enqueue('user1', '继续', { touser: 'u1' })
    await tick()
    expect(h.created).toHaveLength(1)
    expect(h.follows).toHaveLength(2)
  })

  it('长连接忙碌超过阈值:自动发"仍在处理"心跳,完成后心跳停止', async () => {
    const h = makeHarness({ heartbeatStartMs: 20, heartbeatIntervalMs: 30 })
    h.bridge.enqueue('u9', '长任务', { reqId: 'r1', streamId: 's1' })
    await tick()
    expect(h.follows).toHaveLength(1)
    // 等待多条心跳(20/50/80/110ms …)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const hearts = h.sends.filter((s) => s.content.includes('仍在处理'))
    expect(hearts.length).toBeGreaterThanOrEqual(2)
    expect(hearts[0]!.content).toContain('完成后我会把完整结论发你')
    expect(h.sends.some((s) => s.content.includes('会话标识'))).toBe(false) // 尚未结题

    // agent 完成 → 只回一条最终答复,心跳不再发
    h.emit('session/event', { id: 'wecom:u9' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '最终结论' }] } },
    })
    h.emit('agent/status', { agent: { session: { id: 'wecom:u9' } }, status: 'idle' })
    await tick()
    expect(h.sends.filter((s) => s.content.includes('最终结论')).length).toBe(1)
    const heartCount = h.sends.filter((s) => s.content.includes('仍在处理')).length
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(h.sends.filter((s) => s.content.includes('仍在处理')).length).toBe(heartCount)
    await h.bridge.dispose()
  })

  it('心跳只对带 reqId 的目标发送(回调推送不打扰)', async () => {
    const h = makeHarness({ heartbeatStartMs: 10, heartbeatIntervalMs: 20 })
    h.bridge.enqueue('uA', '回调任务', { touser: 'u1' })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.sends.filter((s) => s.content.includes('仍在处理'))).toHaveLength(0)
    await h.bridge.dispose()
  })

  it('创建失败:回复错误信息并释放队列', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const sends: { target: ReplyTarget; content: string }[] = []
    const agents: AgentsServiceLike = {
      async create() {
        throw new Error('no factory')
      },
      get() {
        return undefined
      },
    }
    const ctx = {
      agents,
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => undefined
      },
    }
    const wecom = {
      sendText: vi.fn(async (target: ReplyTarget, content: string) => { sends.push({ target, content }) }),
    } as unknown as ReplySender
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const bridge = new AgentBridge(ctx, makeConfig(), wecom, logger)
    bridge.enqueue('user1', 'x', { touser: 'u1' })
    await tick()
    expect(sends[0]?.content).toContain('无法启动 dsh 会话')
  })

  it('provider/model/maxTokens 透传', async () => {
    const h = makeHarness({ provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 4096 })
    h.bridge.enqueue('user1', 'x', { touser: 'u1' })
    await tick()
    expect(h.created[0]?.agentOptions).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxTokens: 4096,
    })
  })

  it('dispose 清理:不再响应事件', async () => {
    const h = makeHarness()
    h.bridge.enqueue('user1', 'x', { touser: 'u1' })
    await tick()
    await h.bridge.dispose()
    expect(h.disposed).toBe(true)
    h.emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()
    // 不再产生任何回复
    expect(h.sends).toHaveLength(0)
  })
})
describe('lastAssistantText error surfacing', () => {
  it('returns the turn error message alongside the error kind', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { message: 'prompt variable "{{model}}" has no value (section "deployment:persona")' },
          },
        },
      },
    ]
    const { text, reason, errorMessage } = lastAssistantText(events as never)
    expect(text).toBe('')
    expect(reason).toBe('error')
    expect(errorMessage).toContain('{{model}}')
  })

  it('keeps errorMessage undefined when the error carries no message', () => {
    const events = [{ type: 'turn/end', data: { reason: { kind: 'error' } } }]
    const { reason, errorMessage } = lastAssistantText(events as never)
    expect(reason).toBe('error')
    expect(errorMessage).toBeUndefined()
  })
})

  it('会话创建冲突:自动换新 sessionId 重试一次并正常回复', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const created: { sessionId: string }[] = []
    const follows: UserMessageLike[] = []
    const sends: { target: ReplyTarget; content: string }[] = []
    let liveAgent: AgentHandleLike | null = null
    let attempts = 0

    const agents: AgentsServiceLike = {
      async create(options) {
        attempts++
        if (attempts === 1) {
          throw new Error('session "wecom:user1" already has a persisted log on disk that does not match this live session (id collision)')
        }
        created.push({ sessionId: options.sessionId })
        const agent = { id: options.sessionId, session: { id: options.sessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = { agent, dispose: async () => { liveAgent = null } }
        return liveAgent
      },
      get(id) {
        return liveAgent && liveAgent.agent.id === id ? liveAgent.agent : undefined
      },
    }

    const ctx = {
      agents,
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {
          const arr = listeners.get(event) ?? []
          const at = arr.indexOf(handler)
          if (at >= 0) arr.splice(at, 1)
        }
      },
    }
    const wecom = { sendText: vi.fn(async (target: ReplyTarget, content: string) => { sends.push({ target, content }) }) } as unknown as ReplySender
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const bridge = new AgentBridge(ctx as never, makeConfig({}), wecom, logger)

    bridge.enqueue('user1', '你好', { touser: 'u1' })
    await tick()
    // 首次 create 失败重试:第二次用新 sessionId 成功
    expect(created).toHaveLength(1)
    expect(created[0]?.sessionId).not.toBe('wecom:user1')
    expect(created[0]?.sessionId).toMatch(/^wecom:user1#/)
    expect(follows[0]?.content[0]?.text).toBe('你好')

    // 后续事件按新 sessionId 流转,回复正常
    for (const handler of listeners.get('session/event') ?? []) {
      handler({ id: created[0]?.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '冲突后仍工作' }] } } })
    }
    for (const handler of listeners.get('agent/status') ?? []) {
      handler({ agent: { session: { id: created[0]?.sessionId } }, status: 'idle' })
    }
    await tick()
    expect(sends).toHaveLength(1)
    expect(bodyOf(sends[0]!.content)).toBe('冲突后仍工作')
    await bridge.dispose()
  })

  it('turn 期持久化冲突:销毁句柄按原 sessionId 重试同一轮并正常回复', async () => {
    const h = makeHarness()
    h.bridge.enqueue('user1', '重试我', { touser: 'u1' })
    await tick()
    expect(h.created).toHaveLength(1)
    expect(h.follows).toHaveLength(1)

    // 第一轮:turn 以持久化冲突错误结束
    h.emit('session/event', { id: 'wecom:user1' }, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'session "wecom:user1" already has a persisted log on disk that does not match this live session (id collision)' } } },
    })
    h.emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()

    // 自愈:销毁旧句柄,按原 sessionId 重走 create(宿主无 resume 时 create 重试成功),不向用户回错误
    expect(h.created).toHaveLength(2)
    expect(h.created[1]?.sessionId).toBe('wecom:user1')
    expect(h.follows).toHaveLength(2)
    expect(h.follows[1]?.content[0]?.text).toBe('重试我')
    expect(h.sends).toHaveLength(0)

    // 第二轮正常完成 → 正常回复
    h.emit('session/event', { id: h.created[1]?.sessionId }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '冲突自愈成功' }] } },
    })
    h.emit('agent/status', { agent: { session: { id: h.created[1]?.sessionId } }, status: 'idle' })
    await tick()
    expect(h.sends).toHaveLength(1)
    expect(bodyOf(h.sends[0]!.content)).toBe('冲突自愈成功')
  })

  it('创建冲突时优先 resume 续接原会话(保留记忆),不生成 # 新会话', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const created: { sessionId: string }[] = []
    const resumed: { resumeSessionId: string }[] = []
    const follows: UserMessageLike[] = []
    const sends: { target: ReplyTarget; content: string }[] = []
    let liveAgent: AgentHandleLike | null = null
    let attempts = 0

    const agents: AgentsServiceLike = {
      async create(options) {
        attempts++
        if (attempts === 1) {
          throw new Error('session "wecom:user1" already has a persisted log on disk that does not match this live session (id collision)')
        }
        created.push({ sessionId: options.sessionId })
        const agent = { id: options.sessionId, session: { id: options.sessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = { agent, dispose: async () => { liveAgent = null } }
        return liveAgent
      },
      async resume(options) {
        resumed.push({ resumeSessionId: options.resumeSessionId })
        const agent = { id: options.resumeSessionId, session: { id: options.resumeSessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = { agent, dispose: async () => { liveAgent = null } }
        return liveAgent
      },
      get(id) {
        return liveAgent && liveAgent.agent.id === id ? liveAgent.agent : undefined
      },
    }

    const sessionTitle = { rename: vi.fn(() => ({ title: 'x', eventSeq: 0 })) }
    const ctx = {
      agents,
      get: vi.fn((key: string) => key === 'sessionTitle' ? sessionTitle : undefined),
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {
          const arr = listeners.get(event) ?? []
          const at = arr.indexOf(handler)
          if (at >= 0) arr.splice(at, 1)
        }
      },
    }
    const wecom = { sendText: vi.fn(async (target: ReplyTarget, content: string) => { sends.push({ target, content }) }) } as unknown as ReplySender
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const bridge = new AgentBridge(ctx as never, makeConfig({}), wecom, logger)

    bridge.enqueue('user1', '你好', { touser: 'u1' })
    await tick()
    // 冲突后优先 resume 原 sessionId,不再生成 # 新会话
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.resumeSessionId).toBe('wecom:user1')
    expect(created).toHaveLength(0)
    expect(follows[0]?.content[0]?.text).toBe('你好')
    // 续接的会话同样以「企微 #<数字>」命名
    expect(sessionTitle.rename).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wecom:user1' }),
      '企微 #user1',
    )

    // 后续事件按原 sessionId 流转,回复正常
    for (const handler of listeners.get('session/event') ?? []) {
      handler({ id: 'wecom:user1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '续接成功' }] } } })
    }
    for (const handler of listeners.get('agent/status') ?? []) {
      handler({ agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    }
    await tick()
    expect(sends).toHaveLength(1)
    expect(bodyOf(sends[0]!.content)).toBe('续接成功')
    await bridge.dispose()
  })

  it('创建冲突且 resume 失败:兜底换新 sessionId 重试并正常回复', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const created: { sessionId: string }[] = []
    const follows: UserMessageLike[] = []
    const sends: { target: ReplyTarget; content: string }[] = []
    let liveAgent: AgentHandleLike | null = null
    let attempts = 0

    const agents: AgentsServiceLike = {
      async create(options) {
        attempts++
        if (attempts === 1) {
          throw new Error('session "wecom:user1" already has a persisted log on disk that does not match this live session (id collision)')
        }
        created.push({ sessionId: options.sessionId })
        const agent = { id: options.sessionId, session: { id: options.sessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = { agent, dispose: async () => { liveAgent = null } }
        return liveAgent
      },
      async resume() {
        throw new Error('session "wecom:user1" not found')
      },
      get(id) {
        return liveAgent && liveAgent.agent.id === id ? liveAgent.agent : undefined
      },
    }

    const ctx = {
      agents,
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {
          const arr = listeners.get(event) ?? []
          const at = arr.indexOf(handler)
          if (at >= 0) arr.splice(at, 1)
        }
      },
    }
    const wecom = { sendText: vi.fn(async (target: ReplyTarget, content: string) => { sends.push({ target, content }) }) } as unknown as ReplySender
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const bridge = new AgentBridge(ctx as never, makeConfig({}), wecom, logger)

    bridge.enqueue('user1', '你好', { touser: 'u1' })
    await tick()
    // resume 失败 → 兜底 # 新会话
    expect(created).toHaveLength(1)
    expect(created[0]?.sessionId).toMatch(/^wecom:user1#/)
    expect(follows[0]?.content[0]?.text).toBe('你好')

    for (const handler of listeners.get('session/event') ?? []) {
      handler({ id: created[0]?.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '兜底仍工作' }] } } })
    }
    for (const handler of listeners.get('agent/status') ?? []) {
      handler({ agent: { session: { id: created[0]?.sessionId } }, status: 'idle' })
    }
    await tick()
    expect(sends).toHaveLength(1)
    expect(bodyOf(sends[0]!.content)).toBe('兜底仍工作')
    await bridge.dispose()
  })

  it('turn 期持久化冲突只自愈一次:再次冲突按普通错误回复', async () => {
    const h = makeHarness()
    h.bridge.enqueue('user1', 'x', { touser: 'u1' })
    await tick()
    const collide = { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'session "wecom:user1" already has a persisted log on disk that does not match this live session (id collision)' } } } }
    const idle = (id: string) => ({ agent: { session: { id } }, status: 'idle' as const })

    // 第一轮冲突 → 自愈重试
    h.emit('session/event', { id: 'wecom:user1' }, collide)
    h.emit('agent/status', idle('wecom:user1'))
    await tick()
    expect(h.created).toHaveLength(2)
    expect(h.sends).toHaveLength(0)

    // 第二轮又冲突 → 不再重试,直接回复错误
    h.emit('session/event', { id: h.created[1]?.sessionId }, collide)
    h.emit('agent/status', idle(h.created[1]?.sessionId as string))
    await tick()
    expect(h.created).toHaveLength(2) // 没有第三次创建
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.content).toContain('id collision')
  })

  it('已有持久化日志的会话:首次消息直接 resume 续接,不 create、不撞冲突', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const created: { sessionId: string }[] = []
    const resumed: { resumeSessionId: string }[] = []
    const follows: UserMessageLike[] = []
    const sends: { target: ReplyTarget; content: string }[] = []
    let liveAgent: AgentHandleLike | null = null

    const agents: AgentsServiceLike = {
      async create(options) {
        created.push({ sessionId: options.sessionId })
        const agent = { id: options.sessionId, session: { id: options.sessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = { agent, dispose: async () => { liveAgent = null } }
        return liveAgent
      },
      async resume(options) {
        resumed.push({ resumeSessionId: options.resumeSessionId })
        const agent = { id: options.resumeSessionId, session: { id: options.resumeSessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = { agent, dispose: async () => { liveAgent = null } }
        return liveAgent
      },
      get(id) {
        return liveAgent && liveAgent.agent.id === id ? liveAgent.agent : undefined
      },
    }

    const sessionTitle = { rename: vi.fn(() => ({ title: 'x', eventSeq: 0 })) }
    const ctx = {
      agents,
      get: vi.fn((key: string) => key === 'sessionTitle' ? sessionTitle : undefined),
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {
          const arr = listeners.get(event) ?? []
          const at = arr.indexOf(handler)
          if (at >= 0) arr.splice(at, 1)
        }
      },
    }
    const wecom = { sendText: vi.fn(async (target: ReplyTarget, content: string) => { sends.push({ target, content }) }) } as unknown as ReplySender
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const bridge = new AgentBridge(ctx as never, makeConfig({}), wecom, logger)
    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    }

    // resume-first:有持久化日志的会话首轮就续接,create 一次都不该发生
    bridge.enqueue('user1', '续接我', { touser: 'u1' })
    await tick()
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.resumeSessionId).toBe('wecom:user1')
    expect(created).toHaveLength(0)
    expect(follows).toHaveLength(1)
    expect(follows[0]?.content[0]?.text).toBe('续接我')

    // 续接后的会话正常收敛 → 正常回复
    emit('session/event', { id: 'wecom:user1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '续接后正常工作' }] } },
    })
    emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()
    expect(sends).toHaveLength(1)
    expect(bodyOf(sends[0]!.content)).toBe('续接后正常工作')
    await bridge.dispose()
  })

  it('纯新会话:resume 探测失败一次后不再重复探测,直接 create', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const resumeCalls: string[] = []
    const created: { sessionId: string }[] = []
    const follows: UserMessageLike[] = []
    let liveAgent: AgentHandleLike | null = null

    const agents: AgentsServiceLike = {
      async create(options) {
        created.push({ sessionId: options.sessionId })
        const agent = { id: options.sessionId, session: { id: options.sessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = { agent, dispose: async () => { liveAgent = null } }
        return liveAgent
      },
      async resume(options) {
        resumeCalls.push(options.resumeSessionId)
        throw new Error(`session "${options.resumeSessionId}" has no persisted log on disk`)
      },
      get(id) {
        return liveAgent && liveAgent.agent.id === id ? liveAgent.agent : undefined
      },
    }
    const ctx = {
      agents,
      get: vi.fn(() => undefined),
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {}
      },
    }
    const wecom = { sendText: vi.fn(async () => {}) } as unknown as ReplySender
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const bridge = new AgentBridge(ctx as never, makeConfig({}), wecom, logger)
    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    }

    bridge.enqueue('user1', '第一句', { touser: 'u1' })
    await tick()
    expect(resumeCalls).toHaveLength(1) // 探测一次
    expect(created).toHaveLength(1) // 回落 create

    emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()
    // 同一状态第二轮:不再重复探测 resume,复用句柄
    bridge.enqueue('user1', '第二句', { touser: 'u1' })
    await tick()
    expect(resumeCalls).toHaveLength(1)
    expect(created).toHaveLength(1)
    expect(follows).toHaveLength(2)
    await bridge.dispose()
  })

  it('turn 期持久化冲突:先等句柄退休再 resume(不 await dispose 会撞 "while it is live")', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const resumedWhenDisposed: boolean[] = []
    const created: { sessionId: string }[] = []
    const follows: UserMessageLike[] = []
    const sends: { target: ReplyTarget; content: string }[] = []
    let liveAgent: AgentHandleLike | null = null
    let disposed = false

    const agents: AgentsServiceLike = {
      async create(options) {
        created.push({ sessionId: options.sessionId })
        const agent = { id: options.sessionId, session: { id: options.sessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = {
          agent,
          dispose: async () => {
            // 模拟宿主 retire 有一个 tick 的异步延迟
            await new Promise<void>((resolve) => setTimeout(resolve, 5))
            disposed = true
            liveAgent = null
          },
        }
        return liveAgent
      },
      async resume(options) {
        // 只有句柄真的退休了,宿主才允许 prepare
        if (!disposed) throw new Error(`cannot prepare session "${options.resumeSessionId}" while it is live`)
        resumedWhenDisposed.push(true)
        const agent = { id: options.resumeSessionId, session: { id: options.resumeSessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = { agent, dispose: async () => { liveAgent = null } }
        return liveAgent
      },
      get(id) {
        return liveAgent && liveAgent.agent.id === id ? liveAgent.agent : undefined
      },
    }
    const ctx = {
      agents,
      get: vi.fn(() => undefined),
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {}
      },
    }
    const wecom = { sendText: vi.fn(async (target: ReplyTarget, content: string) => { sends.push({ target, content }) }) } as unknown as ReplySender
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const bridge = new AgentBridge(ctx as never, makeConfig({}), wecom, logger)
    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    }

    bridge.enqueue('user1', '重试我', { touser: 'u1' })
    // 探测撞 "while it is live" 会重试 3 次(150ms 间隔)后才回落 create,给足时间
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(created).toHaveLength(1)

    // turn 期才抛的持久化冲突(懒初始化 flush 时)
    emit('session/event', { id: 'wecom:user1' }, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'session "wecom:user1" already has a persisted log on disk that does not match this live session (id collision)' } } },
    })
    emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 关键:resume 是在句柄退休之后才成功的(否则必然 "while it is live")
    expect(resumedWhenDisposed).toEqual([true])
    expect(created).toHaveLength(1) // 自愈没有再 create
    expect(follows).toHaveLength(2)
    expect(follows[1]?.content[0]?.text).toBe('重试我')
    expect(sends).toHaveLength(0)

    emit('session/event', { id: 'wecom:user1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '退休后续接成功' }] } },
    })
    emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()
    expect(sends).toHaveLength(1)
    expect(bodyOf(sends[0]!.content)).toBe('退休后续接成功')
    await bridge.dispose()
  })

  it('创建 agent 时挂载部署默认预设(code),setup 调用 presets.mount', async () => {
    const h = makeHarness()
    h.bridge.enqueue('user1', 'hello', { touser: 'u1' })
    await tick()
    expect(h.created).toHaveLength(1)
    expect(h.agentPresets.resolve).toHaveBeenCalledWith(undefined)
    const rec = h.created[0]!
    expect((rec.meta as { agentPreset?: string }).agentPreset).toBe('code')
    expect(typeof rec.setup).toBe('function')
    // 执行 setup → mount 被调用
    await (rec.setup as (ctx: unknown) => Promise<void>)({})
    expect(h.agentPresets.mount).toHaveBeenCalledWith({}, 'code')
  })

  it('冲突自愈重试的 agent 同样挂载预设', async () => {
    const h = makeHarness()
    h.bridge.enqueue('user1', 'x', { touser: 'u1' })
    await tick()
    h.emit('session/event', { id: 'wecom:user1' }, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'session "wecom:user1" already has a persisted log on disk that does not match this live session (id collision)' } } },
    })
    h.emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()
    expect(h.created).toHaveLength(2)
    for (const rec of h.created) {
      expect((rec.meta as { agentPreset?: string }).agentPreset).toBe('code')
      expect(typeof rec.setup).toBe('function')
    }
  })

  it('无 agentPresets 服务时退化为无预设创建', async () => {
    const h = makeHarness()
    ;(h as unknown as { ctx: { get: ReturnType<typeof vi.fn> } }).ctx.get.mockImplementation(() => undefined)
    h.bridge.enqueue('user1', 'x', { touser: 'u1' })
    await tick()
    expect(h.created).toHaveLength(1)
    const rec = h.created[0]!
    expect((rec.meta as { agentPreset?: string }).agentPreset).toBeUndefined()
    expect(rec.setup).toBeUndefined()
  })

  it('宿主已有同 id 活跃 agent:复用不重复创建,上下文延续', async () => {
    const liveFollows: UserMessageLike[] = []
    const preseed: AgentHandleLike = {
      agent: {
        id: 'wecom:user1',
        session: { id: 'wecom:user1' },
        followup(message) {
          liveFollows.push(message)
        },
      },
      dispose: async () => {},
    }
    const h = makeHarness({}, preseed)
    h.bridge.enqueue('user1', '你好', { touser: 'u1' })
    await tick()
    // 不重复创建:直接复用宿主活跃 agent
    expect(h.created).toHaveLength(0)
    expect(liveFollows).toHaveLength(1)
    expect(liveFollows[0]?.content[0]?.text).toBe('你好')
    // 复用宿主已有会话:不创建、不命名
    expect(h.sessionTitle.rename).not.toHaveBeenCalled()
    // 事件按原 sessionId 流转并正常回复
    h.emit('session/event', { id: 'wecom:user1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '沿用上下文回复' }] } },
    })
    h.emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()
    expect(h.sends).toHaveLength(1)
    expect(bodyOf(h.sends[0]!.content)).toBe('沿用上下文回复')
    await h.bridge.dispose()
  })

  it('创建冲突(活跃会话 already exists):换新 sessionId 重试并正常回复', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const created: { sessionId: string }[] = []
    const follows: UserMessageLike[] = []
    const sends: { target: ReplyTarget; content: string }[] = []
    let liveAgent: AgentHandleLike | null = null
    let attempts = 0

    const agents: AgentsServiceLike = {
      async create(options) {
        attempts++
        if (attempts === 1) {
          throw new Error('session "wecom:user1" already exists')
        }
        created.push({ sessionId: options.sessionId })
        const agent = { id: options.sessionId, session: { id: options.sessionId }, followup(m: UserMessageLike) { follows.push(m) } }
        liveAgent = { agent, dispose: async () => { liveAgent = null } }
        return liveAgent
      },
      get(id) {
        return liveAgent && liveAgent.agent.id === id ? liveAgent.agent : undefined
      },
    }

    const ctx = {
      agents,
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {
          const arr = listeners.get(event) ?? []
          const at = arr.indexOf(handler)
          if (at >= 0) arr.splice(at, 1)
        }
      },
    }
    const wecom = { sendText: vi.fn(async (target: ReplyTarget, content: string) => { sends.push({ target, content }) }) } as unknown as ReplySender
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const bridge = new AgentBridge(ctx as never, makeConfig({}), wecom, logger)

    bridge.enqueue('user1', '你好', { touser: 'u1' })
    await tick()
    // 首次 create 抛 "already exists" → 自愈换新 sessionId 重试
    expect(created).toHaveLength(1)
    expect(created[0]?.sessionId).toMatch(/^wecom:user1#/)
    expect(follows[0]?.content[0]?.text).toBe('你好')

    // 后续事件按新 sessionId 流转,回复正常
    for (const handler of listeners.get('session/event') ?? []) {
      handler({ id: created[0]?.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '冲突后仍工作' }] } } })
    }
    for (const handler of listeners.get('agent/status') ?? []) {
      handler({ agent: { session: { id: created[0]?.sessionId } }, status: 'idle' })
    }
    await tick()
    expect(sends).toHaveLength(1)
    expect(bodyOf(sends[0]!.content)).toBe('冲突后仍工作')
    await bridge.dispose()
  })
