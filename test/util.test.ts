import { describe, expect, it } from 'vitest'
import { buildUserMessage, lastAssistantText, truncateUtf8 } from '../src/agent-bridge.js'

describe('truncateUtf8', () => {
  it('不超限时原样返回', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello')
  })

  it('按字节截断且不截断多字节字符', () => {
    // '你' 是 3 字节:10 字节内只能放 3 个"你"(9 字节)+ 1 个 ascii
    const out = truncateUtf8('你你你a', 10)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(10)
    expect(out.endsWith('a')).toBe(true)
  })

  it('emoji(4 字节)不被截断', () => {
    const out = truncateUtf8('a😀b', 5)
    // a(1) + 😀(4) = 5
    expect(out).toBe('a😀')
  })

  it('maxBytes <= 0 返回空串', () => {
    expect(truncateUtf8('x', 0)).toBe('')
  })
})

describe('lastAssistantText', () => {
  const assistant = (text: string) => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })

  it('取最后一条 assistant 文本', () => {
    const events = [assistant('第一段'), assistant('第二段')]
    expect(lastAssistantText(events).text).toBe('第二段')
  })

  it('提取 turn 结束原因', () => {
    const events = [
      assistant('部分输出'),
      { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } },
    ]
    const result = lastAssistantText(events)
    expect(result.text).toBe('部分输出')
    expect(result.reason).toBe('max-tokens')
  })

  it('无 assistant 事件返回空串', () => {
    expect(lastAssistantText([{ type: 'turn/end', data: { reason: { kind: 'error' } } }]).text).toBe('')
  })

  it('兼容 data 即 message 的形状', () => {
    const events = [{ type: 'assistant/message', data: { content: [{ type: 'text', text: '直接形状' }] } }]
    expect(lastAssistantText(events).text).toBe('直接形状')
  })
})

describe('buildUserMessage', () => {
  it('构造形状与 dsh UserMessage 一致', () => {
    const msg = buildUserMessage('任务')
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual([{ type: 'text', text: '任务' }])
    expect(msg.source).toEqual({ kind: 'user' })
    expect(typeof msg.id).toBe('string')
    expect(msg.id.length).toBeGreaterThan(0)
  })
})
