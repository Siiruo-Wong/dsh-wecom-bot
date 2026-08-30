import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, resolveConfig, validateAesKey } from '../src/config.js'

const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'

const REQUIRED = {
  corpId: 'ww123',
  appSecret: 'sec',
  agentId: 1000002,
  token: 'tok',
  aesKey: KEY,
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveConfig', () => {
  it('必填齐全时返回默认值', () => {
    const cfg = resolveConfig({ ...REQUIRED })
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.port).toBe(8787)
    expect(cfg.path).toBe('/wecom/callback')
    expect(cfg.replyLimitBytes).toBe(2000)
    expect(cfg.maxQueueDepth).toBe(5)
    expect(cfg.workspace).toBe(process.cwd())
  })

  it('缺必填项抛 ConfigError', () => {
    expect(() => resolveConfig({ ...REQUIRED, corpId: '' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...REQUIRED, appSecret: '' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...REQUIRED, token: '' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...REQUIRED, aesKey: '' })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...REQUIRED, agentId: 0 })).toThrow(ConfigError)
  })

  it('非法 aesKey 抛 ConfigError', () => {
    expect(() => resolveConfig({ ...REQUIRED, aesKey: 'short' })).toThrow(ConfigError)
  })

  it('validateAesKey 独立校验', () => {
    expect(() => validateAesKey(KEY)).not.toThrow()
    expect(() => validateAesKey('!' + KEY.slice(1))).toThrow() // 含非法 base64 字符
    expect(() => validateAesKey(KEY.slice(0, 42))).toThrow()
  })

  it('host/port/path 非法抛 ConfigError', () => {
    expect(() => resolveConfig({ ...REQUIRED, host: '0.0.0.1' as never })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...REQUIRED, port: 0 })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...REQUIRED, port: 70000 })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...REQUIRED, path: 'callback' })).toThrow(ConfigError)
  })

  it('环境变量覆盖默认值', () => {
    vi.stubEnv('WECOM_BOT_PORT', '9090')
    vi.stubEnv('WECOM_BOT_HOST', '0.0.0.0')
    const cfg = resolveConfig({ ...REQUIRED })
    expect(cfg.port).toBe(9090)
    expect(cfg.host).toBe('0.0.0.0')
  })

  it('plugin config 优先于环境变量', () => {
    vi.stubEnv('WECOM_BOT_PORT', '9090')
    const cfg = resolveConfig({ ...REQUIRED, port: 1234 })
    expect(cfg.port).toBe(1234)
  })

  it('workspace 相对路径解析为绝对路径', () => {
    const cfg = resolveConfig({ ...REQUIRED, workspace: './sub' })
    expect(cfg.workspace.endsWith('/sub')).toBe(true)
  })
})