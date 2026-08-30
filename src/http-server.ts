/**
 * 企业微信回调 HTTP 服务(独立端口,与 DSH Web UI 互不干扰)。
 *
 * - GET  /{path}   URL 验证:解密 echostr 回显;
 * - POST /{path}   接收消息:验签解密 -> 派发给 bridge -> 立即返回 200(企微 5s 超时约束);
 * - 请求体大小限制(bodyLimitBytes),超限 413;
 * - 签名/解密失败返回 400(企微会重试,但绝不进入 agent);
 * - 单请求异常只影响该请求,绝不导致进程退出(参照 dsh-host-webserver 的兜底模式)。
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extractXmlFields } from './xml.js'
import type { LoggerLike, ParsedCallback } from './types.js'

export interface CallbackServerOptions {
  host: string
  port: number
  path: string
  bodyLimitBytes: number
}

export interface CallbackServerDeps {
  /** 验签并解密一段密文(echostr 或 Encrypt),返回明文 XML;失败抛错 */
  decrypt(encrypt: string, params: URLSearchParams): string
  /** 派发解析后的消息(bridge 异步处理) */
  handleMessage(message: ParsedCallback): void
  logger: LoggerLike
}

function parseCallback(innerXml: string): ParsedCallback {
  const fields = extractXmlFields(innerXml)
  return {
    fromUser: fields.FromUserName ?? '',
    msgType: fields.MsgType ?? '',
    content: fields.Content,
    chatId: fields.ChatId,
    msgId: fields.MsgId,
    createTime: fields.CreateTime,
  }
}

export class CallbackServer {
  private server: Server | null = null

  constructor(
    private readonly options: CallbackServerOptions,
    private readonly deps: CallbackServerDeps,
  ) {}

  async start(): Promise<number> {
    const { deps } = this
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (error instanceof HttpStatusError) {
          if (!res.headersSent) {
            res.writeHead(error.status, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(error.message)
          } else {
            res.destroy()
          }
          return
        }
        deps.logger.warn('wecom-callback 请求处理失败', error)
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('internal error')
      })
    })
    this.server = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject)
        server.on('error', (error) => deps.logger.error('wecom-callback 服务器错误', error))
        resolve()
      })
    })
    return (server.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { options, deps } = this
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== options.path) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }

    if (req.method === 'GET') {
      // URL 验证:解密 echostr 并回显明文
      const echostr = url.searchParams.get('echostr')
      if (!echostr) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('missing echostr')
        return
      }
      const echo = deps.decrypt(echostr, url.searchParams)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(echo)
      return
    }

    if (req.method === 'POST') {
      const rawBody = await readBody(req, options.bodyLimitBytes)
      const fields = extractXmlFields(rawBody)
      const encrypt = fields.Encrypt
      if (!encrypt) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('missing Encrypt')
        return
      }
      const innerXml = deps.decrypt(encrypt, url.searchParams)
      const message = parseCallback(innerXml)
      if (!message.fromUser) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad message')
        return
      }
      // 先响应 200(企微 5 秒超时),再异步处理
      deps.handleMessage(message)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('success')
      return
    }

    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
  }
}

/** 读取请求体并强制大小上限;超限返回 null 并直接 413 */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limit) {
      throw new HttpStatusError(413, 'payload too large')
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpStatusError'
  }
}