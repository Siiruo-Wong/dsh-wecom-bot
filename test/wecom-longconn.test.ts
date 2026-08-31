import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { WecomLongConn } from '../src/wecom-longconn.js'
import type { AgentBridge } from '../src/agent-bridge.js'
import type { LongConnClientLike, ReplyTarget } from '../src/types.js'

/** 桩 WS 客户端:记录连接状态与 replyStream 调用,可手动触发事件 */
class FakeClient {
  replies: Array<{ reqId: string; streamId: string; content: string; finish: boolean }> = []
  connected = false
  disconnected = false
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>()

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? []
    const at = list.indexOf(handler)
    if (at >= 0) list.splice(at, 1)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }

  connect(): void {
    this.connected = true
  }

  disconnect(): void {
    this.disconnected = true
  }

  replyStream(frame: { headers: { req_id: string } }, streamId: string, content: string, finish = false): Promise<unknown> {
    this.replies.push({ reqId: frame.headers.req_id, streamId, content, finish })
    return Promise.resolve()
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeBridge() {
  return { enqueue: vi.fn() } as unknown as AgentBridge
}

function makeHarness(overrides: Record<string, unknown> = {}) {
  const client = new FakeClient()
  const bridge = makeBridge()
  const logger = makeLogger()
  const cfg = resolveConfig({ botId: 'bot-1', botSecret: 'sec-1', ...overrides } as never)
  let seq = 0
  const nextSession = vi.fn(() => String(++seq))
  const adapter = new WecomLongConn(cfg, { bridge, logger, nextSession }, client as unknown as LongConnClientLike)
  return { client, bridge, logger, cfg, adapter, nextSession }
}

const textFrame = (reqId: string, body: Record<string, unknown>) => ({
  headers: { req_id: reqId },
  body,
})

describe('WecomLongConn', () => {
  it('start() 建立连接,收到文本消息交给 bridge 并先发思考占位', () => {
    const h = makeHarness()
    h.adapter.start()
    expect(h.client.connected).toBe(true)

    h.client.emit('message.text', textFrame('req-1', {
      chatid: 'chat-1',
      chattype: 'group',
      from: { userid: 'u1' },
      text: { content: '你好' },
    }))

    expect(h.bridge.enqueue).toHaveBeenCalledTimes(1)
    const [key, task, target] = h.bridge.enqueue.mock.calls[0] as [string, string, ReplyTarget]
    expect(key).toBe('1') // 不带标识 → 递增新会话号
    expect(task).toBe('你好')
    expect(target.reqId).toBe('req-1')
    expect(target.streamId).toBeTruthy()

    // 思考占位:同一 streamId,finish=false
    expect(h.client.replies).toHaveLength(1)
    expect(h.client.replies[0]).toMatchObject({ reqId: 'req-1', streamId: target.streamId, finish: false })
    expect(h.client.replies[0]!.content.length).toBeGreaterThan(0)
  })

  it('单聊(无 chatid)以 userid 为会话 key', () => {
    const h = makeHarness()
    h.adapter.start()
    h.client.emit('message.text', textFrame('req-2', {
      chattype: 'single',
      from: { userid: 'u9' },
      text: { content: 'hi' },
    }))
    const [key] = h.bridge.enqueue.mock.calls[0] as [string]
    expect(key).toBe('1')
  })

  it('带 #<数字>:续接该会话并剥离标识;不带标识:每条消息递增新会话', () => {
    const h = makeHarness()
    h.adapter.start()

    // 带标识 → key = 标识,任务文本去掉标识
    h.client.emit('message.text', textFrame('req-a', { chatid: 'chat-9', from: { userid: 'u2' }, text: { content: '#7 继续分析' } }))
    let [key, task] = h.bridge.enqueue.mock.calls[0] as [string, string]
    expect(key).toBe('7')
    expect(task).toBe('继续分析')

    // 不带标识 → 递增新会话号(与 chatid/userid 无关)
    h.client.emit('message.text', textFrame('req-b', { chatid: 'chat-9', from: { userid: 'u2' }, text: { content: '新问题' } }))
    ;[key, task] = h.bridge.enqueue.mock.calls[1] as [string, string]
    expect(key).toBe('1')
    expect(task).toBe('新问题')

    // 连续不带标识 → 每次都是新会话号
    h.client.emit('message.text', textFrame('req-c', { chatid: 'chat-9', from: { userid: 'u2' }, text: { content: '又一个' } }))
    const key3 = (h.bridge.enqueue.mock.calls[2] as [string])[0]
    expect(key3).toBe('2')
  })

  it('text 消息缺失内容/req_id 时忽略', () => {
    const h = makeHarness()
    h.adapter.start()
    h.client.emit('message.text', textFrame('req-3', { from: { userid: 'u1' }, text: { content: '' } }))
    h.client.emit('message.text', { headers: {}, body: { from: { userid: 'u1' }, text: { content: 'x' } } })
    expect(h.bridge.enqueue).not.toHaveBeenCalled()
  })

  it('sendText 最终回复:finish=true,超长按字节截断', () => {
    const h = makeHarness({ replyLimitBytes: 10 })
    h.adapter.start()
    h.client.emit('message.text', textFrame('req-4', { from: { userid: 'u1' }, text: { content: '问题' } }))
    const target = (h.bridge.enqueue.mock.calls[0] as [string, string, ReplyTarget])[2]
    void h.adapter.sendText(target, '你你你你你你你你你你你') // 10 字节内最多 3 个"你"

    return Promise.resolve().then(() => {
      const final = h.client.replies.at(-1)!
      expect(final.finish).toBe(true)
      expect(final.reqId).toBe('req-4')
      expect(final.streamId).toBe(target.streamId)
      expect(Buffer.byteLength(final.content, 'utf8')).toBeLessThanOrEqual(10)
    })
  })

  it('sendText 缺 reqId 时静默跳过', async () => {
    const h = makeHarness()
    await h.adapter.sendText({ touser: 'u1' }, 'x')
    expect(h.client.replies).toHaveLength(0)
  })

  it('非文本消息:ignoreNonText=false 时回复提示', () => {
    const h = makeHarness({ ignoreNonText: false })
    h.adapter.start()
    h.client.emit('message.image', textFrame('req-5', { from: { userid: 'u1' }, image: { url: 'x' } }))
    expect(h.client.replies.some((r) => r.finish === true && r.content.includes('仅支持文本'))).toBe(true)
    expect(h.bridge.enqueue).not.toHaveBeenCalled()
  })

  it('非文本消息:ignoreNonText=true(默认)时静默', () => {
    const h = makeHarness()
    h.adapter.start()
    h.client.emit('message.image', textFrame('req-6', { from: { userid: 'u1' }, image: { url: 'x' } }))
    expect(h.client.replies).toHaveLength(0)
  })

  it('thinkingHint 为空字符串时不发占位', () => {
    const h = makeHarness({ thinkingHint: '' })
    h.adapter.start()
    h.client.emit('message.text', textFrame('req-7', { from: { userid: 'u1' }, text: { content: 'x' } }))
    expect(h.client.replies).toHaveLength(0)
    expect(h.bridge.enqueue).toHaveBeenCalledTimes(1)
  })

  it('updateCfg 热更新 taskPrefix:后续消息拼新提示词,连接不重建', () => {
    const h = makeHarness({ taskPrefix: '旧提示词' })
    h.adapter.start()
    const clientBefore = h.client

    h.adapter.updateCfg(resolveConfig({ botId: 'bot-1', botSecret: 'sec-1', taskPrefix: '新提示词' } as never))
    h.client.emit('message.text', textFrame('req-8', { from: { userid: 'u1' }, text: { content: '你好' } }))

    const task = (h.bridge.enqueue.mock.calls[0] as [string, string])[1]
    expect(task).toBe('新提示词\n你好')
    // 仅换配置引用:不重建连接/不重连
    expect(h.client).toBe(clientBefore)
    expect(h.client.connected).toBe(true)
  })

  it('连接状态事件走日志', () => {
    const h = makeHarness()
    h.adapter.start()
    h.client.emit('authenticated')
    h.client.emit('disconnected', '网络波动')
    expect(h.logger.info).toHaveBeenCalled()
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('断开'))
  })

  it('dispose() 断开连接并清理监听', () => {
    const h = makeHarness()
    h.adapter.start()
    const count = () =>
      [...h.client['handlers'].values()].reduce((n: number, arr: unknown[]) => n + arr.length, 0)
    const before = count()
    void h.adapter.dispose()
    return Promise.resolve().then(() => {
      expect(h.client.disconnected).toBe(true)
      expect(count()).toBe(0)
      expect(before).toBeGreaterThan(0)
    })
  })
})