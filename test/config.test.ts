import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, resolveConfig, validateAesKey } from '../src/config.js'

const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'

const CALLBACK_REQUIRED = {
  mode: 'callback' as const,
  corpId: 'ww123',
  appSecret: 'sec',
  agentId: 1000002,
  token: 'tok',
  aesKey: KEY,
}

const LONG_REQUIRED = {
  mode: 'longconn' as const,
  botId: 'bot-1',
  botSecret: 'bot-secret-1',
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveConfig', () => {
  it('默认模式为 longconn,凭据齐全时返回默认值', () => {
    const cfg = resolveConfig({ botId: 'b1', botSecret: 's1' })
    expect(cfg.mode).toBe('longconn')
    expect(cfg.wsUrl).toBe('wss://openws.work.weixin.qq.com')
    expect(cfg.heartbeatIntervalMs).toBe(30_000)
    expect(cfg.reconnectBaseDelayMs).toBe(1_000)
    expect(cfg.maxReconnectAttempts).toBe(10)
    expect(cfg.maxAuthFailureAttempts).toBe(5)
    expect(cfg.requestTimeoutMs).toBe(10_000)
    expect(cfg.thinkingHint.length).toBeGreaterThan(0)
    expect(cfg.replyLimitBytes).toBe(2000)
    expect(cfg.maxQueueDepth).toBe(5)
    expect(cfg.workspace).toBe(process.cwd())
  })

  it('longconn 缺 botId/botSecret 抛 ConfigError', () => {
    expect(() => resolveConfig({ botId: '', botSecret: 's1' })).toThrow(ConfigError)
    expect(() => resolveConfig({ botId: 'b1', botSecret: '' })).toThrow(ConfigError)
  })

  it('longconn wsUrl 非法抛 ConfigError', () => {
    expect(() => resolveConfig({ ...LONG_REQUIRED, wsUrl: 'http://x' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...LONG_REQUIRED, wsUrl: 'wss://ok.weixin.qq.com' })).not.toThrow()
  })

  it('longconn 重连参数校验:非正整数或非 -1 抛错,-1 合法', () => {
    expect(() => resolveConfig({ ...LONG_REQUIRED, maxReconnectAttempts: 0 })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...LONG_REQUIRED, maxAuthFailureAttempts: -2 })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...LONG_REQUIRED, maxReconnectAttempts: -1 })).not.toThrow()
    expect(() => resolveConfig({ ...LONG_REQUIRED, heartbeatIntervalMs: 0 })).toThrow(ConfigError)
  })

  it('callback 模式缺必填项抛 ConfigError', () => {
    expect(() => resolveConfig({ ...CALLBACK_REQUIRED, corpId: '' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...CALLBACK_REQUIRED, appSecret: '' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...CALLBACK_REQUIRED, token: '' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...CALLBACK_REQUIRED, aesKey: '' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...CALLBACK_REQUIRED, agentId: 0 })).toThrow(ConfigError)
  })

  it('callback 模式不要求 botId;longconn 模式不要求企微应用凭据', () => {
    expect(() => resolveConfig(CALLBACK_REQUIRED)).not.toThrow()
    expect(() => resolveConfig(LONG_REQUIRED)).not.toThrow()
  })

  it('both 模式需要两套凭据', () => {
    expect(() => resolveConfig({ ...CALLBACK_REQUIRED, ...LONG_REQUIRED, mode: 'both' })).not.toThrow()
    expect(() => resolveConfig({ ...CALLBACK_REQUIRED, mode: 'both' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...LONG_REQUIRED, mode: 'both' })).toThrow(ConfigError)
  })

  it('非法 mode 抛 ConfigError', () => {
    expect(() => resolveConfig({ ...LONG_REQUIRED, mode: 'http' as never })).toThrow(ConfigError)
  })

  it('callback 模式非法 aesKey 抛 ConfigError', () => {
    expect(() => resolveConfig({ ...CALLBACK_REQUIRED, aesKey: 'short' })).toThrow(ConfigError)
  })

  it('validateAesKey 独立校验', () => {
    expect(() => validateAesKey(KEY)).not.toThrow()
    expect(() => validateAesKey('!' + KEY.slice(1))).toThrow() // 含非法 base64 字符
    expect(() => validateAesKey(KEY.slice(0, 42))).toThrow()
  })

  it('host/port/path 非法抛 ConfigError(通用校验,两模式皆然)', () => {
    expect(() => resolveConfig({ ...LONG_REQUIRED, host: '0.0.0.1' as never })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...LONG_REQUIRED, port: 0 })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...LONG_REQUIRED, port: 70000 })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...LONG_REQUIRED, path: 'callback' })).toThrow(ConfigError)
  })

  it('环境变量覆盖默认值', () => {
    vi.stubEnv('WECOM_BOT_PORT', '9090')
    vi.stubEnv('WECOM_BOT_HOST', '0.0.0.0')
    vi.stubEnv('WECOM_BOT_WS_URL', 'wss://custom.example.com')
    const cfg = resolveConfig({ botId: 'b1', botSecret: 's1' })
    expect(cfg.port).toBe(9090)
    expect(cfg.host).toBe('0.0.0.0')
    expect(cfg.wsUrl).toBe('wss://custom.example.com')
  })

  it('plugin config 优先于环境变量', () => {
    vi.stubEnv('WECOM_BOT_PORT', '9090')
    const cfg = resolveConfig({ ...LONG_REQUIRED, port: 1234 })
    expect(cfg.port).toBe(1234)
  })

  it('workspace 相对路径解析为绝对路径', () => {
    const cfg = resolveConfig({ ...LONG_REQUIRED, workspace: './sub' })
    expect(cfg.workspace.endsWith('/sub')).toBe(true)
  })
})
