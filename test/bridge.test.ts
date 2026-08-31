import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge, lastAssistantText, type AgentBridgeConfig } from '../src/agent-bridge.js'
import type { AgentHandleLike, AgentsServiceLike, ReplyTarget, UserMessageLike } from '../src/types.js'
import type { ReplySender } from '../src/types.js'

interface Harness {
  bridge: AgentBridge
  emit(event: string, ...args: unknown[]): void
  follows: UserMessageLike[]
  created: { sessionId: string; meta: unknown; agentOptions: unknown }[]
  sends: { target: ReplyTarget; content: string }[]
  disposed: boolean
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
}

function makeConfig(overrides: Partial<AgentBridgeConfig> = {}): AgentBridgeConfig {
  return {
    workspace: '/tmp/ws',
    maxQueueDepth: 2,
    promptTimeoutMs: 60_000,
    sessionIdPrefix: 'wecom',
    replyLimitBytes: 2000,
    ...overrides,
  }
}

function makeHarness(overrides: Partial<AgentBridgeConfig> = {}): Harness {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const follows: UserMessageLike[] = []
  const created: { sessionId: string; meta: unknown; agentOptions: unknown }[] = []
  const sends: { target: ReplyTarget; content: string }[] = []
  let liveAgent: AgentHandleLike | null = null
  let disposed = false

  const agents: AgentsServiceLike = {
    async create(options) {
      created.push({ sessionId: options.sessionId, meta: options.meta, agentOptions: options.agentOptions })
      const agent = {
        id: options.sessionId,
        session: { id: options.sessionId },
        followup(message: UserMessageLike) {
          follows.push(message)
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
    get disposed() {
      return disposed
    },
    logger,
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
    expect(h.created[0]?.meta).toEqual({ cwd: '/tmp/ws' })
    expect(h.follows[0]?.content[0]?.text).toBe('你好')

    h.emit('session/event', { id: 'wecom:user1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '收到!' }] } },
    })
    h.emit('agent/status', { agent: { session: { id: 'wecom:user1' } }, status: 'idle' })
    await tick()

    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.target).toEqual({ touser: 'u1' })
    expect(h.sends[0]?.content).toBe('收到!')
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

  it('超时:回复超时提示并销毁句柄,下一条消息重建', async () => {
    const h = makeHarness({ promptTimeoutMs: 20 })
    h.bridge.enqueue('user1', '慢任务', { touser: 'u1' })
    await tick()
    await tick()
    expect(h.follows).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.sends.some((s) => s.content.includes('超时'))).toBe(true)
    expect(h.disposed).toBe(true)
    // 下一条消息会重建会话
    h.bridge.enqueue('user1', '再来', { touser: 'u1' })
    await tick()
    await tick()
    expect(h.created).toHaveLength(2)
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
    expect(sends[0]?.content).toBe('冲突后仍工作')
    await bridge.dispose()
  })

  it('turn 期持久化冲突:换新 sessionId 重试同一轮并正常回复', async () => {
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

    // 自愈:销毁旧句柄,换新 sessionId 重试同一 prompt,且不向用户回错误
    expect(h.created).toHaveLength(2)
    expect(h.created[1]?.sessionId).not.toBe('wecom:user1')
    expect(h.created[1]?.sessionId).toMatch(/^wecom:user1#/)
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
    expect(h.sends[0]?.content).toBe('冲突自愈成功')
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
