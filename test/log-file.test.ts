import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTeeLogger } from '../src/log-file.js'

const dirs: string[] = []
function tmpLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-log-'))
  dirs.push(dir)
  return join(dir, 'nested', 'wecom-bot.log')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('createTeeLogger', () => {
  it('原样转发宿主 + 落盘写入(自动建目录)', () => {
    const base = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const file = tmpLog()
    const logger = createTeeLogger(base, file)

    logger.info('[wecom-bot] 长连接已建立')
    logger.warn('[wecom-bot] 长连接回复失败', { errcode: 50000 })

    expect(base.info).toHaveBeenCalledWith('[wecom-bot] 长连接已建立')
    expect(base.warn).toHaveBeenCalledWith('[wecom-bot] 长连接回复失败', { errcode: 50000 })

    const content = readFileSync(file, 'utf8')
    expect(content).toContain('[info] [wecom-bot] 长连接已建立')
    expect(content).toContain('[warn] [wecom-bot] 长连接回复失败 {"errcode":50000}')
  })

  it('宿主 logger 抛错不阻断落盘', () => {
    const base = {
      info: vi.fn(() => {
        throw new Error('host logger down')
      }),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
    const file = tmpLog()
    const logger = createTeeLogger(base, file)

    expect(() => logger.info('x')).not.toThrow()
    expect(readFileSync(file, 'utf8')).toContain('[info] x')
  })
})
