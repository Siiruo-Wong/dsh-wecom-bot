import { afterEach, describe, expect, it, vi } from 'vitest'
import { WecomApi, WecomApiError } from '../src/wecom-api.js'

const OPTIONS = { corpId: 'ww1', appSecret: 'sec', agentId: 1000002, timeoutMs: 1000 }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WecomApi', () => {
  it('check():凭据有效时成功', async () => {
    stubFetch(async () => jsonResponse({ errcode: 0, access_token: 'tok-1', expires_in: 7200 }))
    const api = new WecomApi(OPTIONS)
    await expect(api.check()).resolves.toBeUndefined()
  })

  it('check():凭据错误抛 WecomApiError', async () => {
    stubFetch(async () => jsonResponse({ errcode: 40013, errmsg: 'invalid corpid' }))
    const api = new WecomApi(OPTIONS)
    await expect(api.check()).rejects.toMatchObject({ name: 'WecomApiError', code: 40013 })
  })

  it('sendText 私聊:携带 touser/agentid/文本', async () => {
    const calls: { url: string; body?: string }[] = []
    stubFetch(async (url, init) => {
      calls.push({ url, body: init?.body as string })
      return jsonResponse(url.includes('/gettoken')
        ? { errcode: 0, access_token: 'tok', expires_in: 7200 }
        : { errcode: 0 })
    })
    const api = new WecomApi(OPTIONS)
    await api.sendText({ touser: 'u1' }, '你好')
    expect(calls).toHaveLength(2) // gettoken + send
    const send = calls[1]!
    expect(send.url).toContain('/message/send')
    const body = JSON.parse(send.body ?? '{}')
    expect(body.touser).toBe('u1')
    expect(body.agentid).toBe(1000002)
    expect(body.text.content).toBe('你好')
  })

  it('sendText 群聊:使用 chatid 且不带 agentid', async () => {
    const calls: { body?: string }[] = []
    stubFetch(async (url, init) => {
      calls.push({ body: init?.body as string })
      return jsonResponse(url.includes('/gettoken')
        ? { errcode: 0, access_token: 'tok', expires_in: 7200 }
        : { errcode: 0 })
    })
    const api = new WecomApi(OPTIONS)
    await api.sendText({ chatid: 'wr_chat' }, '群回复')
    const send = calls[1]!
    const body = JSON.parse(send.body ?? '{}')
    expect(body.chatid).toBe('wr_chat')
    expect(body.agentid).toBeUndefined()
  })

  it('token 失效:自动刷新并重试一次后成功', async () => {
    let tokenCalls = 0
    let sendCalls = 0
    stubFetch(async (url) => {
      if (url.includes('/gettoken')) {
        tokenCalls += 1
        return jsonResponse({ errcode: 0, access_token: `tok-${tokenCalls}`, expires_in: 7200 })
      }
      sendCalls += 1
      return jsonResponse(sendCalls === 1 ? { errcode: 40014, errmsg: 'invalid token' } : { errcode: 0 })
    })
    const api = new WecomApi(OPTIONS)
    await api.sendText({ touser: 'u1' }, 'hi')
    expect(tokenCalls).toBe(2) // 首次 + 刷新
    expect(sendCalls).toBe(2)
  })

  it('业务错误抛 WecomApiError 且不重试', async () => {
    stubFetch(async (url) => {
      if (url.includes('/gettoken')) return jsonResponse({ errcode: 0, access_token: 'tok', expires_in: 7200 })
      return jsonResponse({ errcode: 60020, errmsg: 'not allow to access from your ip' })
    })
    const api = new WecomApi(OPTIONS)
    await expect(api.sendText({ touser: 'u1' }, 'hi')).rejects.toMatchObject({ name: 'WecomApiError', code: 60020 })
  })

  it('缺少回复目标直接报错', async () => {
    stubFetch(async () => jsonResponse({ errcode: 0 }))
    const api = new WecomApi(OPTIONS)
    await expect(api.sendText({}, 'hi')).rejects.toThrow(WecomApiError)
  })

  it('access_token 缓存:多次发送只取一次 token', async () => {
    let tokenCalls = 0
    stubFetch(async (url) => {
      if (url.includes('/gettoken')) {
        tokenCalls += 1
        return jsonResponse({ errcode: 0, access_token: 'tok', expires_in: 7200 })
      }
      return jsonResponse({ errcode: 0 })
    })
    const api = new WecomApi(OPTIONS)
    await api.sendText({ touser: 'u1' }, 'a')
    await api.sendText({ touser: 'u1' }, 'b')
    expect(tokenCalls).toBe(1)
  })
})