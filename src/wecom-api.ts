/**
 * 企业微信 API 封装:access_token 单飞缓存、发送应用消息、失效自动刷新重试。
 *
 * 安全/健壮要点:
 * - access_token 用"单飞"模式缓存(并发只打一次 gettoken),提前 60s 过期刷新;
 * - 遇无效/过期 token 错误码(40001/40014/42001)强制刷新后重试一次;
 * - 所有请求带超时(AbortSignal.timeout),网络/5xx 失败抛可重试错误;
 * - 绝不记录 token / secret 内容。
 */
import type { ReplyTarget } from './types.js'

const QYAPI = 'https://qyapi.weixin.qq.com/cgi-bin'

/** token 无效/过期错误码:需刷新后重试 */
const TOKEN_INVALID_CODES = new Set([40001, 40014, 42001])

export class WecomApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'WecomApiError'
  }
}

export interface WecomApiOptions {
  corpId: string
  appSecret: string
  agentId: number
  timeoutMs: number
}

interface TokenCache {
  token: string
  expiresAt: number
}

export class WecomApi {
  private cache: TokenCache | null = null
  private inflight: Promise<string> | null = null

  constructor(private readonly options: WecomApiOptions) {}

  /** 启动自检:验证凭据可换取 access_token(不打印凭据) */
  async check(): Promise<void> {
    await this.getAccessToken(true)
  }

  private async fetchToken(): Promise<string> {
    const url = `${QYAPI}/gettoken?corpid=${encodeURIComponent(this.options.corpId)}&corpsecret=${encodeURIComponent(this.options.appSecret)}`
    const response = await fetch(url, { signal: AbortSignal.timeout(this.options.timeoutMs) })
    const data = await response.json() as {
      errcode?: number
      errmsg?: string
      access_token?: string
      expires_in?: number
    }
    if (data.errcode !== 0 || !data.access_token) {
      throw new WecomApiError(
        data.errcode ?? -1,
        `gettoken 失败: ${data.errmsg ?? '未知错误'}`,
        data.errcode === 40013 || data.errcode === 40092, // 凭据类错误不可重试
      )
    }
    const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 7200
    this.cache = { token: data.access_token, expiresAt: Date.now() + ttl * 1000 }
    return data.access_token
  }

  private async getAccessToken(force = false): Promise<string> {
    if (!force && this.cache && Date.now() < this.cache.expiresAt - 60_000) {
      return this.cache.token
    }
    if (this.inflight) return this.inflight
    this.inflight = this.fetchToken().finally(() => { this.inflight = null })
    return this.inflight
  }

  /** 发送文本应用消息;失败抛 WecomApiError */
  async sendText(target: ReplyTarget, content: string): Promise<void> {
    if (!target.chatid && !target.touser) throw new WecomApiError(-1, '缺少回复目标(chatid/touser)', false)
    const body = target.chatid
      ? { chatid: target.chatid, msgtype: 'text', text: { content } }
      : { touser: target.touser, msgtype: 'text', agentid: this.options.agentId, text: { content }, safe: 0 }

    const doSend = async (token: string): Promise<{ errcode?: number; errmsg?: string }> => {
      const response = await fetch(`${QYAPI}/message/send?access_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
      return await response.json() as { errcode?: number; errmsg?: string }
    }

    let data = await doSend(await this.getAccessToken())
    if (data.errcode !== undefined && TOKEN_INVALID_CODES.has(data.errcode)) {
      this.cache = null
      data = await doSend(await this.getAccessToken(true))
    }
    if (data.errcode !== undefined && data.errcode !== 0) {
      throw new WecomApiError(data.errcode, `message/send 失败: ${data.errmsg ?? '未知错误'}`, data.errcode === 45009)
    }
  }
}
