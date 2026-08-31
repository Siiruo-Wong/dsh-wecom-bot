import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionCounter, splitSessionToken } from '../src/session-key.js'

const tmpDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-session-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('splitSessionToken', () => {
  it('不带标识:原样返回,无 token', () => {
    expect(splitSessionToken('你好,帮我查一下 QPS')).toEqual({ rest: '你好,帮我查一下 QPS' })
  })

  it('带 #数字:剥离标识并返回 token', () => {
    expect(splitSessionToken('#7 继续分析')).toEqual({ token: '7', rest: '继续分析' })
  })

  it('标识后无空格也可解析', () => {
    expect(splitSessionToken('#42继续')).toEqual({ token: '42', rest: '继续' })
  })

  it('容忍前导空白', () => {
    expect(splitSessionToken('  #100 查一下')).toEqual({ token: '100', rest: '查一下' })
  })

  it('不在开头/非纯数字/空数字不匹配', () => {
    expect(splitSessionToken('内容 #7 不在开头')).toEqual({ rest: '内容 #7 不在开头' })
    expect(splitSessionToken('#abc 不是数字')).toEqual({ rest: '#abc 不是数字' })
    expect(splitSessionToken('# 空数字')).toEqual({ rest: '# 空数字' })
  })

  it('旧格式 #s-<数字> 不再识别,按普通消息处理', () => {
    expect(splitSessionToken('#s-7 继续')).toEqual({ rest: '#s-7 继续' })
  })
})

describe('createSessionCounter', () => {
  it('从 1 开始递增', () => {
    const home = tempHome()
    const next = createSessionCounter(home)
    expect(next()).toBe('1')
    expect(next()).toBe('2')
    expect(next()).toBe('3')
  })

  it('持久化:新实例(模拟重启)接续递增,不归零', () => {
    const home = tempHome()
    const first = createSessionCounter(home)
    first()
    first()
    const second = createSessionCounter(home)
    expect(second()).toBe('3')
  })

  it('计数文件落在 <home>/wecom-bot/session-seq', () => {
    const home = tempHome()
    const next = createSessionCounter(home)
    next()
    next()
    expect(readFileSync(join(home, 'wecom-bot', 'session-seq'), 'utf8').trim()).toBe('2')
  })
})
